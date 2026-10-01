import crypto from "crypto";
import bcrypt from "bcryptjs";
import db from "../config/db.js";
import { getUsdToNgnRate } from "./exchangeRateService.js";
import paystackService from "./paystackService.js";
import paymentService from "./paymentService.js";
import withdrawalService from "./withdrawalService.js";
import { dispatchPartnerWebhook } from "./webhookDispatcherService.js";
import { TRANSACTION_STATUS } from "../core/transactionStatus.js";
import { canTransition } from "../core/transactionStateMachine.js";
import { fundEscrow, releaseEscrow, refundEscrow } from "./walletService.js";
import { logTransactionEvent } from "./transactionEventService.js";
import { updateTransactionStatus } from "./transactionService.js";
import { runDisputeAnalysis } from "./disputeAnalysisService.js";
import { resolveDispute } from "./disputeService.js";
import { generateAiScope, runAiAudit, getTransactionAudits } from "./aiService.js";

const DEFAULT_ESCROW_FEE_RATE = 0.035; // 3.5% Lumbrr Escrow Commission

/**
 * Finds existing user by email or automatically provisions a shadow user account for API deals.
 */
async function findOrCreateApiUser(email, name = null, role = "client") {
  const cleanEmail = email.trim().toLowerCase();
  const rows = await db.query("SELECT id, name, email, role FROM users WHERE email = ?", [cleanEmail]);

  if (rows && rows.length > 0) {
    return rows[0];
  }

  // Provision shadow account for buyer/seller
  const randomPass = crypto.randomBytes(16).toString("hex");
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(randomPass, salt);
  const displayName = name || cleanEmail.split("@")[0];
  const userRole = role === "vendor" || role === "seller" ? "provider" : (role || "client");

  const result = await db.query(
    `INSERT INTO users (name, email, password_hash, role, is_verified, kyc_tier)
     VALUES (?, ?, ?, ?, 1, 2)`,
    [displayName, cleanEmail, passwordHash, userRole]
  );

  // Auto create wallet for user
  await db.query(
    "INSERT INTO wallets (user_id, balance, currency) VALUES (?, 0.00, 'USD')",
    [result.insertId]
  ).catch(() => {});

  return {
    id: result.insertId,
    name: displayName,
    email: cleanEmail,
    role: userRole,
  };
}

/**
 * Helper to fetch a transaction and verify API key authorization.
 */
async function getAuthorizedTransaction(apiKeyDetails, transactionId, conn = null) {
  const runner = conn || db.getPool();
  const [rows] = await runner.query(
    `SELECT t.*, 
            b.name as buyer_name, b.email as buyer_email,
            s.name as seller_name, s.email as seller_email
     FROM transactions t
     JOIN users b ON b.id = t.buyer_id
     JOIN users s ON s.id = t.seller_id
     WHERE (t.id = ? OR t.txn_code = ?)`,
    [transactionId, transactionId]
  );

  if (!rows || rows.length === 0) {
    throw new Error(`Escrow transaction with ID/Code "${transactionId}" not found.`);
  }

  const tx = rows[0];
  let scope = {};
  if (tx.scope_json) {
    try {
      scope = typeof tx.scope_json === "string" ? JSON.parse(tx.scope_json) : tx.scope_json;
    } catch (e) {}
  }

  const isAuthorized =
    String(scope.api_key_id) === String(apiKeyDetails.keyId) ||
    String(scope.metadata?.api_key_id) === String(apiKeyDetails.keyId) ||
    Number(tx.buyer_id) === Number(apiKeyDetails.owner.id) ||
    Number(tx.seller_id) === Number(apiKeyDetails.owner.id) ||
    apiKeyDetails.owner.role === "admin";

  if (!isAuthorized) {
    throw new Error(`Unauthorized access to escrow transaction with ID/Code "${transactionId}".`);
  }

  return tx;
}

/**
 * 1. Create a B2B Escrow transaction via API.
 */
