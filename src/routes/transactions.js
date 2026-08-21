import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import crypto from "crypto";
import { ACTION_STATUS_MAP } from "../core/transactionActionMap.js";
import { updateTransactionStatus } from "../services/transactionService.js";
import { logTransactionEvent } from "../services/transactionEventService.js";
import { notify } from "../services/notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const router = express.Router();

import { TRANSACTION_STATUS } from "../core/transactionStatus.js";

import { canTransition } from "../core/transactionStateMachine.js";

import {
  fundEscrow,
  releaseEscrow,
  refundEscrow,
} from "../services/walletService.js";
import { resolveDispute } from "../services/disputeService.js";
import { validateSubmissionData } from "../core/submissionValidator.js";
import { normalizeCategory } from "../constants/serviceCategories.js";
import { hydrateScope, lockScope } from "../services/scopeService.js";

// Apply auth middleware to all routes in this router
router.use(authMiddleware);

// Allowed currency codes accepted when creating a transaction
const ALLOWED_CURRENCIES = ["USD", "EUR", "GBP", "NGN", "CAD", "AUD", "JPY"];

const MILESTONE_STATUS = {
  PENDING: "pending",
  DUE: "due",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REJECTED: "rejected",
  PAID: "paid",
  UPCOMING: "upcoming",
};

const ROLE = {
  BUYER: "buyer",
  SELLER: "seller",
};

// Dispute lifecycle statuses — used everywhere instead of inline strings.
const DISPUTE_STATUS = Object.freeze({
  FILED: "filed",
  UNDER_REVIEW: "under_review",
  RESOLVED: "resolved",
});

// Valid transaction statuses and the transitions permitted between them.
// Anything not listed as a valid "from -> to" pair is rejected.
const ALLOWED_TRANSACTION_STATUSES = Object.values(TRANSACTION_STATUS);

// ---------------------------------------------------------------------
// Role-permission map aligned with transactionStateMachine.js.
// Only transitions that non-admin users may perform through PATCH /:id/status
// are listed here.  Admin-only paths (DISPUTED→APPROVED, DISPUTED→COMPLETED)
// are handled exclusively by PATCH /:id/dispute/resolve.
// PENDING→FUNDED is driven by POST /milestones/:id/pay, not by the status
// endpoint, so it has no entry here.
const TRANSACTION_TRANSITION_ROLES = {
  // Once funded the seller starts work
  [`${TRANSACTION_STATUS.FUNDED}:${TRANSACTION_STATUS.INPROGRESS}`]: [
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.FUNDED}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],

  // Work in progress
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.INSPECTION}`]: [
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],

  // Buyer reviews & approves deliverable
  [`${TRANSACTION_STATUS.INSPECTION}:${TRANSACTION_STATUS.AUDIT}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INSPECTION}:${TRANSACTION_STATUS.REVISION}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INSPECTION}:${TRANSACTION_STATUS.APPROVED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INSPECTION}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INSPECTION}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],

  // Revision loop
  [`${TRANSACTION_STATUS.REVISION}:${TRANSACTION_STATUS.INPROGRESS}`]: [
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.REVISION}:${TRANSACTION_STATUS.APPROVED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.REVISION}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.REVISION}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],

  // Audit / approval
  [`${TRANSACTION_STATUS.AUDIT}:${TRANSACTION_STATUS.APPROVED}`]: [ROLE.BUYER],
  [`${TRANSACTION_STATUS.AUDIT}:${TRANSACTION_STATUS.COMPLETED}`]: [ROLE.BUYER],
  [`${TRANSACTION_STATUS.AUDIT}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],

  // Buyer releases funds
  [`${TRANSACTION_STATUS.APPROVED}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.FUNDED}:${TRANSACTION_STATUS.APPROVED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.FUNDED}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.APPROVED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
};

// Milestone statuses that may be set manually through the status endpoint.
// "pending", "due" and "paid" are all controlled by the system itself.

const MANUAL_MILESTONE_STATUSES = [
  MILESTONE_STATUS.SUBMITTED,
  MILESTONE_STATUS.APPROVED,
  MILESTONE_STATUS.REJECTED,
];

const ALLOWED_MILESTONE_TRANSITIONS = {
  [MILESTONE_STATUS.DUE]: [MILESTONE_STATUS.SUBMITTED],
  [MILESTONE_STATUS.PAID]: [MILESTONE_STATUS.SUBMITTED],
  [MILESTONE_STATUS.PENDING]: [MILESTONE_STATUS.SUBMITTED],
  [MILESTONE_STATUS.UPCOMING]: [MILESTONE_STATUS.SUBMITTED],
  [MILESTONE_STATUS.SUBMITTED]: [
    MILESTONE_STATUS.APPROVED,
    MILESTONE_STATUS.REJECTED,
  ],
  [MILESTONE_STATUS.REJECTED]: [MILESTONE_STATUS.SUBMITTED],
};

const MAX_DELIVERABLE_NOTE_LENGTH = 5000;

// Cap title length (transaction titles and milestone titles both
// use this field name/shape, so both are guarded by the same constant).
const MAX_TITLE_LENGTH = 200;

// Reject absurd transaction amounts.
const MAX_TRANSACTION_AMOUNT = 1_000_000;

const CATEGORY_PATTERN = /^[a-zA-Z0-9 _-]{2,50}$/;

// Centralised validation limits for dispute and review fields.
const MAX_DISPUTE_REASON_LENGTH = 2000;
const MAX_DISPUTE_EVIDENCE_LENGTH = 50_000_000;
const MAX_REVIEW_COMMENT_LENGTH = 2000;

// Returns "buyer", "seller", or null if userId isn't a party to tx.
function participantRole(tx, userId) {
  if (tx.buyer_id === userId) return ROLE.BUYER;
  if (tx.seller_id === userId) return ROLE.SELLER;
  return null;
}

function isParticipant(tx, userId) {
  return participantRole(tx, userId) !== null;
}

// Rolls back the current DB transaction and returns a JSON error response
// in one call, e.g. `return rollbackWithError(conn, res, 403, "...");`
async function rollbackWithError(conn, res, statusCode, error) {
  await conn.rollback();
  return res.status(statusCode).json({ error });
}

// Issue 11: extracted so any future endpoint that edits review_days can
// reuse the exact same validation instead of re-implementing it.
function parseReviewDays(raw) {
  const reviewDays = raw === undefined ? 3 : parseInt(raw);
  if (isNaN(reviewDays) || reviewDays < 1 || reviewDays > 30) {
    return null;
  }
  return reviewDays;
}

async function resolveTransactionId(paramId) {
  if (!paramId) return null;
  const numId = Number(paramId);
  if (!isNaN(numId)) {
    const txRows = await db.query("SELECT id FROM transactions WHERE id = ?", [numId]);
    if (txRows.length) return txRows[0].id;

    const dRows = await db.query("SELECT transaction_id FROM disputes WHERE id = ?", [numId]);
    if (dRows.length) return dRows[0].transaction_id;

    return null;
  }
  const rows = await db.query("SELECT id FROM transactions WHERE txn_code = ?", [paramId]);
  return rows.length ? rows[0].id : null;
}

import { getUserEntitlements } from "../services/entitlementService.js";
import { getUsdToNgnRate } from "../services/exchangeRateService.js";

async function populateMilestoneDetails(milestones) {
  if (!milestones || milestones.length === 0) return;
  const mIds = milestones.map((m) => m.id);

  try {
    const [submissions, revisions, evidenceItems] = await Promise.all([
      db.query("SELECT * FROM milestone_submissions WHERE milestone_id IN (?) ORDER BY version ASC", [mIds]),
      db.query("SELECT * FROM revision_requests WHERE milestone_id IN (?) ORDER BY created_at ASC", [mIds]),
      db.query("SELECT * FROM evidence_items WHERE milestone_id IN (?) ORDER BY id ASC", [mIds]),
    ]);

    submissions.forEach((s) => {
      if (typeof s.submission_data === "string") {
        try {
          s.submission_data = JSON.parse(s.submission_data);
        } catch (e) {}
      }
    });

    milestones.forEach((m) => {
      m.submissions = submissions.filter((s) => s.milestone_id === m.id);
      m.revision_requests = revisions.filter((r) => r.milestone_id === m.id);
      m.evidence_items = evidenceItems.filter((e) => e.milestone_id === m.id);
    });
  } catch (err) {
    console.error("Error populating milestone details:", err);
  }
}

// 1. GET / - List transactions for current user (either buyer or seller)
router.get("/", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const entitlements = await getUserEntitlements(userId);
    
    let querySql = `SELECT t.*, 
              u_buyer.name as buyer_name, u_buyer.email as buyer_email,
              u_seller.name as seller_name, u_seller.email as seller_email
       FROM transactions t
       JOIN users u_buyer ON t.buyer_id = u_buyer.id
       JOIN users u_seller ON t.seller_id = u_seller.id
       WHERE (t.buyer_id = ? OR t.seller_id = ?)`;

    const params = [userId, userId];

    // Enforce transaction history limits for non-admin users
    const historyMonths = entitlements.limits.transactionHistoryMonths;
    if (req.user.role !== "admin" && isFinite(historyMonths) && historyMonths > 0) {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - historyMonths);
      querySql += ` AND t.created_at >= ?`;
      params.push(cutoffDate);
    }

    querySql += ` ORDER BY t.created_at DESC`;

    const txs = await db.query(querySql, params);

    if (txs.length > 0) {
      const txIds = txs.map((t) => t.id);
      const milestones = await db.query(
        "SELECT * FROM milestones WHERE transaction_id IN (?) ORDER BY id ASC",
        [txIds],
      );
      await populateMilestoneDetails(milestones);
      txs.forEach((tx) => {
        tx.milestones = milestones.filter((m) => m.transaction_id === tx.id);
      });
    }

    res.json(txs);
  } catch (error) {
    next(error);
  }
});

