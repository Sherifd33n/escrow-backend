import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import crypto from "crypto";
import { ACTION_STATUS_MAP } from "../core/transactionActionMap.js";
import { updateTransactionStatus } from "../services/transactionService.js";
import { logTransactionEvent } from "../services/transactionEventService.js";

const router = express.Router();

import { TRANSACTION_STATUS } from "../core/transactionStatus.js";

import { canTransition } from "../core/transactionStateMachine.js";

import { fundEscrow, releaseEscrow, refundEscrow } from "../services/walletService.js";

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

// Valid transaction statuses and the transitions permitted between them.
// Anything not listed as a valid "from -> to" pair is rejected.
const ALLOWED_TRANSACTION_STATUSES = Object.values(TRANSACTION_STATUS);

// ---------------------------------------------------------------------
const TRANSACTION_TRANSITION_ROLES = {
  [`${TRANSACTION_STATUS.PENDING}:${TRANSACTION_STATUS.ACTIVE}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.PENDING}:${TRANSACTION_STATUS.CANCELLED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.ACTIVE}:${TRANSACTION_STATUS.INPROGRESS}`]: [
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.ACTIVE}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.ACTIVE}:${TRANSACTION_STATUS.CANCELLED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.REVIEW}`]: [
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.INPROGRESS}:${TRANSACTION_STATUS.CANCELLED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.REVIEW}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.REVIEW}:${TRANSACTION_STATUS.DISPUTED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.REVIEW}:${TRANSACTION_STATUS.CANCELLED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
  ],
  [`${TRANSACTION_STATUS.DISPUTED}:${TRANSACTION_STATUS.COMPLETED}`]: [
    ROLE.BUYER,
  ],
  [`${TRANSACTION_STATUS.DISPUTED}:${TRANSACTION_STATUS.CANCELLED}`]: [
    ROLE.BUYER,
    ROLE.SELLER,
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
  [MILESTONE_STATUS.SUBMITTED]: [
    MILESTONE_STATUS.APPROVED,
    MILESTONE_STATUS.REJECTED,
  ],
};

const MAX_DELIVERABLE_NOTE_LENGTH = 5000;

// Issue 7: cap title length (transaction titles and milestone titles both
// use this field name/shape, so both are guarded by the same constant).
const MAX_TITLE_LENGTH = 200;

// Issue 10: reject absurd transaction amounts. Placeholder ceiling -
// adjust to whatever your actual business maximum is.
const MAX_TRANSACTION_AMOUNT = 1_000_000;

const CATEGORY_PATTERN = /^[a-zA-Z0-9 _-]{2,50}$/;

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
  if (!isNaN(Number(paramId))) {
    return Number(paramId);
  }
  const rows = await db.query(
    "SELECT id FROM transactions WHERE txn_code = ?",
    [paramId],
  );
  return rows.length ? rows[0].id : null;
}

// 1. GET / - List transactions for current user (either buyer or seller)
router.get("/", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const txs = await db.query(
      `SELECT t.*, 
              u_buyer.name as buyer_name, u_buyer.email as buyer_email,
              u_seller.name as seller_name, u_seller.email as seller_email
       FROM transactions t
       JOIN users u_buyer ON t.buyer_id = u_buyer.id
       JOIN users u_seller ON t.seller_id = u_seller.id
       WHERE t.buyer_id = ? OR t.seller_id = ?
       ORDER BY t.created_at DESC`,
      [userId, userId],
    );

    if (txs.length > 0) {
      const txIds = txs.map((t) => t.id);
      const milestones = await db.query(
        "SELECT * FROM milestones WHERE transaction_id IN (?) ORDER BY id ASC",
        [txIds],
      );
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
  } = req.body;
  const userId = req.user.id;

  if (!title || !category || !amount || !counterparty) {
    return res
      .status(400)
      .json({ error: "Missing required transaction fields." });
  }

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
  const count = milestones_count === undefined ? 1 : parseInt(milestones_count);
  if (isNaN(count) || count < 1) {
    return res.status(400).json({
      error: "Milestone count must be at least 1.",
    });
  }
  if (count > 100) {
    return res.status(400).json({
      error: "Maximum milestone count is 100.",
    });
  }

  // Validate review days (Issue 11: shared helper)
  const reviewDays = parseReviewDays(review_days);
  if (reviewDays === null) {
    return res.status(400).json({
      error: "Review days must be between 1 and 30.",
    });
  }

  // Issue 9: normalize once and reuse the same value for both the lookup
  // and any error message, instead of echoing the raw, un-normalized input.
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
    let attempts = 0;
    let inserted = false;
    while (!inserted) {
      attempts++;
      const txnCode = `TXN-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
      try {
        const [txnResult] = await conn.query(
          `INSERT INTO transactions 
           (txn_code, title, category, amount, currency, buyer_id, seller_id, status, review_days, milestones_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            txnCode,
            cleanTitle,
            cleanCategory,
            parsedAmount,
            normalizedCurrency,
            buyerId,
            sellerId,
            TRANSACTION_STATUS.PENDING,
            reviewDays,
            count,
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

      await conn.query(
        `INSERT INTO milestones
    (transaction_id,title,amount,status)
    VALUES (?,?,?,?)`,
        [
          transactionId,
          `Milestone ${i} of ${count}`,
          currentAmount,
          i === 1 ? MILESTONE_STATUS.DUE : MILESTONE_STATUS.PENDING,
        ],
      );
    }

    await conn.commit();

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

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: action || "status_changed",
        fromStatus: previousStatus,
        toStatus: nextStatus,
        note: ai_audit_note || null,
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

    // If status becomes completed, simulate payout from buyer to seller
    if (
      nextStatus === TRANSACTION_STATUS.COMPLETED &&
      previousStatus !== TRANSACTION_STATUS.COMPLETED
    ) {
      const releaseAmount = parseFloat(currentTx.escrow_balance || 0);

      if (releaseAmount <= 0) {
        return rollbackWithError(
          conn,
          res,
          400,
          "There are no escrow funds available for release.",
        );
      }

      const { wallet } = await releaseEscrow({
        conn,
        transaction: currentTx,
        recipientId: currentTx.seller_id,
        amount: releaseAmount,
      });

      await logTransactionEvent({
        conn,
        transactionId: currentTx.id,
        userId,
        action: "escrow_released",
        note: `Released ${releaseAmount} to seller`,
        metadata: {
          sellerId: currentTx.seller_id,
          walletId: wallet.id,
          amount: releaseAmount,
        },
      });
    }

    await conn.commit();

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
  const { status, deliverable_note } = req.body;
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

    // Validate the transition is actually allowed from the milestone's
    // current status (approved/rejected/pending/paid/due are all locked
    // except for the explicit "due -> submitted -> approved/rejected" path)
    const allowedNext = ALLOWED_MILESTONE_TRANSITIONS[milestone.status] || [];
    if (!allowedNext.includes(status)) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Cannot transition milestone from "${milestone.status}" to "${status}".`,
      );
    }

    // Issue 5: submissions are immutable - a milestone that already has a
    // deliverable note attached can't have it silently replaced. (In
    // practice the transition table above already blocks re-submission
    // since "submitted" only reaches here from "due", but this guards
    // against that invariant changing later.)
    if (status === MILESTONE_STATUS.SUBMITTED && milestone.deliverable_note) {
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

    // A deliverable note may only be attached by the seller, when submitting
    if (deliverableNote && userId !== tx.seller_id) {
      return rollbackWithError(
        conn,
        res,
        403,
        "Only the seller can upload a deliverable.",
      );
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

    await conn.commit();

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
    if (milestone.status !== MILESTONE_STATUS.DUE) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Only milestones in "due" status can be paid. Current status: ${milestone.status}`,
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
        nextStatus: TRANSACTION_STATUS.ACTIVE,
        action: "escrow_funded",
      });

      await logTransactionEvent({
        conn,
        transactionId: tx.id,
        userId,
        action: "transaction_activated",
        fromStatus: TRANSACTION_STATUS.PENDING,
        toStatus: TRANSACTION_STATUS.ACTIVE,
        note: "First milestone funded. Escrow is now active.",
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
      if (
        nextMilestone.status === MILESTONE_STATUS.PENDING ||
        nextMilestone.status === MILESTONE_STATUS.UPCOMING
      ) {
        await conn.query("UPDATE milestones SET status = ? WHERE id = ?", [
          MILESTONE_STATUS.DUE,
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
      }
    }

    // Check if all milestones are paid
    const [updatedMilestones] = await conn.query(
      "SELECT * FROM milestones WHERE transaction_id = ?",
      [tx.id],
    );
    const allPaid = updatedMilestones.every(
      (m) => m.status === MILESTONE_STATUS.PAID,
    );

    // // change" instead of two divergent code paths.
    // if (allPaid && tx.status === TRANSACTION_STATUS.ACTIVE) {
    //   try {
    //     await updateTransactionStatus({
    //       conn,
    //       transaction: tx,
    //       userId,
    //       nextStatus: TRANSACTION_STATUS.INPROGRESS,
    //       action: "all_milestones_funded",
    //     });

    //     await logTransactionEvent({
    //       conn,
    //       transactionId: tx.id,
    //       userId,
    //       action: "all_milestones_paid",
    //       fromStatus: tx.status,
    //       toStatus: TRANSACTION_STATUS.INPROGRESS,
    //       note: "All milestones have been funded",
    //     });
    //   } catch (err) {
    //     // The payment itself already succeeded at this point - don't let a
    //     // failure in the auto-advance step roll back a successful payment.
    //     // Surface it loudly instead of swallowing it silently.
    //     console.error(
    //       `Failed to auto-advance transaction ${tx.id} to "inprogress" after full funding:`,
    //       err,
    //     );
    //   }
    // }

    await conn.commit();
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
  const transactionId = req.params.id;
  const { reason, evidence } = req.body;
  const userId = req.user.id;

  if (!reason || !reason.trim()) {
    return res.status(400).json({
      error: "Reason is required.",
    });
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

    const disputableStatuses = [
      TRANSACTION_STATUS.ACTIVE,
      TRANSACTION_STATUS.INPROGRESS,
      TRANSACTION_STATUS.REVIEW,
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
      `
    SELECT id
    FROM disputes
    WHERE transaction_id = ?
      AND status IN ('filed', 'under_review')
    LIMIT 1
  `,
      [transaction.id],
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
      `
    INSERT INTO disputes
    (transaction_id, filed_by, reason, evidence)
    VALUES (?, ?, ?, ?)
  `,
      [
        transaction.id,
        userId,
        reason.trim(),
        evidence ? evidence.trim() : null,
      ],
    );

    const disputeId = result.insertId;

    await updateTransactionStatus({
      conn,
      transaction,
      userId,
      nextStatus: TRANSACTION_STATUS.DISPUTED,
      action: "dispute_filed",
    });

    await logTransactionEvent({
      conn,
      transactionId: transaction.id,
      userId,
      action: "dispute_filed",
      fromStatus: transaction.status,
      toStatus: TRANSACTION_STATUS.DISPUTED,
      note: reason.trim(),
      metadata: {
        disputeId,
      },
    });

    await conn.commit();

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
// 9. GET /:id/dispute
router.get("/:id/dispute", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;

  try {
    const transactionId = await resolveTransactionId(paramId);

    if (transactionId === null) {
      return res.status(404).json({
        error: "Transaction not found.",
      });
    }

    const [transactions] = await db
      .getPool()
      .query("SELECT * FROM transactions WHERE id = ?", [transactionId]);

    if (!transactions.length) {
      return res.status(404).json({
        error: "Transaction not found.",
      });
    }

    const transaction = transactions[0];

    if (!isParticipant(transaction, userId)) {
      return res.status(403).json({
        error: "Access denied.",
      });
    }

    const [disputes] = await db.getPool().query(
      `
      SELECT
        d.*,
        u.name AS filed_by_name,
        u.email AS filed_by_email
      FROM disputes d
      JOIN users u
        ON d.filed_by = u.id
      WHERE d.transaction_id = ?
      ORDER BY d.created_at DESC
      LIMIT 1
      `,
      [transaction.id],
    );

    if (!disputes.length) {
      return res.status(404).json({
        error: "No dispute found for this transaction.",
      });
    }

    res.json(disputes[0]);
  } catch (error) {
    next(error);
  }
});

// 10. PATCH /:id/dispute/resolve  — Admin only
router.patch("/:id/dispute/resolve", async (req, res, next) => {
  const paramId = req.params.id;
  const { resolution, winner } = req.body;
  const adminId = req.user.id;

  // ── 1. Admin guard ─────────────────────────────────────────────────────────
  if (req.user.role !== "admin") {
    return res.status(403).json({
      error: "Access denied. Only admins can resolve disputes.",
    });
  }

  // ── 2. Body validation (fail fast before opening a DB transaction) ─────────
  if (!resolution || !String(resolution).trim()) {
    return res.status(400).json({ error: "Resolution text is required." });
  }

  if (!["buyer", "seller"].includes(winner)) {
    return res
      .status(400)
      .json({ error: 'Winner must be either "buyer" or "seller".' });
  }

  const cleanResolution = String(resolution).trim();

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    // ── 3. Resolve transaction id (numeric id or txn_code) ──────────────────
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return rollbackWithError(conn, res, 404, "Transaction not found.");
    }

    // ── 4. Lock transaction row FOR UPDATE ───────────────────────────────────
    const [transactions] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [transactionId],
    );

    if (!transactions.length) {
      return rollbackWithError(conn, res, 404, "Transaction not found.");
    }

    const transaction = transactions[0];

    // ── 5. Verify transaction is currently DISPUTED ──────────────────────────
    if (transaction.status !== TRANSACTION_STATUS.DISPUTED) {
      return rollbackWithError(
        conn,
        res,
        400,
        `Transaction is not in disputed status. Current status: "${transaction.status}".`,
      );
    }

    // ── 6. Lock dispute row FOR UPDATE ───────────────────────────────────────
    const [disputes] = await conn.query(
      `
        SELECT *
        FROM disputes
        WHERE transaction_id = ?
          AND status IN ('filed', 'under_review')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [transaction.id],
    );

    if (!disputes.length) {
      return rollbackWithError(
        conn,
        res,
        404,
        "No active dispute found for this transaction.",
      );
    }

    const dispute = disputes[0];

    // ── 7. Prevent double-resolve ────────────────────────────────────────────
    //  (The query above already filters to filed/under_review, but this guard
    //   makes the rejection reason explicit for the caller.)
    if (dispute.status === "resolved") {
      return rollbackWithError(
        conn,
        res,
        409,
        "This dispute has already been resolved.",
      );
    }

    // ── 8. Validate escrow balance ───────────────────────────────────────────
    const escrowAmount = Number(transaction.escrow_balance);
    if (escrowAmount <= 0) {
      return rollbackWithError(
        conn,
        res,
        400,
        "Escrow balance is empty — cannot release or refund funds.",
      );
    }

    // ── 9. Move funds based on winner ────────────────────────────────────────
    let wallet;

    if (winner === "seller") {
      // Seller wins → release escrow to seller
      const result = await releaseEscrow({
        conn,
        transaction,
        recipientId: transaction.seller_id,
        amount: escrowAmount,
      });
      wallet = result.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_released",
        note: `Escrow of ${escrowAmount} released to seller (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          sellerId: transaction.seller_id,
          walletId: wallet.id,
          amount: escrowAmount,
        },
      });
    } else {
      // Buyer wins → refund escrow to buyer
      const result = await refundEscrow({
        conn,
        transaction,
        buyerId: transaction.buyer_id,
        amount: escrowAmount,
      });
      wallet = result.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_refunded",
        note: `Escrow of ${escrowAmount} refunded to buyer (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          buyerId: transaction.buyer_id,
          walletId: wallet.id,
          amount: escrowAmount,
        },
      });
    }

    // ── 10. Update dispute → resolved ────────────────────────────────────────
    await conn.query(
      `
        UPDATE disputes
        SET
          status     = 'resolved',
          resolution = ?,
          updated_at = NOW()
        WHERE id = ?
      `,
      [cleanResolution, dispute.id],
    );

    // ── 11. Update transaction status → COMPLETED ────────────────────────────
    //  Both paths (buyer wins / seller wins) close the escrow as COMPLETED.
    //  The state machine allows DISPUTED → COMPLETED.
    await conn.query(
      "UPDATE transactions SET status = ?, updated_at = NOW() WHERE id = ?",
      [TRANSACTION_STATUS.COMPLETED, transaction.id],
    );

    // ── 12. Log admin decision event ─────────────────────────────────────────
    await logTransactionEvent({
      conn,
      transactionId: transaction.id,
      userId: adminId,
      action: "dispute_resolved",
      fromStatus: TRANSACTION_STATUS.DISPUTED,
      toStatus: TRANSACTION_STATUS.COMPLETED,
      note: cleanResolution,
      metadata: {
        disputeId: dispute.id,
        winner,
        amount: escrowAmount,
        walletId: wallet.id,
        resolvedByAdmin: adminId,
      },
    });

    await conn.commit();

    return res.json({
      message: "Dispute resolved successfully.",
      winner,
      amountTransferred: escrowAmount,
      newTransactionStatus: TRANSACTION_STATUS.COMPLETED,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// 12. POST /:id/review - Submit a review for a transaction
router.post("/:id/review", async (req, res, next) => {
  const paramId = req.params.id;
  const userId = req.user.id;
  const { rating, comment } = req.body;

  try {
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const txs = await db.query("SELECT * FROM transactions WHERE id = ?", [transactionId]);
    if (txs.length === 0) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const tx = txs[0];

    // 1. Validate transaction is COMPLETED
    if (tx.status.toLowerCase() !== "completed") {
      return res.status(400).json({ error: "Reviews can only be submitted after a transaction is completed." });
    }

    // 2. Validate user is participant
    if (tx.buyer_id !== userId && tx.seller_id !== userId) {
      return res.status(403).json({ error: "Access denied. Only transaction participants can review." });
    }

    const reviewer_id = userId;
    const reviewee_id = userId === tx.buyer_id ? tx.seller_id : tx.buyer_id;

    // 3. User cannot review themselves
    if (reviewer_id === reviewee_id) {
      return res.status(400).json({ error: "You cannot review yourself." });
    }

    // 4. Validate rating (1-5, not empty)
    if (rating === undefined || rating === null) {
      return res.status(400).json({ error: "Rating is required." });
    }
    const ratingInt = parseInt(rating);
    if (isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
      return res.status(400).json({ error: "Rating must be an integer between 1 and 5." });
    }

    // 5. Prevent duplicate reviews
    const existing = await db.query(
      "SELECT id FROM reviews WHERE transaction_id = ? AND reviewer_id = ?",
      [transactionId, reviewer_id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: "You have already submitted a review for this transaction." });
    }

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      // Insert review
      const [insertResult] = await conn.query(
        `INSERT INTO reviews (transaction_id, reviewer_id, reviewee_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [transactionId, reviewer_id, reviewee_id, ratingInt, comment ? String(comment).trim() : null]
      );

      // Log transaction event
      await logTransactionEvent({
        conn,
        transactionId,
        userId: reviewer_id,
        action: "review_submitted",
        note: `Review submitted by ${req.user.name || "User"} with rating ${ratingInt}`,
        metadata: {
          reviewId: insertResult.insertId,
          rating: ratingInt,
          comment,
          reviewer_id,
          reviewee_id,
        },
      });

      await conn.commit();
    } catch (err) {
      await conn.rollback();
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
        comment,
      },
    });
  } catch (error) {
    next(error);
  }
});

// 13. GET /:id/review - Get reviews for a transaction
router.get("/:id/review", async (req, res, next) => {
  const paramId = req.params.id;

  try {
    const transactionId = await resolveTransactionId(paramId);
    if (transactionId === null) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const reviews = await db.query(
      `SELECT r.*,
              u_reviewer.name as reviewer_name, u_reviewer.email as reviewer_email,
              u_reviewee.name as reviewee_name, u_reviewee.email as reviewee_email
       FROM reviews r
       JOIN users u_reviewer ON r.reviewer_id = u_reviewer.id
       JOIN users u_reviewee ON r.reviewee_id = u_reviewee.id
       WHERE r.transaction_id = ?
       ORDER BY r.created_at DESC`,
      [transactionId]
    );

    return res.json(reviews);
  } catch (error) {
    next(error);
  }
});

export default router;