export async function createB2BEscrow(apiKeyDetails, payload) {
  const {
    title,
    description = "",
    category = "general",
    amount,
    currency = "USD",
    buyerEmail,
    buyerName,
    sellerEmail,
    sellerName,
    milestones = [],
    scope = {},
    deliverables = [],
    inspectionPeriodDays = 3,
    partnerPlatformFee = 0,
    metadata = {},
    redirectUrl = null,
  } = payload;

  if (!title) throw new Error("Transaction 'title' is required.");
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    throw new Error("Valid 'amount' greater than 0 is required.");
  }
  if (!buyerEmail || !sellerEmail) {
    throw new Error("'buyerEmail' and 'sellerEmail' are required.");
  }
  if (buyerEmail.trim().toLowerCase() === sellerEmail.trim().toLowerCase()) {
    throw new Error("'buyerEmail' and 'sellerEmail' cannot be the same.");
  }

  const parsedAmount = parseFloat(amount);
  const normalizedCurrency = (currency || "USD").toUpperCase();

  // Find or provision participants
  const buyer = await findOrCreateApiUser(buyerEmail, buyerName, "client");
  const seller = await findOrCreateApiUser(sellerEmail, sellerName, "provider");

  // Calculate fees
  const escrowFeeRate = DEFAULT_ESCROW_FEE_RATE;
  const escrowFeeAmount = Number((parsedAmount * escrowFeeRate).toFixed(2));
  const parsedPartnerFee = Number(parseFloat(partnerPlatformFee || 0).toFixed(2));
  const totalBuyerPays = Number((parsedAmount + escrowFeeAmount + parsedPartnerFee).toFixed(2));

  const contractTerms = `B2B Escrow Agreement initiated via Lumbrr API (${apiKeyDetails.name}). Inspection period: ${inspectionPeriodDays} days.`;

  const metaObj = {
    source: "api_v1",
    api_key_id: apiKeyDetails.keyId,
    api_key_name: apiKeyDetails.name,
    partner_platform_fee: parsedPartnerFee,
    partner_metadata: metadata,
    redirect_url: redirectUrl,
    description,
    deliverables: Array.isArray(deliverables) ? deliverables : (scope.deliverables || []),
    requirements: scope.requirements || "",
    acceptanceCriteria: scope.acceptanceCriteria || "",
    contractTerms,
    environment: apiKeyDetails.environment,
  };

  const txnCode = `TXN-API-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  const cleanCategory = category || "general";
  const milestonesCount = Array.isArray(milestones) && milestones.length > 0 ? milestones.length : 1;

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [txResult] = await conn.query(
      `INSERT INTO transactions 
       (txn_code, buyer_id, seller_id, title, category, amount, currency, status, review_days, milestones_count, escrow_fee_rate, escrow_fee_amount, escrow_balance, released_amount, scope_json, revision_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0.00, 0.00, ?, '2 revisions included per milestone')`,
      [
        txnCode,
        buyer.id,
        seller.id,
        title,
        cleanCategory,
        parsedAmount,
        normalizedCurrency,
        inspectionPeriodDays,
        milestonesCount,
        escrowFeeRate,
        escrowFeeAmount,
        JSON.stringify(metaObj),
      ]
    );

    const transactionId = txResult.insertId;

    // Create milestones
    let milestoneList = [];
    if (Array.isArray(milestones) && milestones.length > 0) {
      for (let i = 0; i < milestones.length; i++) {
        const m = milestones[i];
        const mAmount = parseFloat(m.amount || parsedAmount / milestones.length);
        const [mRes] = await conn.query(
          `INSERT INTO milestones (transaction_id, title, description, amount, status, is_funded, created_at)
           VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
          [transactionId, m.title || `Milestone ${i + 1}`, m.description || "", mAmount]
        );
        milestoneList.push({
          id: mRes.insertId,
          title: m.title || `Milestone ${i + 1}`,
          description: m.description || "",
          amount: mAmount,
          status: "pending",
          isFunded: false,
        });
      }
    } else {
      // Single milestone deal
      const [mRes] = await conn.query(
        `INSERT INTO milestones (transaction_id, title, description, amount, status, is_funded, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
        [transactionId, title, description, parsedAmount]
      );
      milestoneList.push({
        id: mRes.insertId,
        title,
        description,
        amount: parsedAmount,
        status: "pending",
        isFunded: false,
      });
    }

    // Log transaction creation event
    await logTransactionEvent({
      conn,
      transactionId,
      userId: buyer.id,
      action: "transaction_created",
      fromStatus: null,
      toStatus: "pending",
      note: `API Escrow deal created by ${apiKeyDetails.name}`,
      metadata: { apiKeyId: apiKeyDetails.keyId, txnCode, totalBuyerPays },
    });

    await conn.commit();

    // Generate Paystack deposit payment session
    const depositReference = `API-ESC-${transactionId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    let paymentUrl = null;

    try {
      let chargeAmountNgn = totalBuyerPays;
      let chargeAmountKobo = Math.round(totalBuyerPays * 100);

      if (normalizedCurrency === "USD") {
        const fxRate = await getUsdToNgnRate();
        chargeAmountNgn = totalBuyerPays * fxRate;
        chargeAmountKobo = Math.round(chargeAmountNgn * 100);
      }

      const paystackRes = await paystackService.initializePayment({
        email: buyer.email,
        amountKobo: chargeAmountKobo,
        reference: depositReference,
        metadata: {
          transaction_id: transactionId,
          purpose: "escrow_deposit",
          source: "api_v1",
          api_key_id: apiKeyDetails.keyId,
        },
      });

      if (paystackRes && paystackRes.authorization_url) {
        paymentUrl = paystackRes.authorization_url;
      }
    } catch (payErr) {
      console.warn("[b2bEscrowService] Paystack initialization note:", payErr.message);
    }

    const responseData = {
      id: transactionId,
      txnCode,
      reference: depositReference,
      title,
      description,
      category: cleanCategory,
      amount: parsedAmount,
      currency: normalizedCurrency,
      status: "pending",
      escrowFeeRate: `${(escrowFeeRate * 100).toFixed(1)}%`,
      escrowFeeAmount,
      partnerPlatformFee: parsedPartnerFee,
      totalBuyerPays,
      paymentUrl,
      buyer: { id: buyer.id, name: buyer.name, email: buyer.email },
      seller: { id: seller.id, name: seller.name, email: seller.email },
      milestones: milestoneList,
      scope: {
        deliverables: metaObj.deliverables,
        requirements: metaObj.requirements,
        acceptanceCriteria: metaObj.acceptanceCriteria,
      },
      environment: apiKeyDetails.environment,
      createdAt: new Date(),
    };

    // Dispatch webhook: escrow.created
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "escrow.created",
      transactionId,
      data: responseData,
    }).catch(() => {});

    return responseData;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * 2. Retrieve escrow details by ID or Txn Code.
 */
export async function getB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  let scope = {};
  if (tx.scope_json) {
    try {
      scope = typeof tx.scope_json === "string" ? JSON.parse(tx.scope_json) : tx.scope_json;
    } catch (e) {}
  }

  const milestones = await db.query(
    "SELECT id, title, description, amount, status, is_funded, deliverable_note, created_at, updated_at FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
    [tx.id]
  );

  const disputes = await db.query(
    "SELECT id, filed_by, reason, evidence, status, resolution, created_at FROM disputes WHERE transaction_id = ? ORDER BY id DESC LIMIT 1",
    [tx.id]
  );

  const reviews = await db.query(
    "SELECT id, reviewer_id, rating, comment, created_at FROM reviews WHERE transaction_id = ?",
    [tx.id]
  );

  return {
    id: tx.id,
    txnCode: tx.txn_code,
    title: tx.title,
    category: tx.category,
    description: scope.description || "",
    amount: parseFloat(tx.amount),
    currency: tx.currency,
    status: tx.status,
    escrowFeeRate: `${(parseFloat(tx.escrow_fee_rate || 0.035) * 100).toFixed(1)}%`,
    escrowFeeAmount: parseFloat(tx.escrow_fee_amount || 0),
    escrowBalance: parseFloat(tx.escrow_balance || 0),
    releasedAmount: parseFloat(tx.released_amount || 0),
    buyer: { id: tx.buyer_id, name: tx.buyer_name, email: tx.buyer_email },
    seller: { id: tx.seller_id, name: tx.seller_name, email: tx.seller_email },
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      amount: parseFloat(m.amount),
      status: m.status,
      isFunded: !!m.is_funded,
      deliverableNote: m.deliverable_note || null,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })),
    scope: {
      deliverables: scope.deliverables || [],
      requirements: scope.requirements || "",
      acceptanceCriteria: scope.acceptanceCriteria || "",
      revisionPolicy: tx.revision_policy || "",
      contractTerms: scope.contractTerms || "",
    },
    activeDispute: disputes.length > 0 ? disputes[0] : null,
    reviews: reviews || [],
    createdAt: tx.created_at,
    updatedAt: tx.updated_at,
  };
}

