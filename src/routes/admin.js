/**
 * routes/admin.js
 *
 * Admin-only routes.
 *
 * Mounted at: /api/admin
 *
 * Endpoints:
 *   GET    /dashboard            → platform-wide KPI stats
 *   GET    /transactions         → all transactions (paginated, filterable)
 *   GET    /users                → all users + aggregate stats (paginated)
 *   GET    /disputes             → list all disputes (newest first)
 *   GET    /disputes/:id         → single dispute detail
 *   PATCH  /disputes/:id/review  → move dispute filed → under_review
 */

import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import adminOnly from "../middleware/admin.js";
import { logTransactionEvent } from "../services/transactionEventService.js";

const router = express.Router();

// All admin routes require a valid JWT and admin role
router.use(authMiddleware);
router.use(adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/dashboard
// Returns platform-wide KPIs calculated live from the database.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res, next) => {
  try {
    const pool = db.getPool();

    // 1. Escrow balance currently locked across all active transactions
    const [escrowRow] = await pool.query(`
      SELECT COALESCE(SUM(escrow_balance), 0) AS total_escrow
      FROM transactions
      WHERE status NOT IN ('completed', 'cancelled')
    `);

    // 2. Active transaction count (any status that isn't terminal)
    const [activeTxRow] = await pool.query(`
      SELECT COUNT(*) AS active_transactions
      FROM transactions
      WHERE status NOT IN ('completed', 'cancelled')
    `);

    // 3. Open disputes (filed or under_review)
    const [openDisputeRow] = await pool.query(`
      SELECT COUNT(*) AS open_disputes
      FROM disputes
      WHERE status IN ('filed', 'under_review')
    `);

    // 4. Pending KYC submissions
    const [pendingKycRow] = await pool.query(`
      SELECT COUNT(*) AS pending_kyc
      FROM kyc_submissions
      WHERE status = 'pending'
    `);

    // 5. User breakdowns
    const [userStatsRows] = await pool.query(`
      SELECT
        COUNT(*) AS total_users,
        SUM(role = 'client')   AS total_clients,
        SUM(role = 'provider') AS total_providers,
        SUM(role = 'admin')    AS total_admins,
        SUM(is_verified = 1)   AS verified_users
      FROM users
    `);

    // 6. Completed / cancelled transaction counts
    const [terminalTxRows] = await pool.query(`
      SELECT
        SUM(status = 'completed')  AS completed_transactions,
        SUM(status = 'cancelled')  AS cancelled_transactions
      FROM transactions
    `);

    const us = userStatsRows[0] || {};
    const tt = terminalTxRows[0] || {};

    return res.json({
      totalEscrow:             parseFloat(escrowRow.total_escrow)               || 0,
      activeTransactions:      Number(activeTxRow.active_transactions)          || 0,
      openDisputes:            Number(openDisputeRow.open_disputes)             || 0,
      pendingKYC:              Number(pendingKycRow.pending_kyc)                || 0,
      totalUsers:              Number(us.total_users)                           || 0,
      totalClients:            Number(us.total_clients)                         || 0,
      totalProviders:          Number(us.total_providers)                       || 0,
      totalAdmins:             Number(us.total_admins)                          || 0,
      verifiedUsers:           Number(us.verified_users)                        || 0,
      completedTransactions:   Number(tt.completed_transactions)                || 0,
      cancelledTransactions:   Number(tt.cancelled_transactions)                || 0,
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/transactions
// Returns all platform transactions, newest first.
// Query params: ?page=1 &limit=20 &status=funded &search=alice
// ─────────────────────────────────────────────────────────────────────────────
router.get("/transactions", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset   = (pageNum - 1) * limitNum;

    const VALID_STATUSES = [
      "pending", "funded", "inprogress", "inspection",
      "audit", "approved", "revision", "completed", "disputed", "cancelled",
    ];

    const whereClauses = [];
    const queryParams  = [];

    if (status && VALID_STATUSES.includes(status)) {
      whereClauses.push("t.status = ?");
      queryParams.push(status);
    }

    if (search && search.trim()) {
      whereClauses.push(`(
        t.txn_code LIKE ?
        OR t.title  LIKE ?
        OR buyer.name  LIKE ?
        OR buyer.email LIKE ?
        OR seller.name  LIKE ?
        OR seller.email LIKE ?
      )`);
      const like = `%${search.trim()}%`;
      queryParams.push(like, like, like, like, like, like);
    }

    const whereSQL = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const rows = await db.query(
      `
      SELECT
        t.id,
        t.txn_code,
        t.title,
        t.category,
        t.amount,
        t.currency,
        t.escrow_balance,
        t.status,
        t.created_at,
        t.updated_at,

        buyer.id    AS buyer_id,
        buyer.name  AS buyer_name,
        buyer.email AS buyer_email,

        seller.id    AS seller_id,
        seller.name  AS seller_name,
        seller.email AS seller_email

      FROM transactions t
      JOIN users buyer  ON t.buyer_id  = buyer.id
      JOIN users seller ON t.seller_id = seller.id

      ${whereSQL}

      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...queryParams, limitNum, offset],
    );

    const [countRow] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM transactions t
      JOIN users buyer  ON t.buyer_id  = buyer.id
      JOIN users seller ON t.seller_id = seller.id
      ${whereSQL}
      `,
      queryParams,
    );

    const total = countRow ? Number(countRow.total) : 0;

    return res.json({
      data: rows,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// Returns all users with their wallet balance and a stats summary.
// Query params: ?page=1 &limit=20 &search=alice &role=client
// ─────────────────────────────────────────────────────────────────────────────
router.get("/users", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset   = (pageNum - 1) * limitNum;

    const VALID_ROLES = ["client", "provider", "admin"];

    const whereClauses = [];
    const queryParams  = [];

    if (role && VALID_ROLES.includes(role)) {
      whereClauses.push("u.role = ?");
      queryParams.push(role);
    }

    if (search && search.trim()) {
      whereClauses.push("(u.name LIKE ? OR u.email LIKE ?)");
      const like = `%${search.trim()}%`;
      queryParams.push(like, like);
    }

    const whereSQL = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const users = await db.query(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.is_verified AS verified,
        u.kyc_tier,
        u.created_at,
        COALESCE(w.balance, 0)  AS wallet_balance,
        COALESCE(w.currency, 'USD') AS wallet_currency,

        (SELECT ks.status FROM kyc_submissions ks
         WHERE ks.user_id = u.id
         ORDER BY ks.created_at DESC LIMIT 1) AS kyc_status

      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id

      ${whereSQL}

      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...queryParams, limitNum, offset],
    );

    // Aggregate stats (always over all users, not filtered)
    const [statsRow] = await db.query(`
      SELECT
        COUNT(*)                 AS total_users,
        SUM(role = 'client')    AS total_clients,
        SUM(role = 'provider')  AS total_providers,
        SUM(role = 'admin')     AS total_admins,
        SUM(is_verified = 1)    AS verified_users
      FROM users
    `);

    const [countRow] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM users u
      ${whereSQL}
      `,
      queryParams,
    );

    const total = countRow ? Number(countRow.total) : 0;
    const stats = statsRow || {};

    return res.json({
      data: users,
      stats: {
        totalUsers:    Number(stats.total_users)    || 0,
        totalClients:  Number(stats.total_clients)  || 0,
        totalProviders:Number(stats.total_providers)|| 0,
        totalAdmins:   Number(stats.total_admins)   || 0,
        verifiedUsers: Number(stats.verified_users) || 0,
      },
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Returns every dispute with dispute info, transaction info, buyer and seller.
// Newest first.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/disputes", async (req, res, next) => {
  try {
    // Optional filter by status e.g. ?status=filed
    const { status, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Build optional WHERE clause
    const whereClauses = [];
    const queryParams = [];

    const VALID_STATUSES = ["filed", "under_review", "resolved"];
    if (status && VALID_STATUSES.includes(status)) {
      whereClauses.push("d.status = ?");
      queryParams.push(status);
    }

    const whereSQL =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const disputes = await db.query(
      `
      SELECT
        d.id                   AS dispute_id,
        d.status               AS dispute_status,
        d.reason,
        d.resolution,
        d.created_at           AS dispute_created_at,
        d.updated_at           AS dispute_updated_at,

        t.id                   AS transaction_id,
        t.txn_code,
        t.title                AS transaction_title,
        t.amount               AS transaction_amount,
        t.currency,
        t.status               AS transaction_status,
        t.escrow_balance,
        t.created_at           AS transaction_created_at,

        buyer.id               AS buyer_id,
        buyer.name             AS buyer_name,
        buyer.email            AS buyer_email,

        seller.id              AS seller_id,
        seller.name            AS seller_name,
        seller.email           AS seller_email,

        filer.id               AS filed_by_id,
        filer.name             AS filed_by_name,
        filer.email            AS filed_by_email

      FROM disputes d
      JOIN transactions  t      ON d.transaction_id = t.id
      JOIN users         buyer  ON t.buyer_id        = buyer.id
      JOIN users         seller ON t.seller_id       = seller.id
      JOIN users         filer  ON d.filed_by        = filer.id

      ${whereSQL}

      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...queryParams, limitNum, offset],
    );

    // Total count for pagination metadata
    const [countRow] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM disputes d
      ${whereSQL}
      `,
      queryParams,
    );

    const total = countRow ? Number(countRow.total) : 0;

    return res.json({
      data: disputes,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/disputes/:id
// Returns one dispute with full detail:
//   transaction, buyer, seller, evidence, escrow balance,
//   milestones, transaction history, and buyer/seller wallet status.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/disputes/:id", async (req, res, next) => {
  const disputeId = req.params.id;

  if (isNaN(Number(disputeId))) {
    return res.status(400).json({ error: "Dispute id must be a number." });
  }

  try {
    // 1. Main dispute + transaction + buyer + seller
    const [disputes] = await db.getPool().query(
      `
      SELECT
        d.id                   AS dispute_id,
        d.status               AS dispute_status,
        d.reason,
        d.evidence,
        d.resolution,
        d.created_at           AS dispute_created_at,
        d.updated_at           AS dispute_updated_at,

        t.id                   AS transaction_id,
        t.txn_code,
        t.title                AS transaction_title,
        t.category,
        t.amount               AS transaction_amount,
        t.currency,
        t.status               AS transaction_status,
        t.escrow_balance,
        t.review_days,
        t.milestones_count,
        t.created_at           AS transaction_created_at,

        buyer.id               AS buyer_id,
        buyer.name             AS buyer_name,
        buyer.email            AS buyer_email,
        buyer.phone            AS buyer_phone,

        seller.id              AS seller_id,
        seller.name            AS seller_name,
        seller.email           AS seller_email,
        seller.phone           AS seller_phone,

        filer.id               AS filed_by_id,
        filer.name             AS filed_by_name,
        filer.email            AS filed_by_email

      FROM disputes d
      JOIN transactions  t      ON d.transaction_id = t.id
      JOIN users         buyer  ON t.buyer_id        = buyer.id
      JOIN users         seller ON t.seller_id       = seller.id
      JOIN users         filer  ON d.filed_by        = filer.id

      WHERE d.id = ?
      LIMIT 1
      `,
      [disputeId],
    );

    if (!disputes.length) {
      return res.status(404).json({ error: "Dispute not found." });
    }

    const dispute = disputes[0];
    const transactionId = dispute.transaction_id;

    // 2. Milestones for this transaction
    const [milestones] = await db.getPool().query(
      `
      SELECT *
      FROM milestones
      WHERE transaction_id = ?
      ORDER BY id ASC
      `,
      [transactionId],
    );

    // 3. Transaction event history
    const [events] = await db.getPool().query(
      `
      SELECT
        te.*,
        u.name  AS actor_name,
        u.email AS actor_email
      FROM transaction_events te
      LEFT JOIN users u ON te.user_id = u.id
      WHERE te.transaction_id = ?
      ORDER BY te.created_at ASC
      `,
      [transactionId],
    );

    // 4. Wallet status for both parties (balance snapshot)
    const [wallets] = await db.getPool().query(
      `
      SELECT
        w.user_id,
        w.balance,
        w.currency,
        w.updated_at
      FROM wallets w
      WHERE w.user_id IN (?, ?)
      `,
      [dispute.buyer_id, dispute.seller_id],
    );

    const buyerWallet =
      wallets.find((w) => w.user_id === dispute.buyer_id) || null;
    const sellerWallet =
      wallets.find((w) => w.user_id === dispute.seller_id) || null;

    return res.json({
      dispute: {
        id: dispute.dispute_id,
        status: dispute.dispute_status,
        reason: dispute.reason,
        evidence: dispute.evidence,
        resolution: dispute.resolution,
        filed_by: {
          id: dispute.filed_by_id,
          name: dispute.filed_by_name,
          email: dispute.filed_by_email,
        },
        created_at: dispute.dispute_created_at,
        updated_at: dispute.dispute_updated_at,
      },
      transaction: {
        id: dispute.transaction_id,
        txn_code: dispute.txn_code,
        title: dispute.transaction_title,
        category: dispute.category,
        amount: dispute.transaction_amount,
        currency: dispute.currency,
        status: dispute.transaction_status,
        escrow_balance: dispute.escrow_balance,
        review_days: dispute.review_days,
        milestones_count: dispute.milestones_count,
        created_at: dispute.transaction_created_at,
      },
      buyer: {
        id: dispute.buyer_id,
        name: dispute.buyer_name,
        email: dispute.buyer_email,
        phone: dispute.buyer_phone,
        wallet: buyerWallet,
      },
      seller: {
        id: dispute.seller_id,
        name: dispute.seller_name,
        email: dispute.seller_email,
        phone: dispute.seller_phone,
        wallet: sellerWallet,
      },
      milestones,
      history: events,
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/disputes/:id/review
// Move a dispute from filed → under_review.
// Idempotent: if already under_review, returns 409.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/disputes/:id/review", async (req, res, next) => {
  const disputeId = req.params.id;
  const adminId = req.user.id;

  if (isNaN(Number(disputeId))) {
    return res.status(400).json({ error: "Dispute id must be a number." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    // Lock dispute row
    const [disputes] = await conn.query(
      "SELECT * FROM disputes WHERE id = ? FOR UPDATE",
      [disputeId],
    );

    if (!disputes.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Dispute not found." });
    }

    const dispute = disputes[0];

    // Only allow filed → under_review
    if (dispute.status === "under_review") {
      await conn.rollback();
      return res.status(409).json({
        error: "Dispute is already under review.",
      });
    }

    if (dispute.status === "resolved") {
      await conn.rollback();
      return res.status(409).json({
        error: "Cannot move a resolved dispute back to under_review.",
      });
    }

    if (dispute.status !== "filed") {
      await conn.rollback();
      return res.status(400).json({
        error: `Cannot transition dispute from "${dispute.status}" to under_review.`,
      });
    }

    // Lock parent transaction row (prevents concurrent status changes)
    const [transactions] = await conn.query(
      "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
      [dispute.transaction_id],
    );

    if (!transactions.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Parent transaction not found." });
    }

    // Update dispute status
    await conn.query(
      `
      UPDATE disputes
      SET
        status     = 'under_review',
        updated_at = NOW()
      WHERE id = ?
      `,
      [disputeId],
    );

    // Log the admin action on the transaction event log
    await logTransactionEvent({
      conn,
      transactionId: dispute.transaction_id,
      userId: adminId,
      action: "dispute_under_review",
      note: `Admin moved dispute #${disputeId} to under_review.`,
      metadata: {
        disputeId: dispute.id,
        previousStatus: "filed",
        newStatus: "under_review",
        adminId,
      },
    });

    await conn.commit();

    return res.json({
      message: "Dispute moved to under_review.",
      disputeId: dispute.id,
      status: "under_review",
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/reviews
// View all reviews with optional filters: rating, user (ID or name/email), transaction (ID or code), date
// ─────────────────────────────────────────────────────────────────────────────
router.get("/reviews", async (req, res, next) => {
  try {
    const { rating, user, transaction, date } = req.query;

    const whereClauses = [];
    const queryParams = [];

    if (rating) {
      whereClauses.push("r.rating = ?");
      queryParams.push(parseInt(rating));
    }

    if (user) {
      const trimmedUser = String(user).trim();
      if (!isNaN(Number(trimmedUser))) {
        whereClauses.push("(r.reviewer_id = ? OR r.reviewee_id = ?)");
        queryParams.push(Number(trimmedUser), Number(trimmedUser));
      } else {
        whereClauses.push(`(
          u_reviewer.name LIKE ?
          OR u_reviewer.email LIKE ?
          OR u_reviewee.name LIKE ?
          OR u_reviewee.email LIKE ?
        )`);
        const pattern = `%${trimmedUser}%`;
        queryParams.push(pattern, pattern, pattern, pattern);
      }
    }

    if (transaction) {
      const trimmedTx = String(transaction).trim();
      if (!isNaN(Number(trimmedTx))) {
        whereClauses.push("r.transaction_id = ?");
        queryParams.push(Number(trimmedTx));
      } else {
        whereClauses.push("t.txn_code LIKE ?");
        queryParams.push(`%${trimmedTx}%`);
      }
    }

    if (date) {
      whereClauses.push("DATE(r.created_at) = ?");
      queryParams.push(date);
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const reviews = await db.query(
      `SELECT r.*,
              u_reviewer.name as reviewer_name, u_reviewer.email as reviewer_email,
              u_reviewee.name as reviewee_name, u_reviewee.email as reviewee_email,
              t.txn_code, t.title as transaction_title
       FROM reviews r
       JOIN users u_reviewer ON r.reviewer_id = u_reviewer.id
       JOIN users u_reviewee ON r.reviewee_id = u_reviewee.id
       JOIN transactions t ON r.transaction_id = t.id
       ${whereSQL}
       ORDER BY r.created_at DESC`,
      queryParams
    );

    return res.json(reviews);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/reviews/:id
// Admin can delete inappropriate reviews.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/reviews/:id", async (req, res, next) => {
  const reviewId = req.params.id;

  try {
    const reviews = await db.query("SELECT id FROM reviews WHERE id = ?", [reviewId]);
    if (reviews.length === 0) {
      return res.status(404).json({ error: "Review not found." });
    }

    await db.query("DELETE FROM reviews WHERE id = ?", [reviewId]);

    return res.json({ message: "Review deleted successfully." });
  } catch (error) {
    next(error);
  }
});

export default router;