// 2. POST / - Create a new transaction
router.post("/", async (req, res, next) => {
  const {
    title,
    category,
    amount,
    currency,
    counterparty,
    role,
    review_days,
    milestones_count,
    scope_json,
    ai_estimated_timeline,
    agreed_duration,
    agreed_deadline,
    revision_policy,
  } = req.body;
  const userId = req.user.id;

  if (!title || !category || !amount || !counterparty) {
    return res
      .status(400)
      .json({ error: "Missing required transaction fields." });
  }

  // Parse scope_json if provided
  let parsedScopeJson = null;
  if (scope_json) {
    try {
      parsedScopeJson = typeof scope_json === "object" ? scope_json : JSON.parse(scope_json);
    } catch (e) {
      console.warn("Invalid scope_json passed to transaction create:", e.message);
    }
  }

  const scopeMilestones = parsedScopeJson?.milestones && Array.isArray(parsedScopeJson.milestones) && parsedScopeJson.milestones.length > 0
    ? parsedScopeJson.milestones
    : null;

  const estimatedTimeline = ai_estimated_timeline || parsedScopeJson?.timeline || null;
  const revPolicy = revision_policy || parsedScopeJson?.revisions || '2 rounds of minor revisions';

  // Trim title and make sure it isn't empty after trimming
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    return res.status(400).json({ error: "Title cannot be empty." });
  }
  // Issue 7: cap title length
  if (cleanTitle.length > MAX_TITLE_LENGTH) {
    return res.status(400).json({
      error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    });
  }

  // Issue 8: validate category format (see CATEGORY_PATTERN comment above)
  const cleanCategory = String(category).trim();
  if (!CATEGORY_PATTERN.test(cleanCategory)) {
    return res.status(400).json({
      error:
        "Category must be 2-50 characters and contain only letters, numbers, spaces, hyphens, or underscores.",
    });
  }

  // Validate role
  const normalizedRole = (role || "").toLowerCase();
  if (![ROLE.BUYER, ROLE.SELLER].includes(normalizedRole)) {
    return res.status(400).json({
      error: "Role must be buyer or seller.",
    });
  }

  // Validate amount
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      error: "Amount must be greater than zero.",
    });
  }
  // Issue 10: cap maximum transaction amount
  if (parsedAmount > MAX_TRANSACTION_AMOUNT) {
    return res.status(400).json({
      error: `Amount cannot exceed ${MAX_TRANSACTION_AMOUNT}.`,
    });
  }

  // Validate currency
  const normalizedCurrency = (currency || "USD").toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(normalizedCurrency)) {
    return res.status(400).json({
      error: `Currency must be one of: ${ALLOWED_CURRENCIES.join(", ")}.`,
    });
  }

  // Validate milestone count
  const userCount = milestones_count !== undefined && !isNaN(parseInt(milestones_count)) ? parseInt(milestones_count) : null;
  const rawCount = (userCount !== null && userCount > 0)
    ? userCount
    : (scopeMilestones && scopeMilestones.length ? scopeMilestones.length : 1);
  const count = isNaN(rawCount) || rawCount < 1 ? 1 : Math.min(100, rawCount);

  // Validate review days (Issue 11: shared helper)
  const reviewDays = parseReviewDays(review_days);
  if (reviewDays === null) {
    return res.status(400).json({
      error: "Review days must be between 1 and 30.",
    });
  }

  // ----------------------------------------------------
  // SERVER-SIDE ENTITLEMENT & AUTHORIZATION CHECKS
  // ----------------------------------------------------
  const entitlements = await getUserEntitlements(userId);

  // 1. KYC requirement check: Level 2 required for escrow creation
  if (entitlements.effectiveLevel < 2) {
    return res.status(403).json({
      code: "KYC_LEVEL_REQUIRED",
      requiredKycLevel: 2,
      currentKycLevel: entitlements.kyc.level,
      message: "Complete KYC Level 2 to create escrow transactions.",
    });
  }

  // 2. Active deal limit check
  if (entitlements.usage.activeDealsCount >= entitlements.limits.maxActiveDeals) {
    return res.status(403).json({
      code: "ACTIVE_DEAL_LIMIT_REACHED",
      limit: entitlements.limits.maxActiveDeals,
      message: `You have reached the maximum number of active deals (${entitlements.limits.maxActiveDeals}) for your plan.`,
    });
  }

  // 3. Multi-currency entitlement check
  if (normalizedCurrency !== "USD" && !entitlements.capabilities.canUseMultiCurrency) {
    return res.status(403).json({
      code: "MULTI_CURRENCY_NOT_AVAILABLE",
      message: "Multi-currency transactions require a Gold or Diamond plan.",
    });
  }

  // 4. Escrow amount limit check (converted to USD equivalent)
  let amountInUsd = parsedAmount;
  if (normalizedCurrency === "NGN") {
    try {
      const rate = await getUsdToNgnRate();
      if (rate && rate > 0) {
        amountInUsd = parsedAmount / rate;
      }
    } catch (e) {
      amountInUsd = parsedAmount / 1500;
    }
  } else if (normalizedCurrency === "GBP") {
    amountInUsd = parsedAmount * 1.30;
  } else if (normalizedCurrency === "EUR") {
    amountInUsd = parsedAmount * 1.10;
  } else if (normalizedCurrency === "AUD" || normalizedCurrency === "CAD") {
    amountInUsd = parsedAmount * 0.70;
  }

  if (amountInUsd > entitlements.limits.maxEscrowUsd) {
    if (entitlements.subscription.subscriptionTier > entitlements.effectiveLevel) {
      return res.status(403).json({
        code: "KYC_LEVEL_REQUIRED",
        requiredKycLevel: entitlements.subscription.subscriptionTier,
        currentKycLevel: entitlements.kyc.level,
        message: `Complete KYC Level ${entitlements.subscription.subscriptionTier} to unlock your ${entitlements.subscription.planName} escrow limit.`,
      });
    }
    return res.status(403).json({
      code: "ESCROW_LIMIT_EXCEEDED",
      maxEscrowUsd: entitlements.limits.maxEscrowUsd,
      requestedEscrowUsd: Math.round(amountInUsd),
      message: `Your ${entitlements.subscription.planName} plan allows up to $${entitlements.limits.maxEscrowUsd.toLocaleString()} per escrow.`,
    });
  }

  // Determine & snapshot fee rate and amount
  const escrowFeeRate = entitlements.limits.escrowFeeRate;
  const escrowFeeAmount = Number((parsedAmount * escrowFeeRate).toFixed(2));

  const normalizedCounterpartyEmail = counterparty.trim().toLowerCase();

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Find the counterparty user by email
    const [cUsers] = await conn.query(
      "SELECT id, name FROM users WHERE email = ?",
      [normalizedCounterpartyEmail],
    );
    if (cUsers.length === 0) {
      return rollbackWithError(
        conn,
        res,
        404,
        `Counterparty user with email "${normalizedCounterpartyEmail}" not found.`,
      );
    }
    const counterpartyId = cUsers[0].id;

    if (counterpartyId === userId) {
      return rollbackWithError(
        conn,
        res,
        400,
        "You cannot create a transaction with yourself.",
      );
    }

    // Determine buyer_id and seller_id based on current user's role choice in the transaction
    let buyerId, sellerId;
    if (normalizedRole === ROLE.BUYER) {
      buyerId = userId;
      sellerId = counterpartyId;
    } else {
      buyerId = counterpartyId;
      sellerId = userId;
    }

    // 2. Insert transaction, retrying on the (very unlikely) chance the
    // generated txn_code collides with an existing one.
    let transactionId;
    let txnCode;
    let attempts = 0;
    let inserted = false;

    while (!inserted) {
      attempts++;
      txnCode = `TXN-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

      try {
        const [txnResult] = await conn.query(
          `INSERT INTO transactions
       (txn_code, title, category, amount, currency, buyer_id, seller_id, escrow_fee_rate, escrow_fee_amount, status, review_days, milestones_count, scope_json, ai_estimated_timeline, agreed_duration, agreed_deadline, revision_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            txnCode,
            cleanTitle,
            cleanCategory,
            parsedAmount,
            normalizedCurrency,
            buyerId,
            sellerId,
            escrowFeeRate,
            escrowFeeAmount,
            TRANSACTION_STATUS.PENDING,
            reviewDays,
            count,
            parsedScopeJson ? JSON.stringify(parsedScopeJson) : null,
            estimatedTimeline,
            agreed_duration || null,
            agreed_deadline ? new Date(agreed_deadline) : null,
            revPolicy,
          ],
        );

        transactionId = txnResult.insertId;
        inserted = true;
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY" && attempts < 5) {
          continue;
        }
        throw err;
      }
    }

    await logTransactionEvent({
      conn,
      transactionId,
      userId,
      action: "transaction_created",
      toStatus: TRANSACTION_STATUS.PENDING,
      note: `Created transaction "${cleanTitle}"`,
      metadata: {
        buyerId,
        sellerId,
        amount: parsedAmount,
        currency: normalizedCurrency,
        hasScope: !!parsedScopeJson,
      },
    });

    // 3. Create milestones
    const totalAmount = parsedAmount;
    const baseAmount = Number((totalAmount / count).toFixed(2));
    let remaining = totalAmount;

    for (let i = 1; i <= count; i++) {
      const currentAmount =
        i === count ? Number(remaining.toFixed(2)) : baseAmount;
      remaining -= currentAmount;

      const mScope = scopeMilestones ? scopeMilestones[i - 1] : null;
      const milestoneTitle = mScope?.name || `Milestone ${i} of ${count}`;
      const milestoneDesc = mScope?.description || null;
      const milestoneTimeline = mScope?.timeline || null;

      await conn.query(
        `INSERT INTO milestones
    (transaction_id, title, amount, status, description, ai_suggested_timeline)
    VALUES (?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          milestoneTitle,
          currentAmount,
          i === 1 ? MILESTONE_STATUS.UPCOMING : MILESTONE_STATUS.PENDING,
          milestoneDesc,
          milestoneTimeline,
        ],
      );
    }

    await conn.commit();

    // Send transaction creation notifications
    notify({
      userId: buyerId,
      type: NOTIFICATION_TYPE.TRANSACTION_CREATED,
      data: {
        transaction: cleanTitle,
        amount: parsedAmount,
        code: txnCode,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    notify({
      userId: sellerId,
      type: NOTIFICATION_TYPE.TRANSACTION_CREATED,
      data: {
        transaction: cleanTitle,
        amount: parsedAmount,
        code: txnCode,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    // The first milestone is set to DUE, notify the buyer
    notify({
      userId: buyerId,
      type: NOTIFICATION_TYPE.MILESTONE_DUE,
      data: {
        milestone: `Milestone 1 of ${count}`,
        transaction: cleanTitle,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    // Fetch full newly created transaction
    const [newTxn] = await conn.query(
      `SELECT t.*, 
              u_buyer.name as buyer_name, u_buyer.email as buyer_email,
              u_seller.name as seller_name, u_seller.email as seller_email
       FROM transactions t
       JOIN users u_buyer ON t.buyer_id = u_buyer.id
       JOIN users u_seller ON t.seller_id = u_seller.id
       WHERE t.id = ?`,
      [transactionId],
    );

    const [newMilestones] = await conn.query(
      "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
      [transactionId],
    );

    newTxn[0].milestones = newMilestones;

    res.status(201).json(newTxn[0]);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 2b. PATCH /:id/scope — Attach or update confirmed AI scope on an existing transaction (buyer only)
router.patch("/:id/scope", async (req, res, next) => {
  const userId = req.user.id;
  const { scope_json, ai_estimated_timeline, agreed_duration, agreed_deadline, revision_policy } = req.body;

  if (!scope_json || typeof scope_json !== "object") {
    return res.status(400).json({ error: "scope_json (object) is required." });
  }

  try {
    const transactionId = await resolveTransactionId(req.params.id);
    if (!transactionId) return res.status(404).json({ error: "Transaction not found." });

    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [transactionId]);
    if (!txs.length) return res.status(404).json({ error: "Transaction not found." });

    const tx = txs[0];

    // Only the buyer (client) may attach/update scope
    if (tx.buyer_id !== userId) {
      return res.status(403).json({ error: "Only the client (buyer) can attach a scope to a transaction." });
    }

    const scopeStr = JSON.stringify(scope_json);
    const estimatedTimeline = ai_estimated_timeline || scope_json.timeline || null;
    const revPolicy = revision_policy || scope_json.revisions || "2 rounds of minor revisions";

    const scopeMilestones = Array.isArray(scope_json.milestones) ? scope_json.milestones : [];
    const count = scopeMilestones.length > 0 ? scopeMilestones.length : (tx.milestones_count || 1);

    // Recalculate escrow fee amount based on rate and transaction value
    const totalAmount = parseFloat(tx.amount || 0);
    const escrowFeeRate = parseFloat(tx.escrow_fee_rate || 0.05);
    const escrowFeeAmount = Number((totalAmount * escrowFeeRate).toFixed(2));

    await db.query(
      `UPDATE transactions SET
        scope_json = ?,
        ai_estimated_timeline = ?,
        agreed_duration = ?,
        agreed_deadline = ?,
        revision_policy = ?,
        milestones_count = ?,
        escrow_fee_amount = ?
       WHERE id = ?`,
      [
        scopeStr,
        estimatedTimeline,
        agreed_duration || null,
        agreed_deadline ? new Date(agreed_deadline) : null,
        revPolicy,
        count,
        escrowFeeAmount,
        transactionId,
      ]
    );

    // Check existing milestones in DB
    const dbMilestones = await db.query(
      "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
      [transactionId]
    );

    const hasPaidOrApproved = dbMilestones.some(m => ["paid", "approved"].includes(m.status));

    if (!hasPaidOrApproved && scopeMilestones.length > 0) {
      // Pre-funding phase: recreate milestones to match the updated scope breakdown count & details
      await db.query("DELETE FROM milestones WHERE transaction_id = ?", [transactionId]);

      const baseAmount = Number((totalAmount / count).toFixed(2));
      let remaining = totalAmount;

      for (let i = 1; i <= count; i++) {
        const currentAmount = i === count ? Number(remaining.toFixed(2)) : baseAmount;
        remaining -= currentAmount;

        const mScope = scopeMilestones[i - 1];
        const milestoneTitle = mScope?.name || `Milestone ${i} of ${count}`;
        const milestoneDesc = mScope?.description || null;
        const milestoneTimeline = mScope?.timeline || null;

        await db.query(
          `INSERT INTO milestones
           (transaction_id, title, amount, status, description, ai_suggested_timeline)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            transactionId,
            milestoneTitle,
            currentAmount,
            i === 1 ? MILESTONE_STATUS.UPCOMING : MILESTONE_STATUS.PENDING,
            milestoneDesc,
            milestoneTimeline,
          ]
        );
      }
    } else if (scopeMilestones.length > 0) {
      // Work/paid in progress: update titles/descriptions/timelines without disturbing paid status
      for (let i = 0; i < Math.min(scopeMilestones.length, dbMilestones.length); i++) {
        const sm = scopeMilestones[i];
        const dm = dbMilestones[i];
        await db.query(
          `UPDATE milestones SET title = ?, description = ?, ai_suggested_timeline = ? WHERE id = ?`,
          [sm.name || dm.title, sm.description || null, sm.timeline || null, dm.id]
        );
      }
    }

    // Log transaction event
    const conn = await db.getPool().getConnection();
    try {
      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: "contract_scope_updated",
        note: "Contract scope and milestone breakdown updated by client.",
        metadata: {
          updatedBy: userId,
          milestonesCount: count,
          escrowFeeAmount,
        },
      });
    } finally {
      conn.release();
    }

    // Notify provider (seller) that contract scope was updated
    notify({
      userId: tx.seller_id,
      type: NOTIFICATION_TYPE.CONTRACT_UPDATED || "transaction_updated",
      data: {
        transaction: tx.title,
        message: "The client has updated the transaction scope and contract terms.",
      },
      email: true,
      push: true,
    }).catch(err => console.error("Notification dispatch error:", err));

    // Also notify buyer (client) so SSE triggers UI refresh on open tabs
    notify({
      userId: tx.buyer_id,
      type: NOTIFICATION_TYPE.CONTRACT_UPDATED || "transaction_updated",
      data: {
        transaction: tx.title,
        message: "Contract scope updated successfully.",
      },
    }).catch(err => console.error("Notification dispatch error:", err));

    // Stage 1: hydrate relational scope tables from the saved scope_json
    // Runs fire-and-forget; any error is logged but must not break the response.
    hydrateScope(transactionId, scope_json).catch((err) =>
      console.error("[scopeService] hydrateScope error after scope PATCH:", err)
    );

    // Return updated transaction
    const updated = await db.query(
      `SELECT t.*, u_buyer.name as buyer_name, u_seller.name as seller_name
       FROM transactions t
       JOIN users u_buyer ON t.buyer_id = u_buyer.id
       JOIN users u_seller ON t.seller_id = u_seller.id
       WHERE t.id = ?`,
      [transactionId]
    );
    const milestones = await db.query(
      "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
      [transactionId]
    );
    updated[0].milestones = milestones;

    res.json({ success: true, transaction: updated[0] });
  } catch (error) {
    next(error);
  }
});