/**
 * 3. List all escrows created by or associated with this API key.
 */
export async function listB2BEscrows(apiKeyDetails, { page = 1, limit = 20, status = null, search = null }) {
  const offset = (Math.max(1, page) - 1) * limit;
  let sql = `SELECT t.id, t.txn_code, t.title, t.category, t.amount, t.currency, t.status, t.escrow_balance, t.escrow_fee_amount, t.created_at,
                    b.email as buyer_email, b.name as buyer_name, s.email as seller_email, s.name as seller_name
             FROM transactions t
             JOIN users b ON b.id = t.buyer_id
             JOIN users s ON s.id = t.seller_id
             WHERE (
               t.scope_json LIKE ?
               OR t.buyer_id = ?
               OR t.seller_id = ?
             )`;

  const keyPattern = `%"api_key_id":${apiKeyDetails.keyId}%`;
  const params = [
    keyPattern,
    apiKeyDetails.owner.id,
    apiKeyDetails.owner.id,
  ];

  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }

  if (search) {
    sql += " AND (t.title LIKE ? OR t.txn_code LIKE ? OR b.email LIKE ? OR s.email LIKE ?)";
    const wildcard = `%${search}%`;
    params.push(wildcard, wildcard, wildcard, wildcard);
  }

  sql += " ORDER BY t.created_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const rows = await db.query(sql, params);

  return rows.map((r) => ({
    id: r.id,
    txnCode: r.txn_code,
    title: r.title,
    category: r.category,
    amount: parseFloat(r.amount),
    currency: r.currency,
    status: r.status,
    escrowBalance: parseFloat(r.escrow_balance || 0),
    escrowFeeAmount: parseFloat(r.escrow_fee_amount || 0),
    buyer: { name: r.buyer_name, email: r.buyer_email },
    seller: { name: r.seller_name, email: r.seller_email },
    createdAt: r.created_at,
  }));
}

/**
 * 4. Add a milestone to an existing pending transaction.
 */
export async function addMilestoneB2BEscrow(apiKeyDetails, transactionId, { title, description = "", amount }) {
  if (!title) throw new Error("Milestone 'title' is required.");
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    throw new Error("Valid milestone 'amount' greater than 0 is required.");
  }

  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);
  if (tx.status !== TRANSACTION_STATUS.PENDING) {
    throw new Error(`Cannot add milestone to a transaction in status "${tx.status}". Only 'pending' deals can be modified.`);
  }

  const parsedAmount = parseFloat(amount);
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [mRes] = await conn.query(
      `INSERT INTO milestones (transaction_id, title, description, amount, status, is_funded, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
      [tx.id, title, description, parsedAmount]
    );

    // Update total amount on transaction
    await conn.query(
      `UPDATE transactions 
       SET amount = amount + ?, milestones_count = milestones_count + 1
       WHERE id = ?`,
      [parsedAmount, tx.id]
    );

    await conn.commit();

    const result = {
      milestoneId: mRes.insertId,
      transactionId: tx.id,
      title,
      description,
      amount: parsedAmount,
      status: "pending",
      isFunded: false,
    };

    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Update milestone details (title, description, amount) on a pending transaction.
 */
export async function updateMilestoneB2BEscrow(apiKeyDetails, transactionId, milestoneId, { title, description, amount }) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);
  if (tx.status !== TRANSACTION_STATUS.PENDING) {
    throw new Error(`Cannot edit milestones on a transaction in "${tx.status}" status.`);
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? AND transaction_id = ? FOR UPDATE",
      [milestoneId, tx.id]
    );

    if (!milestones.length) {
      throw new Error(`Milestone ${milestoneId} not found.`);
    }

    const oldMilestone = milestones[0];
    const newAmount = amount !== undefined && !isNaN(amount) && Number(amount) > 0 ? parseFloat(amount) : parseFloat(oldMilestone.amount);
    const amountDiff = newAmount - parseFloat(oldMilestone.amount);

    await conn.query(
      `UPDATE milestones 
       SET title = COALESCE(?, title), description = COALESCE(?, description), amount = ?
       WHERE id = ?`,
      [title || null, description !== undefined ? description : null, newAmount, oldMilestone.id]
    );

    if (amountDiff !== 0) {
      await conn.query(
        `UPDATE transactions 
         SET amount = amount + ?, escrow_fee_amount = (amount + ?) * escrow_fee_rate
         WHERE id = ?`,
        [amountDiff, amountDiff, tx.id]
      );
    }

    await conn.commit();

    return {
      success: true,
      milestoneId: oldMilestone.id,
      title: title || oldMilestone.title,
      description: description !== undefined ? description : oldMilestone.description,
      amount: newAmount,
      message: "Milestone updated successfully.",
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Delete a milestone on a pending deal.
 */
export async function deleteMilestoneB2BEscrow(apiKeyDetails, transactionId, milestoneId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);
  if (tx.status !== TRANSACTION_STATUS.PENDING) {
    throw new Error(`Cannot delete milestones on a transaction in "${tx.status}" status.`);
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? AND transaction_id = ? FOR UPDATE",
      [milestoneId, tx.id]
    );

    if (!milestones.length) {
      throw new Error(`Milestone ${milestoneId} not found.`);
    }

    const m = milestones[0];
    const mAmount = parseFloat(m.amount);

    await conn.query("DELETE FROM milestones WHERE id = ?", [m.id]);

    await conn.query(
      `UPDATE transactions 
       SET amount = GREATEST(0, amount - ?), milestones_count = GREATEST(0, milestones_count - 1),
           escrow_fee_amount = GREATEST(0, amount - ?) * escrow_fee_rate
       WHERE id = ?`,
      [mAmount, mAmount, tx.id]
    );

    await conn.commit();

    return {
      success: true,
      milestoneId: m.id,
      message: "Milestone deleted successfully.",
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 5. Fund a milestone into escrow.
 */
export async function fundMilestoneB2BEscrow(apiKeyDetails, transactionId, milestoneId) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? AND transaction_id = ? FOR UPDATE",
      [milestoneId, tx.id]
    );

    if (!milestones.length) {
      throw new Error(`Milestone ${milestoneId} not found for this escrow deal.`);
    }

    const milestone = milestones[0];

    if (milestone.is_funded) {
      return { success: true, message: "Milestone is already funded.", milestoneId: milestone.id, isFunded: true };
    }

    const milestoneAmount = parseFloat(milestone.amount);

    // Fund through walletService
    await fundEscrow({
      conn,
      transaction: tx,
      milestone,
      buyerId: tx.buyer_id,
      amount: milestoneAmount,
    });

    // Update milestone
    await conn.query(
      "UPDATE milestones SET is_funded = 1, status = 'due', funded_at = NOW() WHERE id = ?",
      [milestone.id]
    );

    // Update transaction status if it was pending
    if (tx.status === TRANSACTION_STATUS.PENDING) {
      await updateTransactionStatus({
        conn,
        transaction: tx,
        userId: tx.buyer_id,
        nextStatus: TRANSACTION_STATUS.FUNDED,
        action: "milestone_funded",
      });
    }

    // Update transaction escrow balance
    await conn.query(
      "UPDATE transactions SET escrow_balance = escrow_balance + ? WHERE id = ?",
      [milestoneAmount, tx.id]
    );

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId: tx.buyer_id,
      action: "milestone_funded",
      note: `Milestone "${milestone.title}" ($${milestoneAmount.toFixed(2)}) funded into escrow`,
      metadata: { milestoneId: milestone.id, amount: milestoneAmount },
    });

    await conn.commit();

    const result = {
      success: true,
      transactionId: tx.id,
      milestoneId: milestone.id,
      milestoneTitle: milestone.title,
      fundedAmount: milestoneAmount,
      isFunded: true,
      status: "due",
      message: `Milestone "${milestone.title}" successfully funded into escrow.`,
    };

    // Dispatch webhook: milestone.funded
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "milestone.funded",
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * 6. Update milestone status (submit deliverable, approve, or reject).
 */
export async function updateMilestoneStatusB2BEscrow(apiKeyDetails, transactionId, milestoneId, { status, deliverableNote = "", deliverableUrl = null, deliverableFile = null, feedback = "" }) {
  if (!["submitted", "approved", "rejected"].includes(status)) {
    throw new Error("Invalid milestone status. Allowed values: 'submitted', 'approved', 'rejected'.");
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? AND transaction_id = ? FOR UPDATE",
      [milestoneId, tx.id]
    );

    if (!milestones.length) {
      throw new Error(`Milestone ${milestoneId} not found.`);
    }

    const milestone = milestones[0];

    if (status === "submitted") {
      await conn.query(
        "UPDATE milestones SET status = 'submitted', deliverable_note = ? WHERE id = ?",
        [deliverableNote, milestone.id]
      );

      // Save submission record
      await conn.query(
        `INSERT INTO milestone_submissions (milestone_id, deliverable_note, submission_data, created_at)
         VALUES (?, ?, ?, NOW())`,
        [milestone.id, deliverableNote, JSON.stringify({ deliverableUrl, deliverableFile })]
      ).catch(() => {});

      // Transition transaction to inspection if in inprogress or revision
      if ([TRANSACTION_STATUS.INPROGRESS, TRANSACTION_STATUS.REVISION, TRANSACTION_STATUS.FUNDED].includes(tx.status)) {
        await updateTransactionStatus({
          conn,
          transaction: tx,
          userId: tx.seller_id,
          nextStatus: TRANSACTION_STATUS.INSPECTION,
          action: "deliverable_submitted",
        });
      }

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId: tx.seller_id,
        action: "milestone_submitted",
        note: `Deliverable submitted for milestone "${milestone.title}"`,
        metadata: { milestoneId: milestone.id, deliverableNote, deliverableUrl },
      });
    } else if (status === "approved") {
      await conn.query(
        "UPDATE milestones SET status = 'approved' WHERE id = ?",
        [milestone.id]
      );

      // Check if all milestones are now approved
      const [allMilestones] = await conn.query(
        "SELECT id, status FROM milestones WHERE transaction_id = ?",
        [tx.id]
      );

      const allApproved = allMilestones.every((m) => (m.id === milestone.id ? true : m.status === "approved"));

      if (allApproved) {
        await updateTransactionStatus({
          conn,
          transaction: tx,
          userId: tx.buyer_id,
          nextStatus: TRANSACTION_STATUS.APPROVED,
          action: "all_milestones_approved",
        });
      }

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId: tx.buyer_id,
        action: "milestone_approved",
        note: `Milestone "${milestone.title}" approved by client`,
        metadata: { milestoneId: milestone.id, feedback },
      });
    } else if (status === "rejected") {
      await conn.query(
        "UPDATE milestones SET status = 'rejected' WHERE id = ?",
        [milestone.id]
      );

      await updateTransactionStatus({
        conn,
        transaction: tx,
        userId: tx.buyer_id,
        nextStatus: TRANSACTION_STATUS.REVISION,
        action: "milestone_rejected",
      });

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId: tx.buyer_id,
        action: "milestone_rejected",
        note: `Milestone "${milestone.title}" rejected: ${feedback || "Revision requested"}`,
        metadata: { milestoneId: milestone.id, feedback },
      });
    }

    await conn.commit();

    const result = {
      success: true,
      transactionId: tx.id,
      milestoneId: milestone.id,
      milestoneTitle: milestone.title,
      status,
      message: `Milestone status updated to "${status}".`,
    };

    // Dispatch webhook: milestone.[submitted|approved|rejected]
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: `milestone.${status}`,
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * 7. Transition transaction status.
 */
export async function updateEscrowStatusB2BEscrow(apiKeyDetails, transactionId, { status, note = "" }) {
  if (!Object.values(TRANSACTION_STATUS).includes(status)) {
    throw new Error(`Invalid status "${status}".`);
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    if (tx.status === status) {
      return { success: true, transactionId: tx.id, status: tx.status, message: `Status is already "${status}".` };
    }

    if (!canTransition(tx.status, status)) {
      throw new Error(`Cannot transition escrow transaction from "${tx.status}" to "${status}".`);
    }

    await updateTransactionStatus({
      conn,
      transaction: tx,
      userId: apiKeyDetails.owner.id,
      nextStatus: status,
      action: "status_transition_api",
    });

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId: apiKeyDetails.owner.id,
      action: "status_change",
      fromStatus: tx.status,
      toStatus: status,
      note: note || `Escrow status updated to ${status} via API`,
      metadata: { apiKeyId: apiKeyDetails.keyId },
    });

    await conn.commit();

    const result = {
      success: true,
      transactionId: tx.id,
      txnCode: tx.txn_code,
      previousStatus: tx.status,
      status,
      note,
      message: `Escrow status transitioned to "${status}".`,
    };

    // Dispatch webhook: escrow.status_changed
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "escrow.status_changed",
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 8. Explicit Escrow Release - Releases escrow balance to the seller.
 */
export async function releaseB2BEscrow(apiKeyDetails, transactionId, { reason = "Approved by partner API" } = {}) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    if (tx.status === TRANSACTION_STATUS.COMPLETED) {
      return { success: true, message: "Escrow is already completed.", status: "completed", releasedAmount: tx.amount };
    }

    const escrowBalance = parseFloat(tx.escrow_balance || 0);
    const releaseAmount = escrowBalance > 0 ? escrowBalance : parseFloat(tx.amount || 0);

    // Release escrow to seller
    await releaseEscrow({
      conn,
      transaction: tx,
      recipientId: tx.seller_id,
      amount: releaseAmount,
    });

    // Mark milestones approved
    await conn.query(
      "UPDATE milestones SET status = 'approved' WHERE transaction_id = ?",
      [tx.id]
    );

    // Mark transaction completed
    await conn.query(
      `UPDATE transactions 
       SET status = 'completed', released_amount = released_amount + ?, escrow_balance = 0.00
       WHERE id = ?`,
      [releaseAmount, tx.id]
    );

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId: tx.buyer_id,
      action: "full_escrow_released",
      fromStatus: tx.status,
      toStatus: "completed",
      note: reason || `Client released escrow funds ($${releaseAmount.toFixed(2)}) to seller wallet via API`,
      metadata: { releaseAmount, sellerId: tx.seller_id },
    });

    await conn.commit();

    const result = {
      success: true,
      transactionId: tx.id,
      txnCode: tx.txn_code,
      status: "completed",
      releasedAmount: releaseAmount,
      seller: { id: tx.seller_id, name: tx.seller_name, email: tx.seller_email },
      message: `Escrow funds of $${releaseAmount.toFixed(2)} successfully released to seller.`,
    };

    // Dispatch webhook: escrow.released
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "escrow.released",
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 9. Cancel Escrow Transaction with automatic refund to buyer.
 */
export async function cancelB2BEscrow(apiKeyDetails, transactionId, { reason = "Cancelled via API" } = {}) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    if ([TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.CANCELLED].includes(tx.status)) {
      throw new Error(`Cannot cancel a transaction in "${tx.status}" status.`);
    }

    const escrowBalance = parseFloat(tx.escrow_balance || 0);

    // If funds exist in escrow, refund back to buyer
    if (escrowBalance > 0) {
      await refundEscrow({
        conn,
        transaction: tx,
        recipientId: tx.buyer_id,
        amount: escrowBalance,
      });
    }

    await conn.query(
      `UPDATE transactions 
       SET status = 'cancelled', escrow_balance = 0.00
       WHERE id = ?`,
      [tx.id]
    );

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId: tx.buyer_id,
      action: "transaction_cancelled",
      fromStatus: tx.status,
      toStatus: "cancelled",
      note: reason || "Transaction cancelled via API. Escrow balance refunded to client.",
      metadata: { refundedAmount: escrowBalance },
    });

    await conn.commit();

    const result = {
      success: true,
      transactionId: tx.id,
      txnCode: tx.txn_code,
      status: "cancelled",
      refundedAmount: escrowBalance,
      message: `Escrow transaction cancelled. $${escrowBalance.toFixed(2)} refunded to buyer.`,
    };

    // Dispatch webhook: escrow.cancelled
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "escrow.cancelled",
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 10. Scope Management: Get Scope.
 */
export async function getScopeB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  let scope = {};
  if (tx.scope_json) {
    try {
      scope = typeof tx.scope_json === "string" ? JSON.parse(tx.scope_json) : tx.scope_json;
    } catch (e) {}
  }

  return {
    transactionId: tx.id,
    txnCode: tx.txn_code,
    title: tx.title,
    description: scope.description || "",
    deliverables: scope.deliverables || [],
    requirements: scope.requirements || "",
    acceptanceCriteria: scope.acceptanceCriteria || "",
    revisionPolicy: tx.revision_policy || "2 revisions included per milestone",
    contractTerms: scope.contractTerms || "",
  };
}

/**
 * 11. Scope Management: Update Scope.
 */
export async function updateScopeB2BEscrow(apiKeyDetails, transactionId, { deliverables, requirements, acceptanceCriteria, revisionPolicy, description }) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  if (tx.status !== TRANSACTION_STATUS.PENDING) {
    throw new Error(`Scope can only be edited when transaction is in 'pending' status.`);
  }

  let scope = {};
  if (tx.scope_json) {
    try {
      scope = typeof tx.scope_json === "string" ? JSON.parse(tx.scope_json) : tx.scope_json;
    } catch (e) {}
  }

  if (deliverables !== undefined) scope.deliverables = deliverables;
  if (requirements !== undefined) scope.requirements = requirements;
  if (acceptanceCriteria !== undefined) scope.acceptanceCriteria = acceptanceCriteria;
  if (description !== undefined) scope.description = description;

  await db.query(
    "UPDATE transactions SET scope_json = ?, revision_policy = COALESCE(?, revision_policy) WHERE id = ?",
    [JSON.stringify(scope), revisionPolicy, tx.id]
  );

  const result = {
    success: true,
    transactionId: tx.id,
    scope: {
      deliverables: scope.deliverables || [],
      requirements: scope.requirements || "",
      acceptanceCriteria: scope.acceptanceCriteria || "",
      description: scope.description || "",
      revisionPolicy: revisionPolicy || tx.revision_policy,
    },
    message: "Scope and contract terms updated successfully.",
  };

  // Dispatch webhook: scope.updated
  dispatchPartnerWebhook({
    apiKeyId: apiKeyDetails.keyId,
    webhookUrl: apiKeyDetails.webhookUrl,
    webhookSecret: apiKeyDetails.webhookSecret,
    eventType: "scope.updated",
    transactionId: tx.id,
    data: result,
  }).catch(() => {});

  return result;
}

/**
 * 12. Request Scope Changes.
 */
export async function requestScopeChangesB2BEscrow(apiKeyDetails, transactionId, { proposedChanges, reason = "" }) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  await logTransactionEvent({
    transactionId: tx.id,
    userId: apiKeyDetails.owner.id,
    action: "scope_change_requested",
    note: `Scope change requested: ${reason}`,
    metadata: { proposedChanges, reason },
  });

  const result = {
    success: true,
    transactionId: tx.id,
    proposedChanges,
    reason,
    message: "Scope modification request logged and notified.",
  };

  dispatchPartnerWebhook({
    apiKeyId: apiKeyDetails.keyId,
    webhookUrl: apiKeyDetails.webhookUrl,
    webhookSecret: apiKeyDetails.webhookSecret,
    eventType: "scope.change_requested",
    transactionId: tx.id,
    data: result,
  }).catch(() => {});

  return result;
}

/**
 * 13. Open Dispute on Escrow Transaction.
 */
export async function disputeB2BEscrow(apiKeyDetails, transactionId, { reason, evidenceUrl = null, raisedByRole = "buyer" } = {}) {
  if (!reason) throw new Error("Dispute 'reason' is required.");

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId, conn);

    const disputableStatuses = [
      TRANSACTION_STATUS.FUNDED,
      TRANSACTION_STATUS.INPROGRESS,
      TRANSACTION_STATUS.INSPECTION,
      TRANSACTION_STATUS.REVISION,
      TRANSACTION_STATUS.AUDIT,
    ];

    if (!disputableStatuses.includes(tx.status)) {
      throw new Error(`Cannot dispute an escrow in "${tx.status}" status.`);
    }

    const raisedById = (raisedByRole === "seller" || raisedByRole === "provider") ? tx.seller_id : tx.buyer_id;

    await conn.query(
      `UPDATE transactions SET status = 'disputed' WHERE id = ?`,
      [tx.id]
    );

    const evidenceJson = evidenceUrl ? JSON.stringify([{ url: evidenceUrl, addedAt: new Date() }]) : null;

    const [dispRes] = await conn.query(
      `INSERT INTO disputes (transaction_id, filed_by, reason, evidence, status, created_at)
       VALUES (?, ?, ?, ?, 'filed', NOW())`,
      [tx.id, raisedById, reason, evidenceJson]
    );

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId: raisedById,
      action: "dispute_opened",
      fromStatus: tx.status,
      toStatus: "disputed",
      note: `Formal dispute raised: ${reason}`,
      metadata: { disputeId: dispRes.insertId, evidenceUrl, raisedByRole },
    });

    await conn.commit();

    // Trigger AI analysis asynchronously
    runDisputeAnalysis(tx.id).catch((err) => {
      console.warn("[b2bEscrowService] AI Dispute analysis background note:", err.message);
    });

    const result = {
      success: true,
      disputeId: dispRes.insertId,
      transactionId: tx.id,
      txnCode: tx.txn_code,
      status: "disputed",
      reason,
      evidenceUrl,
      raisedByRole,
      message: "Dispute opened. Lumbrr arbitration team has been alerted.",
    };

    // Dispatch webhook: escrow.disputed
    dispatchPartnerWebhook({
      apiKeyId: apiKeyDetails.keyId,
      webhookUrl: apiKeyDetails.webhookUrl,
      webhookSecret: apiKeyDetails.webhookSecret,
      eventType: "escrow.disputed",
      transactionId: tx.id,
      data: result,
    }).catch(() => {});

    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 14. Get Dispute Details.
 */
export async function getDisputeB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const disputes = await db.query(
    `SELECT d.*, u.name as filed_by_name, u.email as filed_by_email
     FROM disputes d
     JOIN users u ON u.id = d.filed_by
     WHERE d.transaction_id = ?
     ORDER BY d.id DESC LIMIT 1`,
    [tx.id]
  );

  if (!disputes.length) {
    throw new Error(`No dispute found for transaction ${transactionId}.`);
  }

  const d = disputes[0];
  let evidence = [];
  if (d.evidence) {
    try {
      evidence = typeof d.evidence === "string" ? JSON.parse(d.evidence) : d.evidence;
    } catch (e) {}
  }

  return {
    disputeId: d.id,
    transactionId: tx.id,
    txnCode: tx.txn_code,
    status: d.status,
    reason: d.reason,
    evidence,
    resolution: d.resolution || null,
    raisedBy: { name: d.filed_by_name, email: d.filed_by_email },
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/**
 * 15. Resolve Dispute (Arbitration settlement).
 */
export async function resolveDisputeB2BEscrow(apiKeyDetails, transactionId, { resolution, winner, splitDetails = null }) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const result = await resolveDispute({
    disputeOrTxId: tx.id,
    resolution: resolution || "Resolved via API partner arbitration",
    winner: winner || "buyer",
    adminId: apiKeyDetails.owner.id,
    splitDetails,
  });

  dispatchPartnerWebhook({
    apiKeyId: apiKeyDetails.keyId,
    webhookUrl: apiKeyDetails.webhookUrl,
    webhookSecret: apiKeyDetails.webhookSecret,
    eventType: "dispute.resolved",
    transactionId: tx.id,
    data: result,
  }).catch(() => {});

  return result;
}

/**
 * 16. Get Transaction History / Timeline.
 */
export async function getTransactionHistoryB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const events = await db.query(
    `SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.metadata, e.created_at,
            u.name as user_name, u.email as user_email
     FROM transaction_events e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.transaction_id = ?
     ORDER BY e.id ASC`,
    [tx.id]
  );

  return {
    transactionId: tx.id,
    txnCode: tx.txn_code,
    events: events.map((e) => {
      let meta = null;
      if (e.metadata) {
        try {
          meta = typeof e.metadata === "string" ? JSON.parse(e.metadata) : e.metadata;
        } catch (err) {}
      }
      return {
        id: e.id,
        action: e.action,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: e.note,
        actor: e.user_name || "System",
        metadata: meta,
        timestamp: e.created_at,
      };
    }),
  };
}

/**
 * 17. Submit Review & Rating.
 */
export async function createReviewB2BEscrow(apiKeyDetails, transactionId, { rating, comment = "", reviewerRole = "buyer" }) {
  if (!rating || isNaN(rating) || Number(rating) < 1 || Number(rating) > 5) {
    throw new Error("Valid 'rating' between 1 and 5 is required.");
  }

  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);
  if (tx.status !== TRANSACTION_STATUS.COMPLETED) {
    throw new Error("Reviews can only be submitted after the escrow transaction is completed.");
  }

  const ratingInt = parseInt(rating, 10);
  const reviewerId = (reviewerRole === "seller" || reviewerRole === "provider") ? tx.seller_id : tx.buyer_id;
  const revieweeId = (reviewerRole === "seller" || reviewerRole === "provider") ? tx.buyer_id : tx.seller_id;

  const res = await db.query(
    `INSERT INTO reviews (transaction_id, reviewer_id, reviewee_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
    [tx.id, reviewerId, revieweeId, ratingInt, comment]
  );

  await logTransactionEvent({
    transactionId: tx.id,
    userId: reviewerId,
    action: "review_submitted",
    note: `Review submitted with rating ${ratingInt}/5`,
    metadata: { rating: ratingInt, comment, reviewerRole },
  });

  const result = {
    success: true,
    transactionId: tx.id,
    rating: ratingInt,
    comment,
    reviewerRole,
    message: "Review submitted successfully.",
  };

  dispatchPartnerWebhook({
    apiKeyId: apiKeyDetails.keyId,
    webhookUrl: apiKeyDetails.webhookUrl,
    webhookSecret: apiKeyDetails.webhookSecret,
    eventType: "review.submitted",
    transactionId: tx.id,
    data: result,
  }).catch(() => {});

  return result;
}