// 2c. POST /:id/scope/request-changes — Provider flags contract concerns to client (pre-work only)
router.post("/:id/scope/request-changes", async (req, res, next) => {
  const userId = req.user.id;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: "A message describing the requested changes is required." });
  }
  if (message.trim().length > 2000) {
    return res.status(400).json({ error: "Message must be 2000 characters or fewer." });
  }

  try {
    const transactionId = await resolveTransactionId(req.params.id);
    if (!transactionId) return res.status(404).json({ error: "Transaction not found." });

    const txs = await db.query(
      `SELECT t.*, u_seller.name as seller_name, u_buyer.name as buyer_name, u_buyer.email as buyer_email
       FROM transactions t
       JOIN users u_seller ON t.seller_id = u_seller.id
       JOIN users u_buyer  ON t.buyer_id  = u_buyer.id
       WHERE t.id = ?`,
      [transactionId]
    );
    if (!txs.length) return res.status(404).json({ error: "Transaction not found." });

    const tx = txs[0];

    // Only the seller (provider) may request changes
    if (tx.seller_id !== userId) {
      return res.status(403).json({ error: "Only the service provider can request contract changes." });
    }

    // Only allowed before work starts (pending or funded)
    if (!["pending", "funded"].includes(tx.status)) {
      return res.status(400).json({
        error: `Contract changes can only be requested before work starts. Current status: ${tx.status}.`
      });
    }

    // Log transaction event so client can see requested contract changes
    const conn = await db.getPool().getConnection();
    try {
      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: "contract_change_requested",
        note: message.trim(),
        metadata: {
          requestedBy: userId,
          sellerName: tx.seller_name,
          message: message.trim(),
        },
      });
    } finally {
      conn.release();
    }

    // Notify the buyer (client) with the provider's concerns
    notify({
      userId: tx.buyer_id,
      type: NOTIFICATION_TYPE.CONTRACT_CHANGE_REQUESTED,
      data: {
        provider:    tx.seller_name,
        transaction: tx.title,
        txnCode:     tx.txn_code,
        message:     message.trim(),
      },
      email: true,
      push:  true,
    }).catch(err => console.error("Contract change request notification error:", err));

    res.json({
      success: true,
      message: "Your change request has been sent to the client. They will be notified immediately.",
    });
  } catch (error) {
    next(error);
  }
});