/**
 * 18. Get Reviews for Transaction.
 */
export async function getReviewsB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const reviews = await db.query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            reviewer.name as reviewer_name, reviewee.name as reviewee_name
     FROM reviews r
     JOIN users reviewer ON reviewer.id = r.reviewer_id
     JOIN users reviewee ON reviewee.id = r.reviewee_id
     WHERE r.transaction_id = ?`,
    [tx.id]
  );

  return {
    transactionId: tx.id,
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      reviewer: r.reviewer_name,
      reviewee: r.reviewee_name,
      createdAt: r.created_at,
    })),
  };
}

/**
 * 19. Generate / Refresh Payment Link for an Escrow deal.
 */
export async function generatePaymentLinkB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const totalAmount = parseFloat(tx.amount || 0);
  const escrowFee = parseFloat(tx.escrow_fee_amount || 0);
  const totalBuyerPays = Number((totalAmount + escrowFee).toFixed(2));

  const reference = `API-ESC-${tx.id}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  let chargeAmountNgn = totalBuyerPays;
  let chargeAmountKobo = Math.round(totalBuyerPays * 100);

  if (tx.currency === "USD") {
    const fxRate = await getUsdToNgnRate();
    chargeAmountNgn = totalBuyerPays * fxRate;
    chargeAmountKobo = Math.round(chargeAmountNgn * 100);
  }

  const paystackRes = await paystackService.initializePayment({
    email: tx.buyer_email,
    amountKobo: chargeAmountKobo,
    reference,
    metadata: {
      transaction_id: tx.id,
      purpose: "escrow_deposit",
      source: "api_v1",
      api_key_id: apiKeyDetails.keyId,
    },
  });

  return {
    transactionId: tx.id,
    txnCode: tx.txn_code,
    reference,
    totalBuyerPays,
    currency: tx.currency,
    paymentUrl: paystackRes.authorization_url,
  };
}

/**
 * 20. Verify Payment reference status.
 */
export async function verifyPaymentB2BEscrow(apiKeyDetails, reference) {
  const verification = await paystackService.verifyPayment(reference);
  return {
    reference,
    status: verification?.status || "unknown",
    amount: verification?.amount ? verification.amount / 100 : 0,
    paidAt: verification?.paid_at || null,
    gatewayResponse: verification?.gateway_response || "",
  };
}

/**
 * 21. AI Scope Generation.
 */
export async function generateAiScopeB2BEscrow(apiKeyDetails, { categoryLabel = "Software Development", description }) {
  if (!description || !description.trim()) {
    throw new Error("Project 'description' is required for AI scope generation.");
  }
  const scope = await generateAiScope(apiKeyDetails.owner.id, {
    categoryLabel,
    description: description.trim(),
  });
  return scope;
}

/**
 * 22. AI Deliverable Audit.
 */
export async function runAiAuditB2BEscrow(apiKeyDetails, transactionId, { milestoneId, submissionId = null, title, type, amount, currency }) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);

  const audit = await runAiAudit(apiKeyDetails.owner.id, {
    transactionId: tx.id,
    milestoneId: milestoneId || null,
    submissionId: submissionId || null,
    title: title || tx.title,
    type: type || tx.category || "General",
    amount: parseFloat(amount || tx.amount),
    currency: currency || tx.currency,
    counterparty: tx.seller_name || "Vendor",
  });

  return audit;
}