// 3. GET /:id - Get a single transaction by ID or code, including its milestones
router.get("/:id", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;

  try {
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const txs = await db.query(
      `SELECT t.*, 
              u_buyer.name as buyer_name, u_buyer.email as buyer_email,
              u_seller.name as seller_name, u_seller.email as seller_email
       FROM transactions t
       JOIN users u_buyer ON t.buyer_id = u_buyer.id
       JOIN users u_seller ON t.seller_id = u_seller.id
       WHERE t.id = ?`,
      [transactionId],
    );

    if (txs.length === 0) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const tx = txs[0];

    // Check permission (user must be buyer or seller)
    if (!isParticipant(tx, userId)) {
      return res.status(403).json({ error: "Access denied." });
    }

    // Get milestones
    const milestones = await db.query(
      "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
      [tx.id],
    );
    await populateMilestoneDetails(milestones);

    tx.milestones = milestones;

    res.json(tx);
  } catch (error) {
    next(error);
  }
});

// GET /:id/history - accepts either the numeric id or the txn_code, same as GET /:id
router.get("/:id/history", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;

  try {
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({
        error: "Transaction not found.",
      });
    }

    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [
      transactionId,
    ]);

    if (!txs.length) {
      return res.status(404).json({
        error: "Transaction not found.",
      });
    }

    const tx = txs[0];

    if (!isParticipant(tx, userId)) {
      return res.status(403).json({
        error: "Access denied.",
      });
    }

    const events = await db.query(
      `
SELECT
    te.*,
    u.name,
    u.email
FROM transaction_events te
LEFT JOIN users u
ON te.user_id = u.id
WHERE te.transaction_id = ?
ORDER BY te.created_at ASC
`,
      [transactionId],
    );

    res.json(events);
  } catch (error) {
    next(error);
  }
});