/**
 * 23. Get AI Audits for a transaction.
 */
export async function getAiAuditsB2BEscrow(apiKeyDetails, transactionId) {
  const tx = await getAuthorizedTransaction(apiKeyDetails, transactionId);
  const audits = await getTransactionAudits(tx.id);
  return audits;
}

/**
 * 24. Developer Partner Wallet & Payouts.
 */
export async function getPartnerWalletB2BEscrow(apiKeyDetails) {
  const rows = await db.query(
    "SELECT id, balance, currency, updated_at FROM wallets WHERE user_id = ?",
    [apiKeyDetails.owner.id]
  );

  if (!rows || rows.length === 0) {
    return {
      partnerId: apiKeyDetails.owner.id,
      balance: 0.00,
      currency: "USD",
    };
  }

  return {
    partnerId: apiKeyDetails.owner.id,
    walletId: rows[0].id,
    balance: parseFloat(rows[0].balance),
    currency: rows[0].currency || "USD",
    updatedAt: rows[0].updated_at,
  };
}

export async function listBankAccountsB2BEscrow(apiKeyDetails) {
  const rows = await db.query(
    "SELECT id, bank_name, bank_code, account_number, account_holder_name AS account_name, is_default AS is_primary, is_verified FROM bank_accounts WHERE user_id = ? ORDER BY is_default DESC, id DESC",
    [apiKeyDetails.owner.id]
  );
  return rows;
}

export async function addBankAccountB2BEscrow(apiKeyDetails, { accountNumber, bankCode, accountName }) {
  if (!accountNumber || !bankCode || !accountName) {
    throw new Error("'accountNumber', 'bankCode', and 'accountName' are required.");
  }

  let recipientCode = null;
  try {
    const rc = await paystackService.createTransferRecipient({
      type: "nuban",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    });
    recipientCode = rc?.recipient_code;
  } catch (err) {
    console.warn("[b2bEscrowService] Transfer recipient creation note:", err.message);
  }

  const res = await db.query(
    `INSERT INTO bank_accounts (user_id, bank_name, bank_code, account_number, account_holder_name, recipient_code, is_default, is_verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, NOW())
     ON DUPLICATE KEY UPDATE bank_name = VALUES(bank_name), bank_code = VALUES(bank_code), account_holder_name = VALUES(account_holder_name), recipient_code = VALUES(recipient_code), is_default = 1`,
    [apiKeyDetails.owner.id, "Bank", bankCode, accountNumber, accountName, recipientCode]
  );

  return {
    id: res.insertId || res.insertId === 0 ? res.insertId : null,
    accountNumber,
    bankCode,
    accountName,
    message: "Bank account saved for withdrawals.",
  };
}

export async function requestWithdrawalB2BEscrow(apiKeyDetails, { amount, bankAccountId = null }) {
  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Valid withdrawal 'amount' greater than 0 is required.");
  }

  const result = await withdrawalService.requestWithdrawal({
    userId: apiKeyDetails.owner.id,
    amount: parsedAmount,
    currency: "USD",
    bankAccountId,
  });

  return result;
}

export async function listWithdrawalsB2BEscrow(apiKeyDetails) {
  const rows = await db.query(
    `SELECT w.id, w.reference, w.amount, w.currency, w.status, w.failure_reason, w.requested_at, w.processed_at, w.created_at,
            b.bank_name, b.account_number, b.account_holder_name
     FROM withdrawals w
     LEFT JOIN bank_accounts b ON b.id = w.bank_account_id
     WHERE w.user_id = ?
     ORDER BY w.id DESC LIMIT 50`,
    [apiKeyDetails.owner.id]
  );
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    amount: parseFloat(r.amount),
    currency: r.currency,
    status: r.status,
    failureReason: r.failure_reason,
    bankAccount: r.bank_name ? { bankName: r.bank_name, accountNumber: r.account_number, accountHolderName: r.account_holder_name } : null,
    requestedAt: r.requested_at || r.created_at,
    processedAt: r.processed_at,
    createdAt: r.created_at,
  }));
}

/**
 * 25. Webhook Logs & Delivery Retries.
 */
export async function listWebhookDeliveriesB2BEscrow(apiKeyDetails, { limit = 50 }) {
  const rows = await db.query(
    `SELECT id, event_type, transaction_id, target_url, response_status, status, attempts, created_at
     FROM partner_webhooks_log
     WHERE api_key_id = ?
     ORDER BY id DESC LIMIT ?`,
    [apiKeyDetails.keyId, Number(limit)]
  );
  return rows;
}

export async function retryWebhookDeliveryB2BEscrow(apiKeyDetails, deliveryId) {
  const rows = await db.query(
    "SELECT * FROM partner_webhooks_log WHERE id = ? AND api_key_id = ?",
    [deliveryId, apiKeyDetails.keyId]
  );

  if (!rows.length) {
    throw new Error(`Webhook delivery record ${deliveryId} not found.`);
  }

  const record = rows[0];
  const payload = JSON.parse(record.payload);

  const res = await dispatchPartnerWebhook({
    apiKeyId: apiKeyDetails.keyId,
    webhookUrl: record.target_url,
    webhookSecret: apiKeyDetails.webhookSecret,
    eventType: record.event_type,
    transactionId: record.transaction_id,
    data: payload.data || {},
  });

  return {
    deliveryId,
    retryResult: res,
    message: "Webhook event re-dispatched.",
  };
}

export default {
  createB2BEscrow,
  getB2BEscrow,
  listB2BEscrows,
  addMilestoneB2BEscrow,
  updateMilestoneB2BEscrow,
  deleteMilestoneB2BEscrow,
  fundMilestoneB2BEscrow,
  updateMilestoneStatusB2BEscrow,
  updateEscrowStatusB2BEscrow,
  releaseB2BEscrow,
  cancelB2BEscrow,
  getScopeB2BEscrow,
  updateScopeB2BEscrow,
  requestScopeChangesB2BEscrow,
  disputeB2BEscrow,
  getDisputeB2BEscrow,
  resolveDisputeB2BEscrow,
  getTransactionHistoryB2BEscrow,
  createReviewB2BEscrow,
  getReviewsB2BEscrow,
  generatePaymentLinkB2BEscrow,
  verifyPaymentB2BEscrow,
  generateAiScopeB2BEscrow,
  runAiAuditB2BEscrow,
  getAiAuditsB2BEscrow,
  getPartnerWalletB2BEscrow,
  listBankAccountsB2BEscrow,
  addBankAccountB2BEscrow,
  requestWithdrawalB2BEscrow,
  listWithdrawalsB2BEscrow,
  listWebhookDeliveriesB2BEscrow,
  retryWebhookDeliveryB2BEscrow,
};