// 4. PATCH /:id/status - Update transaction status
router.patch("/:id/status", async (req, res, next) => {
  const transactionId = req.params.id;
  const { status, action, ai_audit_note } = req.body;

  const nextStatus = status || ACTION_STATUS_MAP[action];

  if (!nextStatus) {
    return res.status(400).json({
      error: "Status or action is required.",
    });
  }

  if (!ALLOWED_TRANSACTION_STATUSES.includes(nextStatus)) {
    return res.status(400).json({
      error: "Invalid transaction status.",
    });
  }
  const userId = req.user.id;

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // Check transaction existence & access permission. Lock the row so
    // concurrent status changes (e.g. two simultaneous "complete" calls)
    // can't race each other.
    const [txs] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [transactionId],
    );
    if (txs.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Transaction not found." });
    }

    const tx = txs[0];
    const previousStatus = tx.status;

    if (previousStatus === TRANSACTION_STATUS.DISPUTED) {
      return rollbackWithError(conn, res, 400, "Transaction is currently under dispute.");
    }

    if (nextStatus === TRANSACTION_STATUS.INSPECTION && previousStatus === TRANSACTION_STATUS.INSPECTION) {
      return rollbackWithError(conn, res, 400, "Submission is currently under review.");
    }

    const requesterRole = participantRole(tx, userId);
    if (requesterRole === null) {
      return rollbackWithError(conn, res, 403, "Access denied.");
    }

    // Validate the transition is actually allowed before touching anything
    if (!canTransition(previousStatus, nextStatus)) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot transition transaction from "${previousStatus}" to "${nextStatus}".`,
      );
    }

    // Issue 4: role restriction on who may perform this specific transition
    const allowedRoles =
      TRANSACTION_TRANSITION_ROLES[`${previousStatus}:${nextStatus}`] || [];
    if (!allowedRoles.includes(requesterRole)) {
      return rollbackWithError(
        conn,
        res,
        403,
        `Only the ${allowedRoles.join(" or ")} can perform this transition.`,
      );
    }

    try {
      await updateTransactionStatus({
        conn,
        transaction: tx,
        userId,
        nextStatus,
        action,
      });

      // Maintain milestone submission and revision history on transaction status change
      const [txMilestones] = await conn.query(
        "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC FOR UPDATE",
        [tx.id]
      );
      const targetM = txMilestones.find(m => ["submitted", "inprogress", "rejected", "due", "pending", "paid", "upcoming"].includes(m.status)) || txMilestones[0];

      if (targetM) {
        if (nextStatus === TRANSACTION_STATUS.INSPECTION) {
          const { submission_data } = req.body;
          let valResult = { valid: true, data: null };
          if (submission_data !== undefined && submission_data !== null) {
            valResult = validateSubmissionData(submission_data, tx.category);
            if (!valResult.valid) {
              return rollbackWithError(conn, res, 400, valResult.message);
            }
          }

          const [subCount] = await conn.query(
            "SELECT COUNT(*) as cnt FROM milestone_submissions WHERE milestone_id = ?",
            [targetM.id]
          );
          const nextVer = (subCount[0]?.cnt || 0) + 1;
          const noteText = req.body.deliverable_note || req.body.note || targetM.deliverable_note || "Deliverable submitted for review";

          const parsedSubData = valResult.data;
          const subCategory = parsedSubData?.category
            ? normalizeCategory(parsedSubData.category)
            : (normalizeCategory(tx.category) || tx.category);
          const subDataJson = parsedSubData ? JSON.stringify(parsedSubData) : null;

          await conn.query(
            `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
            [tx.id, targetM.id, userId, nextVer, noteText, subCategory, subDataJson]
          );

          await conn.query(
            "UPDATE milestones SET status = 'submitted', deliverable_note = ? WHERE id = ?",
            [noteText, targetM.id]
          );
          await conn.query(
            "UPDATE revision_requests SET status = 'addressed' WHERE milestone_id = ? AND status = 'open'",
            [targetM.id]
          );
        } else if (nextStatus === TRANSACTION_STATUS.REVISION) {
          const reasonText = req.body.reason || "Revision Requested";
          const detailsText = req.body.details || req.body.deliverable_note || req.body.note || "Client requested changes to deliverable.";

          const [latestSubs] = await conn.query(
            "SELECT id FROM milestone_submissions WHERE milestone_id = ? ORDER BY version DESC LIMIT 1",
            [targetM.id]
          );
          const subId = latestSubs.length ? latestSubs[0].id : null;

          await conn.query(
            `INSERT INTO revision_requests (transaction_id, milestone_id, submission_id, requested_by, reason, details, status)
             VALUES (?, ?, ?, ?, ?, ?, 'open')`,
            [tx.id, targetM.id, subId, userId, reasonText, detailsText]
          );

          if (subId) {
            await conn.query("UPDATE milestone_submissions SET status = 'revision_requested' WHERE id = ?", [subId]);
          }

          await conn.query("UPDATE milestones SET status = 'rejected' WHERE id = ?", [targetM.id]);
        }
      }

      if (nextStatus === TRANSACTION_STATUS.INPROGRESS) {
        await lockScope(tx.id, conn);
      }

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: action || "status_changed",
        fromStatus: previousStatus,
        toStatus: nextStatus,
        note: ai_audit_note || req.body.deliverable_note || null,
      });
    } catch (err) {
      await conn.rollback();

      return res.status(400).json({
        error: err.message,
      });
    }

    // Re-read the transaction after the service has applied its update so
    // we're never acting on a stale, JS-side copy of the row (the row is
    // still locked by this connection's transaction, so this is safe).
    const [refreshedTxs] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [tx.id],
    );
    const currentTx = refreshedTxs[0];

    // If status becomes APPROVED or COMPLETED, release escrow funds to seller's wallet balance
    if (
      [TRANSACTION_STATUS.APPROVED, TRANSACTION_STATUS.COMPLETED].includes(nextStatus) &&
      previousStatus !== TRANSACTION_STATUS.COMPLETED
    ) {
      // Fetch milestones associated with transaction FOR UPDATE
      const [allMilestones] = await conn.query(
        "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC FOR UPDATE",
        [currentTx.id],
      );

      // Verify all milestones are completely paid into escrow before release can proceed
      const hasUnpaidMilestones = allMilestones.some(
        (m) =>
          m.status === MILESTONE_STATUS.PENDING ||
          m.status === MILESTONE_STATUS.UPCOMING ||
          m.status === MILESTONE_STATUS.DUE,
      );

      const totalEscrowFunded =
        parseFloat(currentTx.escrow_balance || 0) +
        parseFloat(currentTx.released_amount || 0);
      const totalTransactionAmount = parseFloat(currentTx.amount || 0);

      const allPaidIntoEscrow =
        !hasUnpaidMilestones &&
        (totalTransactionAmount <= 0 || totalEscrowFunded >= totalTransactionAmount - 0.01);

      if (!allPaidIntoEscrow) {
        return rollbackWithError(
          conn,
          res,
          400,
          "Accept & Release can only be completed when all milestones are fully paid into escrow.",
        );
      }

      const totalReleaseAmount = parseFloat(currentTx.escrow_balance || 0);

      if (totalReleaseAmount > 0) {
        const { wallet } = await releaseEscrow({
          conn,
          transaction: currentTx,
          recipientId: currentTx.seller_id,
          amount: totalReleaseAmount,
        });

        await logTransactionEvent({
          conn,
          transactionId: currentTx.id,
          userId,
          action: "full_escrow_released",
          note: `Released total escrow balance (${totalReleaseAmount}) to seller balance`,
          metadata: {
            sellerId: currentTx.seller_id,
            walletId: wallet.id,
            amount: totalReleaseAmount,
          },
        });
      }

      await conn.query("UPDATE milestones SET status = ? WHERE transaction_id = ?", [
        MILESTONE_STATUS.APPROVED,
        currentTx.id,
      ]);

      await conn.query("UPDATE transactions SET status = ? WHERE id = ?", [
        TRANSACTION_STATUS.COMPLETED,
        currentTx.id,
      ]);
    }

    await conn.commit();

    // Send notifications after commit
    const notifyRole = (roleId, type, data) => {
      notify({
        userId: roleId,
        type,
        data,
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    };

    if (nextStatus === TRANSACTION_STATUS.COMPLETED) {
      notifyRole(tx.buyer_id, NOTIFICATION_TYPE.TRANSACTION_COMPLETED, {
        transaction: tx.title,
      });
      notifyRole(tx.seller_id, NOTIFICATION_TYPE.TRANSACTION_COMPLETED, {
        transaction: tx.title,
      });

      const releaseAmount = parseFloat(currentTx.escrow_balance || 0);
      notifyRole(tx.seller_id, NOTIFICATION_TYPE.WALLET_FUNDED, {
        amount: releaseAmount.toFixed(2),
        balance: (
          parseFloat(currentTx.released_amount || 0) + releaseAmount
        ).toFixed(2),
      });
    } else {
      notifyRole(tx.buyer_id, NOTIFICATION_TYPE.TRANSACTION_STATUS_CHANGED, {
        transaction: tx.title,
        status: nextStatus,
        fromStatus: previousStatus,
        note: ai_audit_note || "",
      });
      notifyRole(tx.seller_id, NOTIFICATION_TYPE.TRANSACTION_STATUS_CHANGED, {
        transaction: tx.title,
        status: nextStatus,
        fromStatus: previousStatus,
        note: ai_audit_note || "",
      });

      if (
        nextStatus === TRANSACTION_STATUS.INPROGRESS &&
        previousStatus === TRANSACTION_STATUS.FUNDED
      ) {
        notifyRole(tx.buyer_id, NOTIFICATION_TYPE.TRANSACTION_STARTED, {
          transaction: tx.title,
        });
      }
    }

    res.json({
      message: "Transaction updated successfully.",
      status: nextStatus,
      action,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 5. POST /:id/milestones - Add a milestone to a transaction
router.post("/:id/milestones", async (req, res, next) => {
  const transactionId = req.params.id;
  const { title, amount } = req.body;
  const userId = req.user.id;

  if (!title || !amount) {
    return res.status(400).json({ error: "Title and amount are required." });
  }

  const cleanTitle = title.trim();
  if (!cleanTitle) {
    return res.status(400).json({ error: "Title cannot be empty." });
  }
  // Issue 7: cap title length
  if (cleanTitle.length > MAX_TITLE_LENGTH) {
    return res.status(400).json({
      error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    });
  }

  const milestoneAmount = parseFloat(amount);
  if (isNaN(milestoneAmount) || milestoneAmount <= 0) {
    return res.status(400).json({
      error: "Milestone amount must be greater than zero.",
    });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    // Lock the transaction row FOR UPDATE. Without this, two concurrent
    // "add milestone" requests can both read the same "used amount" sum
    // before either commits, letting the combined milestone total exceed
    // tx.amount (race condition).
    const [txs] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [transactionId],
    );

    if (txs.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Transaction not found." });
    }

    const tx = txs[0];

    if (!isParticipant(tx, userId)) {
      return rollbackWithError(conn, res, 403, "Access denied.");
    }

    // Issue 3: only the buyer defines/funds scope, so only the buyer may
    // add milestones (assumption - adjust if sellers should be able to
    // propose milestones subject to buyer approval instead).
    if (tx.buyer_id !== userId) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the buyer can add milestones.",
      );
    }

    // Milestones can't be added once the transaction is finished or cancelled
    if (
      [TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.CANCELLED].includes(
        tx.status,
      )
    ) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot add milestones to a ${tx.status} transaction.`,
      );
    }

    // Milestones can't be added once funding has begun
    const [paidCheck] = await conn.query(
      "SELECT COUNT(*) as cnt FROM milestones WHERE transaction_id = ? AND status = ?",
      [transactionId, MILESTONE_STATUS.PAID],
    );
    if (paidCheck[0].cnt > 0) {
      return rollbackWithError(
        conn,
        res,
        400,
        "Cannot add milestones after funding has begun.",
      );
    }

    const [existing] = await conn.query(
      "SELECT COALESCE(SUM(amount),0) total FROM milestones WHERE transaction_id=?",
      [transactionId],
    );

    const usedAmount = parseFloat(existing[0].total);

    if (usedAmount + milestoneAmount > parseFloat(tx.amount)) {
      return rollbackWithError(
        conn,
        res,
        400,
        "Milestones exceed transaction amount.",
      );
    }

    await conn.query(
      "INSERT INTO milestones (transaction_id, title, amount, status) VALUES (?, ?, ?, ?)",
      [transactionId, cleanTitle, milestoneAmount, MILESTONE_STATUS.PENDING],
    );

    await conn.query(
      "UPDATE transactions SET milestones_count = milestones_count + 1 WHERE id = ?",
      [transactionId],
    );

    await logTransactionEvent({
      conn,
      transactionId,
      userId,
      action: "milestone_added",
      note: `Added milestone "${cleanTitle}"`,
      metadata: {
        title: cleanTitle,
        amount: milestoneAmount,
      },
    });

    await conn.commit();

    res.status(201).json({
      message: "Milestone added successfully.",
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 6. PATCH /milestones/:id/status - Update milestone status
router.patch("/milestones/:id/status", async (req, res, next) => {
  const milestoneId = req.params.id;
  const { status, deliverable_note, submission_data } = req.body;
  const userId = req.user.id;

  if (!status) {
    return res.status(400).json({
      error: "Status is required.",
    });
  }

  // "pending", "due" and "paid" are system-managed and can never be set
  // directly through this endpoint.
  if (!MANUAL_MILESTONE_STATUSES.includes(status)) {
    return res.status(400).json({
      error:
        status === MILESTONE_STATUS.PENDING ||
        status === MILESTONE_STATUS.DUE ||
        status === MILESTONE_STATUS.PAID
          ? `Status "${status}" cannot be set manually.`
          : "Invalid milestone status.",
    });
  }

  if (
    deliverable_note !== undefined &&
    deliverable_note !== null &&
    String(deliverable_note).length > MAX_DELIVERABLE_NOTE_LENGTH
  ) {
    return res.status(400).json({
      error: `Deliverable note must be ${MAX_DELIVERABLE_NOTE_LENGTH} characters or fewer.`,
    });
  }

  // Issue 6: trim whitespace and treat a whitespace-only note as if none
  // was provided at all, so " " can't slip through as "evidence".
  const deliverableNote =
    typeof deliverable_note === "string" && deliverable_note.trim() !== ""
      ? deliverable_note.trim()
      : undefined;

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    // Lock the milestone row FOR UPDATE. Without this, two concurrent
    // requests (e.g. two "approve" clicks, or a "submit" racing an
    // "approve") can both read the same starting status and both pass the
    // transition check below before either commits.
    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? FOR UPDATE",
      [milestoneId],
    );

    if (milestones.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        error: "Milestone not found.",
      });
    }

    const milestone = milestones[0];

    // Lock the parent transaction too (Issue 2). Previously only the
    // milestone row was locked, so a concurrent change on the transaction
    // itself (e.g. it being cancelled) could interleave with this
    // milestone update instead of being serialized against it.
    const [txs] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [milestone.transaction_id],
    );

    if (txs.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        error: "Transaction not found.",
      });
    }

    const tx = txs[0];

    if (!isParticipant(tx, userId)) {
      return rollbackWithError(conn, res, 403, "Access denied.");
    }

    // Freeze milestone updates if transaction is disputed or completed/cancelled
    if (tx.status === TRANSACTION_STATUS.DISPUTED) {
      return rollbackWithError(conn, res, 400, "Transaction is currently under dispute.");
    }

    if ([TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.CANCELLED].includes(tx.status)) {
      return rollbackWithError(conn, res, 400, `Transaction is already ${tx.status}.`);
    }

    // Prevent provider resubmitting while currently under review
    if (status === MILESTONE_STATUS.SUBMITTED && tx.status === TRANSACTION_STATUS.INSPECTION && milestone.status === MILESTONE_STATUS.SUBMITTED) {
      return rollbackWithError(conn, res, 400, "Submission is currently under review.");
    }

    // Prevent double approval
    if (status === MILESTONE_STATUS.APPROVED && milestone.status === MILESTONE_STATUS.APPROVED) {
      return rollbackWithError(conn, res, 400, "Milestone has already been approved.");
    }

    // Validate the transition is actually allowed from the milestone's current status
    const allowedNext = ALLOWED_MILESTONE_TRANSITIONS[milestone.status] || [];
    if (!allowedNext.includes(status)) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot transition milestone from "${milestone.status}" to "${status}".`,
      );
    }

    if (status === MILESTONE_STATUS.SUBMITTED && milestone.deliverable_note && milestone.status !== MILESTONE_STATUS.REJECTED) {
      return rollbackWithError(
        conn,
        res,
        400,
        "This milestone already has a submitted deliverable and cannot be resubmitted.",
      );
    }

    // Only the seller may submit a deliverable
    if (status === MILESTONE_STATUS.SUBMITTED && userId !== tx.seller_id) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the seller can submit a milestone.",
      );
    }

    // Only the buyer may approve or reject a submitted milestone
    if (
      [MILESTONE_STATUS.APPROVED, MILESTONE_STATUS.REJECTED].includes(status) &&
      userId !== tx.buyer_id
    ) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the buyer can approve or reject a milestone.",
      );
    }

    // Require all milestones to be fully paid into escrow before releasing funds to provider
    if (status === MILESTONE_STATUS.APPROVED) {
      const [allTxMilestones] = await conn.query(
        "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC FOR UPDATE",
        [tx.id]
      );
      const hasUnfundedMilestones = allTxMilestones.some(
        (m) => m.id !== parseInt(milestoneId) && !["paid", "approved"].includes(m.status)
      );

      const totalEscrowFunded = parseFloat(tx.escrow_balance || 0) + parseFloat(tx.released_amount || 0);
      const totalTransactionAmount = parseFloat(tx.amount || 0);

      const allPaidIntoEscrow = !hasUnfundedMilestones && (totalTransactionAmount <= 0 || totalEscrowFunded >= totalTransactionAmount - 0.01);

      if (!allPaidIntoEscrow) {
        return rollbackWithError(
          conn,
          res,
          400,
          "All milestones must be fully funded into escrow before releasing funds to the service provider."
        );
      }
    }

    // A deliverable note or submission_data may only be attached by the seller when submitting a milestone deliverable
    if ((deliverableNote || submission_data) && status === MILESTONE_STATUS.SUBMITTED && userId !== tx.seller_id) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the seller can upload a deliverable.",
      );
    }

    let valResult = { valid: true, data: null };
    if (status === MILESTONE_STATUS.SUBMITTED && submission_data !== undefined && submission_data !== null) {
      valResult = validateSubmissionData(submission_data, tx.category);
      if (!valResult.valid) {
        return rollbackWithError(conn, res, 400, valResult.message);
      }
    }

    const fields = [];
    const params = [];

    fields.push("status = ?");
    params.push(status);

    if (deliverableNote !== undefined) {
      fields.push("deliverable_note = ?");
      params.push(deliverableNote);
    }

    params.push(milestoneId);

    await conn.query(
      `UPDATE milestones SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );

    // Save milestone submission or revision request to dedicated history tables
    if (status === MILESTONE_STATUS.SUBMITTED) {
      const [subCount] = await conn.query(
        "SELECT COUNT(*) as cnt FROM milestone_submissions WHERE milestone_id = ?",
        [milestoneId]
      );
      const nextVer = (subCount[0]?.cnt || 0) + 1;
      const noteText = deliverableNote || milestone.deliverable_note || "Deliverable submitted for review";

      const parsedSubData = valResult.data;
      const subCategory = parsedSubData?.category
        ? normalizeCategory(parsedSubData.category)
        : (normalizeCategory(tx.category) || tx.category);
      const subDataJson = parsedSubData ? JSON.stringify(parsedSubData) : null;

      await conn.query(
        `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
        [tx.id, milestoneId, userId, nextVer, noteText, subCategory, subDataJson]
      );

      await conn.query(
        "UPDATE revision_requests SET status = 'addressed' WHERE milestone_id = ? AND status = 'open'",
        [milestoneId]
      );

      if (tx.status !== TRANSACTION_STATUS.INSPECTION) {
        await conn.query("UPDATE transactions SET status = ? WHERE id = ?", [
          TRANSACTION_STATUS.INSPECTION,
          tx.id,
        ]);
      }
    } else if (status === MILESTONE_STATUS.REJECTED) {
      const reasonText = req.body.reason || "Revision Requested";
      const detailsText = req.body.details || deliverableNote || "Client requested changes to milestone deliverable.";

      const [latestSubs] = await conn.query(
        "SELECT id FROM milestone_submissions WHERE milestone_id = ? ORDER BY version DESC LIMIT 1",
        [milestoneId]
      );
      const subId = latestSubs.length ? latestSubs[0].id : null;

      await conn.query(
        `INSERT INTO revision_requests (transaction_id, milestone_id, submission_id, requested_by, reason, details, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [tx.id, milestoneId, subId, userId, reasonText, detailsText]
      );

      if (subId) {
        await conn.query("UPDATE milestone_submissions SET status = 'revision_requested' WHERE id = ?", [subId]);
      }

      await conn.query("UPDATE transactions SET status = ? WHERE id = ?", [
        TRANSACTION_STATUS.REVISION,
        tx.id,
      ]);
    } else if (status === MILESTONE_STATUS.APPROVED) {
      await conn.query(
        "UPDATE milestone_submissions SET status = 'approved' WHERE milestone_id = ? AND status = 'submitted'",
        [milestoneId]
      );
    }

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId,
      action: "milestone_status_changed",
      note: `Milestone "${milestone.title}" changed to ${status}`,
      metadata: {
        milestoneId,
        status,
      },
    });

    if (deliverableNote) {
      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: "deliverable_uploaded",
        note: deliverableNote,
        metadata: {
          milestoneId,
        },
      });
    }

    let sellerWalletResult = null;
    let autoCompletedTransaction = false;

    if (status === MILESTONE_STATUS.APPROVED) {
      // 1. Release funds allocated for THIS milestone to seller wallet
      const milestoneAmount = parseFloat(milestone.amount || 0);
      const currentEscrow = parseFloat(tx.escrow_balance || 0);
      const releaseAmount = Math.min(currentEscrow, milestoneAmount);

      if (releaseAmount > 0) {
        sellerWalletResult = await releaseEscrow({
          conn,
          transaction: tx,
          recipientId: tx.seller_id,
          amount: releaseAmount,
        });

        await logTransactionEvent({
          conn,
          transactionId: tx.id,
          userId,
          action: "milestone_escrow_released",
          note: `Released escrow funds ($${releaseAmount}) for milestone "${milestone.title}" to provider balance`,
          metadata: {
            milestoneId,
            sellerId: tx.seller_id,
            amount: releaseAmount,
            walletId: sellerWalletResult.wallet.id,
          },
        });
      }

      // 2. Query all milestones for transaction to check if ALL required milestones are approved
      const [allMilestones] = await conn.query(
        "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC FOR UPDATE",
        [tx.id],
      );

      const allApproved = allMilestones.length > 0 && allMilestones.every((m) => m.status === MILESTONE_STATUS.APPROVED);

      if (allApproved) {
        // If final milestone approved, release any remaining escrow balance and mark COMPLETED
        const remainingEscrow = parseFloat(tx.escrow_balance || 0);
        if (remainingEscrow > 0) {
          const extraRelease = await releaseEscrow({
            conn,
            transaction: tx,
            recipientId: tx.seller_id,
            amount: remainingEscrow,
          });
          if (!sellerWalletResult) sellerWalletResult = extraRelease;
        }

        if (tx.status !== TRANSACTION_STATUS.COMPLETED) {
          await updateTransactionStatus({
            conn,
            transaction: tx,
            userId,
            nextStatus: TRANSACTION_STATUS.COMPLETED,
            action: "all_milestones_completed",
          });

          await logTransactionEvent({
            conn,
            transactionId: tx.id,
            userId,
            action: "transaction_completed",
            fromStatus: tx.status,
            toStatus: TRANSACTION_STATUS.COMPLETED,
            note: "All milestones approved and released. Transaction marked as completed.",
          });

          autoCompletedTransaction = true;
        }
      } else {
        // Multi-milestone project: keep transaction active ('inprogress')
        if (tx.status === TRANSACTION_STATUS.INSPECTION || tx.status === TRANSACTION_STATUS.AUDIT) {
          await conn.query("UPDATE transactions SET status = ? WHERE id = ?", [
            TRANSACTION_STATUS.INPROGRESS,
            tx.id,
          ]);
        }

        // Advance next milestone to 'upcoming' / 'due'
        const nextMilestone = allMilestones.find(
          (m) => m.status === MILESTONE_STATUS.PENDING
        );
        if (nextMilestone) {
          await conn.query("UPDATE milestones SET status = ? WHERE id = ?", [
            MILESTONE_STATUS.UPCOMING,
            nextMilestone.id,
          ]);
        }
      }
    }

    await conn.commit();

    // Send notifications after commit
    if (status === MILESTONE_STATUS.SUBMITTED) {
      notify({
        userId: tx.buyer_id,
        type: NOTIFICATION_TYPE.MILESTONE_SUBMITTED,
        data: {
          milestone: milestone.title,
          transaction: tx.title,
          note: deliverableNote || "",
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    } else if (status === MILESTONE_STATUS.APPROVED) {
      notify({
        userId: tx.seller_id,
        type: NOTIFICATION_TYPE.MILESTONE_APPROVED,
        data: {
          milestone: milestone.title,
          transaction: tx.title,
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));

      if (sellerWalletResult) {
        notify({
          userId: tx.seller_id,
          type: NOTIFICATION_TYPE.WALLET_FUNDED,
          data: {
            amount: parseFloat(milestone.amount).toFixed(2),
            balance: sellerWalletResult.balance.toFixed(2),
          },
          email: true,
          sms: true,
          push: true,
        }).catch((err) => console.error("Notification dispatch error:", err));
      }

      if (autoCompletedTransaction) {
        notify({
          userId: tx.buyer_id,
          type: NOTIFICATION_TYPE.TRANSACTION_COMPLETED,
          data: { transaction: tx.title },
          email: true,
          sms: true,
          push: true,
        }).catch((err) => console.error("Notification dispatch error:", err));

        notify({
          userId: tx.seller_id,
          type: NOTIFICATION_TYPE.TRANSACTION_COMPLETED,
          data: { transaction: tx.title },
          email: true,
          sms: true,
          push: true,
        }).catch((err) => console.error("Notification dispatch error:", err));
      }
    } else if (status === MILESTONE_STATUS.REJECTED) {
      notify({
        userId: tx.seller_id,
        type: NOTIFICATION_TYPE.MILESTONE_REJECTED,
        data: {
          milestone: milestone.title,
          transaction: tx.title,
          note: deliverableNote || "",
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    }

    res.json({
      message: "Milestone updated successfully.",
      status,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 7. POST /milestones/:id/pay - Pay a milestone using wallet balance
router.post("/milestones/:id/pay", async (req, res, next) => {
  const milestoneId = req.params.id;
  const userId = req.user.id;

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Get milestone details
    const [milestones] = await conn.query(
      "SELECT * FROM milestones WHERE id = ? FOR UPDATE",
      [milestoneId],
    );
    if (milestones.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Milestone not found." });
    }
    const milestone = milestones[0];

    // 2. Get transaction details
    const [txs] = await conn.query(
      "SELECT * FROM transactions WHERE id = ?  FOR UPDATE",
      [milestone.transaction_id],
    );
    if (txs.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Transaction not found." });
    }
    const tx = txs[0];

    // Milestones can't be paid on a transaction that's finished, cancelled,
    // or under dispute.
    if (
      [
        TRANSACTION_STATUS.COMPLETED,
        TRANSACTION_STATUS.CANCELLED,
        TRANSACTION_STATUS.DISPUTED,
      ].includes(tx.status)
    ) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot pay milestones for a ${tx.status} transaction.`,
      );
    }

    // 3. Verify user is the buyer
    if (tx.buyer_id !== userId) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the buyer can make milestone payments.",
      );
    }

    // 4. Verify status is not already paid
    if ([MILESTONE_STATUS.PAID, MILESTONE_STATUS.APPROVED].includes(milestone.status)) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Milestone is already paid or approved. Current status: ${milestone.status}`,
      );
    }

    // 5. Check buyer's wallet balance
    const amount = parseFloat(milestone.amount);

    const { wallet, balance: newBalance } = await fundEscrow({
      conn,
      transaction: tx,
      buyerId: userId,
      amount,
    });

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId,
      action: "wallet_debited",
      note: `Wallet debited by ${amount}`,
      metadata: {
        walletId: wallet.id,
        amount,
        balanceAfter: newBalance,
      },
    });

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId,
      action: "escrow_funded",
      note: "Funds placed into escrow",
      metadata: {
        amount,
        walletId: wallet.id,
      },
    });

    // 8. Update milestone status to 'paid'
    await conn.query("UPDATE milestones SET status = ? WHERE id = ?", [
      MILESTONE_STATUS.PAID,
      milestoneId,
    ]);

    if (tx.status === TRANSACTION_STATUS.PENDING) {
      await updateTransactionStatus({
        conn,
        transaction: tx,
        userId,
        nextStatus: TRANSACTION_STATUS.FUNDED,
        action: "escrow_funded",
      });

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: "transaction_activated",
        fromStatus: TRANSACTION_STATUS.PENDING,
        toStatus: TRANSACTION_STATUS.FUNDED,
        note: "First milestone funded.",
      });
    }

    await logTransactionEvent({
      conn,
      transactionId: tx.id,
      userId,
      action: "milestone_paid",
      note: `Paid milestone "${milestone.title}"`,
      metadata: {
        milestoneId,
        amount,
      },
    });

    // 9. Auto-set next milestone to 'due' if applicable
    const [allMilestones] = await conn.query(
      "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
      [tx.id],
    );

    const currentIdx = allMilestones.findIndex(
      (m) => m.id === parseInt(milestoneId),
    );
    if (currentIdx !== -1 && currentIdx + 1 < allMilestones.length) {
      const nextMilestone = allMilestones[currentIdx + 1];
      if (nextMilestone.status === MILESTONE_STATUS.PENDING) {
        await conn.query("UPDATE milestones SET status = ? WHERE id = ?", [
          MILESTONE_STATUS.UPCOMING,
          nextMilestone.id,
        ]);

        await logTransactionEvent({
          conn,
          transactionId: tx.id,
          userId,
          action: "next_milestone_due",
          note: `"${nextMilestone.title}" is now due`,
          metadata: {
            milestoneId: nextMilestone.id,
          },
        });

        // Notify buyer that the next milestone is now due
        notify({
          userId: tx.buyer_id,
          type: NOTIFICATION_TYPE.MILESTONE_DUE,
          data: {
            milestone: nextMilestone.title,
            transaction: tx.title,
          },
          email: true,
          sms: true,
          push: true,
        }).catch((err) => console.error("Notification dispatch error:", err));
      }
    }

    // If all milestones are now paid and the transaction is still FUNDED,
    // auto-advance to INPROGRESS so the seller can start work.
    // Failure here must NOT roll back the payment itself, so we catch
    // the error and log it rather than re-throwing.
    const [updatedMilestones] = await conn.query(
      "SELECT * FROM milestones WHERE transaction_id = ?",
      [tx.id],
    );
    const allPaid = updatedMilestones.every(
      (m) => m.status === MILESTONE_STATUS.PAID,
    );

    if (allPaid && tx.status === TRANSACTION_STATUS.FUNDED) {
      try {
        // Re-read the transaction so the service sees the FUNDED status that
        // updateTransactionStatus wrote in the PENDING→FUNDED step above.
        const [freshTxs] = await conn.query(
          "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
          [tx.id],
        );
        const freshTx = freshTxs[0];

        await updateTransactionStatus({
          conn,
          transaction: freshTx,
          userId,
          nextStatus: TRANSACTION_STATUS.INPROGRESS,
        });

        await logTransactionEvent({
          conn,
          transactionId: tx.id,
          userId,
          action: "all_milestones_funded",
          fromStatus: TRANSACTION_STATUS.FUNDED,
          toStatus: TRANSACTION_STATUS.INPROGRESS,
          note: "All milestones funded. Transaction moved to in-progress.",
        });
      } catch (advanceErr) {
        // Non-fatal: the payment succeeded — just surface the error loudly.
        console.error(
          `[milestones/pay] Failed to auto-advance transaction ${tx.id} to INPROGRESS:`,
          advanceErr,
        );
      }
    }

    await conn.commit();

    // Send notifications after payment commits
    notify({
      userId: tx.buyer_id,
      type: NOTIFICATION_TYPE.WALLET_WITHDRAWN,
      data: {
        amount: amount.toFixed(2),
        balance: newBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    notify({
      userId: tx.buyer_id,
      type: NOTIFICATION_TYPE.MILESTONE_PAID,
      data: {
        milestone: milestone.title,
        transaction: tx.title,
        amount: amount.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    notify({
      userId: tx.seller_id,
      type: NOTIFICATION_TYPE.TRANSACTION_FUNDED,
      data: {
        transaction: tx.title,
        amount: amount.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    res.json({ message: "Milestone payment successful.", balance: newBalance });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ///////////////////////////////////////////

// 8. POST /:id/dispute - File a dispute
router.post("/:id/dispute", async (req, res, next) => {
  const paramId = req.params.id;
  const { reason, evidence } = req.body;
  const userId = req.user.id;

  // Validate and trim reason before opening a DB connection.
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) {
    return res.status(400).json({ error: "Reason is required." });
  }
  if (cleanReason.length > MAX_DISPUTE_REASON_LENGTH) {
    return res.status(400).json({
      error: `Reason must be ${MAX_DISPUTE_REASON_LENGTH} characters or fewer.`,
    });
  }

  const cleanEvidence =
    evidence !== undefined && evidence !== null
      ? String(evidence).trim()
      : null;
  if (
    cleanEvidence !== null &&
    cleanEvidence.length > MAX_DISPUTE_EVIDENCE_LENGTH
  ) {
    return res.status(400).json({
      error: `Evidence must be ${MAX_DISPUTE_EVIDENCE_LENGTH} characters or fewer.`,
    });
  }

  // Resolve transaction ID (supports both numeric id and txn_code)
  const transactionId = await resolveTransactionId(paramId);
  if (transactionId === null) {
    return res.status(404).json({ error: "Transaction not found." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    const [transactions] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [transactionId],
    );

    if (!transactions.length) {
      return rollbackWithError(conn, res, 404, "Transaction not found.");
    }

    const transaction = transactions[0];

    if (!isParticipant(transaction, userId)) {
      return rollbackWithError(conn, res, 403, "Access denied.");
    }

    // Derive the disputable states from the state machine:
    // any status that has DISPUTED as a valid next state.
    const disputableStatuses = [
      TRANSACTION_STATUS.FUNDED,
      TRANSACTION_STATUS.INPROGRESS,
      TRANSACTION_STATUS.INSPECTION,
      TRANSACTION_STATUS.REVISION,
      TRANSACTION_STATUS.AUDIT,
    ];

    if (!disputableStatuses.includes(transaction.status)) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot file a dispute for a "${transaction.status}" transaction.`,
      );
    }

    const [existingDisputes] = await conn.query(
      `SELECT id FROM disputes
       WHERE transaction_id = ?
         AND status IN (?, ?)
       LIMIT 1`,
      [transaction.id, DISPUTE_STATUS.FILED, DISPUTE_STATUS.UNDER_REVIEW],
    );

    if (existingDisputes.length) {
      return rollbackWithError(
        conn,
        res,
        400,
        "A dispute has already been filed for this transaction.",
      );
    }

    const [result] = await conn.query(
      `INSERT INTO disputes (transaction_id, filed_by, reason, evidence)
       VALUES (?, ?, ?, ?)`,
      [transaction.id, userId, cleanReason, cleanEvidence || null],
    );

    const disputeId = result.insertId;

    await updateTransactionStatus({
      conn,
      transaction,
      userId,
      nextStatus: TRANSACTION_STATUS.DISPUTED,
    });

    await logTransactionEvent({
      conn,
      transactionId: transaction.id,
      userId,
      action: "dispute_filed",
      fromStatus: transaction.status,
      toStatus: TRANSACTION_STATUS.DISPUTED,
      note: cleanReason,
      metadata: { disputeId },
    });

    await conn.commit();

    notify({
      userId: transaction.buyer_id,
      type: NOTIFICATION_TYPE.DISPUTE_FILED,
      data: {
        transaction: transaction.title,
        reason: cleanReason,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    notify({
      userId: transaction.seller_id,
      type: NOTIFICATION_TYPE.DISPUTE_FILED,
      data: {
        transaction: transaction.title,
        reason: cleanReason,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    res.status(201).json({
      message: "Dispute filed successfully.",
      disputeId,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 9. GET /:id/dispute
router.get("/:id/dispute", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;

  try {
    const transactionId = await resolveTransactionId(paramId);

    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [
      transactionId,
    ]);

    if (!txs.length) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const transaction = txs[0];

    if (!isParticipant(transaction, userId)) {
      return res.status(403).json({ error: "Access denied." });
    }

    const disputes = await db.query(
      `SELECT d.*,
              u.name  AS filed_by_name,
              u.email AS filed_by_email
       FROM disputes d
       JOIN users u ON d.filed_by = u.id
       WHERE d.transaction_id = ?
       ORDER BY d.created_at DESC
       LIMIT 1`,
      [transaction.id],
    );

    if (!disputes.length) {
      return res
        .status(404)
        .json({ error: "No dispute found for this transaction." });
    }

    res.json(disputes[0]);
  } catch (error) {
    next(error);
  }
});

// 10. PATCH /:id/dispute/resolve  — Admin only
router.patch("/:id/dispute/resolve", async (req, res, next) => {
  // ── 1. Admin guard ─────────────────────────────────────────────────────────
  if ((req.user.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({
      error: "Access denied. Only admins can resolve disputes.",
    });
  }

  try {
    const result = await resolveDispute({
      disputeOrTxId: req.params.id,
      resolution: req.body.resolution,
      winner: req.body.winner,
      adminId: req.user.id,
    });
    return res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    next(error);
  }
});

// 12. POST /:id/review - Submit a review for a transaction
router.post("/:id/review", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;
  const { rating, comment } = req.body;

  try {
    // Resolve before opening a DB connection so we fail fast on a bad ID.
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [
      transactionId,
    ]);
    if (txs.length === 0) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const tx = txs[0];

    // 1. Participant guard — before exposing any detail.
    if (!isParticipant(tx, userId)) {
      return res.status(403).json({
        error: "Access denied. Only transaction participants can review.",
      });
    }

    // 2. Transaction must be COMPLETED.
    if (tx.status !== TRANSACTION_STATUS.COMPLETED) {
      return res.status(400).json({
        error:
          "Reviews can only be submitted after a transaction is completed.",
      });
    }

    const reviewer_id = userId;
    const reviewee_id = userId === tx.buyer_id ? tx.seller_id : tx.buyer_id;

    // 3. User cannot review themselves.
    if (reviewer_id === reviewee_id) {
      return res.status(400).json({ error: "You cannot review yourself." });
    }

    // 4. Validate rating (1–5, required).
    if (rating === undefined || rating === null) {
      return res.status(400).json({ error: "Rating is required." });
    }
    const ratingInt = parseInt(rating);
    if (isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
      return res
        .status(400)
        .json({ error: "Rating must be an integer between 1 and 5." });
    }

    // 5. Validate optional comment length.
    const cleanComment =
      comment !== undefined && comment !== null ? String(comment).trim() : null;
    if (
      cleanComment !== null &&
      cleanComment.length > MAX_REVIEW_COMMENT_LENGTH
    ) {
      return res.status(400).json({
        error: `Comment must be ${MAX_REVIEW_COMMENT_LENGTH} characters or fewer.`,
      });
    }

    // 6. Insert inside a transaction so the duplicate check (UNIQUE KEY) and
    //    the event log are atomic. Catch ER_DUP_ENTRY to return a clean 400
    //    instead of a 500 if two requests race.
    const conn = await db.getPool().getConnection();
    let insertedId;
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query(
        `INSERT INTO reviews (transaction_id, reviewer_id, reviewee_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [transactionId, reviewer_id, reviewee_id, ratingInt, cleanComment],
      );
      insertedId = insertResult.insertId;

      await logTransactionEvent({
        conn,
        transactionId,
        userId: reviewer_id,
        action: "review_submitted",
        note: `Review submitted by ${req.user.name || "User"} with rating ${ratingInt}`,
        metadata: {
          reviewId: insertedId,
          rating: ratingInt,
          comment: cleanComment,
          reviewer_id,
          reviewee_id,
        },
      });

      await conn.commit();

      notify({
        userId: reviewee_id,
        type: NOTIFICATION_TYPE.REVIEW_RECEIVED,
        data: {
          reviewer: req.user.name || "User",
          transaction: tx.title,
          rating: ratingInt,
          comment: cleanComment || "",
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    } catch (err) {
      await conn.rollback();
      // ER_DUP_ENTRY means the DB UNIQUE constraint caught a concurrent insert.
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({
          error: "You have already submitted a review for this transaction.",
        });
      }
      throw err;
    } finally {
      conn.release();
    }

    return res.status(201).json({
      message: "Review submitted successfully.",
      review: {
        transaction_id: transactionId,
        reviewer_id,
        reviewee_id,
        rating: ratingInt,
        comment: cleanComment,
      },
    });
  } catch (error) {
    next(error);
  }
});

// 13. GET /:id/review - Get reviews for a transaction (participants only)
router.get("/:id/review", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;

  try {
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    // Participant guard — load transaction before returning any review data.
    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [
      transactionId,
    ]);
    if (txs.length === 0) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    if (!isParticipant(txs[0], userId)) {
      return res.status(403).json({ error: "Access denied." });
    }

    const reviews = await db.query(
      `SELECT r.*,
              u_reviewer.name  AS reviewer_name,
              u_reviewer.email AS reviewer_email,
              u_reviewee.name  AS reviewee_name,
              u_reviewee.email AS reviewee_email
       FROM reviews r
       JOIN users u_reviewer ON r.reviewer_id = u_reviewer.id
       JOIN users u_reviewee ON r.reviewee_id = u_reviewee.id
       WHERE r.transaction_id = ?
       ORDER BY r.created_at DESC`,
      [transactionId],
    );

    return res.json(reviews);
  } catch (error) {
    next(error);
  }
});


// ─── Evidence File Upload ──────────────────────────────────────────────────
const __dirname_tx = path.dirname(fileURLToPath(import.meta.url));

const evidenceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname_tx, "../../uploads/evidence");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, uniqueName);
  },
});

const evidenceUpload = multer({
  storage: evidenceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
      "application/pdf",
      "application/zip", "application/x-zip-compressed",
      "text/plain", "text/markdown",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

/**
 * POST /api/transactions/evidence/upload
 * Upload a file as submission evidence. Returns a public URL.
 * Allowed: images (PNG/JPG/GIF/WebP/SVG), PDF, ZIP, TXT, Markdown
 */
router.post("/evidence/upload", evidenceUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    const publicUrl = `/uploads/evidence/${req.file.filename}`;
    return res.json({
      url: publicUrl,
      original_name: req.file.originalname,
      size: req.file.size,
      mime_type: req.file.mimetype,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
