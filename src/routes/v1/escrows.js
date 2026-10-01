import express from "express";
import multer from "multer";
import apiKeyAuth from "../../middleware/apiKeyAuth.js";
import { uploadFile } from "../../config/cloudinary.js";
import {
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
} from "../../services/b2bEscrowService.js";

const router = express.Router();

// Multer memory storage for evidence / attachment uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// Apply API Key authentication across all v1 escrow endpoints
router.use(apiKeyAuth);

// ─── PARTNER WALLET & BANKING ───────────────────────────────────

/**
 * GET /api/v1/escrows/wallet
 * Retrieve partner developer account wallet balance & details.
 */
router.get("/wallet", async (req, res, next) => {
  try {
    const result = await getPartnerWalletB2BEscrow(req.apiKey);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || "Failed to retrieve wallet balance." });
  }
});

/**
 * GET /api/v1/escrows/wallet/bank-accounts
 * List partner bank accounts configured for payouts.
 */
router.get("/wallet/bank-accounts", async (req, res, next) => {
  try {
    const result = await listBankAccountsB2BEscrow(req.apiKey);
    res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/escrows/wallet/bank-accounts
 * Add bank account for partner payouts.
 */
router.post("/wallet/bank-accounts", async (req, res, next) => {
  try {
    const result = await addBankAccountB2BEscrow(req.apiKey, req.body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/escrows/wallet/withdraw
 * Request payout / withdrawal from developer partner wallet.
 */
router.post("/wallet/withdraw", async (req, res, next) => {
  try {
    const result = await requestWithdrawalB2BEscrow(req.apiKey, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/escrows/wallet/withdrawals
 * List withdrawal transaction history for partner account.
 */
router.get("/wallet/withdrawals", async (req, res, next) => {
  try {
    const result = await listWithdrawalsB2BEscrow(req.apiKey);
    res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── AI SERVICES ────────────────────────────────────────────────

/**
 * POST /api/v1/escrows/ai/scope
 * AI Contract and Milestone Scope generation from prompt.
 */
router.post("/ai/scope", async (req, res, next) => {
  try {
    const result = await generateAiScopeB2BEscrow(req.apiKey, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── WEBHOOK LOGS & AUDIT ───────────────────────────────────────

/**
 * GET /api/v1/escrows/webhooks/deliveries
 * List recent partner webhook dispatch logs.
 */
router.get("/webhooks/deliveries", async (req, res, next) => {
  try {
    const result = await listWebhookDeliveriesB2BEscrow(req.apiKey, req.query);
    res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/escrows/webhooks/deliveries/:deliveryId/retry
 * Manually retry a webhook event delivery.
 */
router.post("/webhooks/deliveries/:deliveryId/retry", async (req, res, next) => {
  try {
    const result = await retryWebhookDeliveryB2BEscrow(req.apiKey, req.params.deliveryId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── EVIDENCE UPLOAD ────────────────────────────────────────────

/**
 * POST /api/v1/escrows/evidence/upload
 * Upload a document, image, or deliverable file as evidence.
 */
router.post("/evidence/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file provided in form-data ('file')." });
    }
    const publicUrl = await uploadFile(req.file, "evidence");
    res.status(201).json({
      success: true,
      data: {
        url: publicUrl,
        filename: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message || "Failed to upload evidence file.",
    });
  }
});

// ─── PAYMENT VERIFICATION ───────────────────────────────────────

/**
 * GET /api/v1/escrows/payments/verify/:reference
 * Check Paystack deposit payment status.
 */
router.get("/payments/verify/:reference", async (req, res, next) => {
  try {
    const result = await verifyPaymentB2BEscrow(req.apiKey, req.params.reference);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── CORE ESCROW TRANSACTIONS ───────────────────────────────────

/**
 * POST /api/v1/escrows
 * Create a new escrow transaction.
 */
router.post("/", async (req, res, next) => {
  try {
    const result = await createB2BEscrow(req.apiKey, req.body);
    res.status(201).json({
      success: true,
      message: "Escrow transaction created successfully.",
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message || "Failed to create escrow transaction.",
    });
  }
});

/**
 * GET /api/v1/escrows
 * List all escrow transactions created by this API Key.
 */
router.get("/", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const escrows = await listB2BEscrows(req.apiKey, {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      status,
      search,
    });
    res.json({
      success: true,
      count: escrows.length,
      data: escrows,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/v1/escrows/:id
 * Retrieve full details, milestones, scope, dispute, and real-time status.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const escrow = await getB2BEscrow(req.apiKey, req.params.id);
    res.json({
      success: true,
      data: escrow,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/payment-link
 * Generate or refresh payment link for buyer.
 */
router.post("/:id/payment-link", async (req, res, next) => {
  try {
    const result = await generatePaymentLinkB2BEscrow(req.apiKey, req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/v1/escrows/:id/status
 * Transition transaction status (e.g. inprogress, inspection, revision, approved, completed, disputed).
 */
router.patch("/:id/status", async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: "'status' field is required." });
    }
    const result = await updateEscrowStatusB2BEscrow(req.apiKey, req.params.id, { status, note });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/release
 * Release escrow funds to the seller upon satisfactory completion.
 */
router.post("/:id/release", async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const result = await releaseB2BEscrow(req.apiKey, req.params.id, { reason });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/cancel
 * Cancel an escrow deal and refund any deposited escrow balance back to buyer.
 */
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const result = await cancelB2BEscrow(req.apiKey, req.params.id, { reason });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ─── MILESTONES ─────────────────────────────────────────────────

/**
 * POST /api/v1/escrows/:id/milestones
 * Add a milestone to an existing pending deal.
 */
router.post("/:id/milestones", async (req, res, next) => {
  try {
    const result = await addMilestoneB2BEscrow(req.apiKey, req.params.id, req.body);
    res.status(201).json({
      success: true,
      message: "Milestone added successfully.",
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/v1/escrows/:id/milestones/:milestoneId
 * Update milestone details (title, description, amount) on a pending deal.
 */
router.patch("/:id/milestones/:milestoneId", async (req, res, next) => {
  try {
    const result = await updateMilestoneB2BEscrow(req.apiKey, req.params.id, req.params.milestoneId, req.body);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/v1/escrows/:id/milestones/:milestoneId
 * Delete a milestone from a pending deal.
 */
router.delete("/:id/milestones/:milestoneId", async (req, res, next) => {
  try {
    const result = await deleteMilestoneB2BEscrow(req.apiKey, req.params.id, req.params.milestoneId);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/milestones/:milestoneId/fund
 * Fund a specific milestone into escrow.
 */
router.post("/:id/milestones/:milestoneId/fund", async (req, res, next) => {
  try {
    const result = await fundMilestoneB2BEscrow(req.apiKey, req.params.id, req.params.milestoneId);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/v1/escrows/:id/milestones/:milestoneId/status
 * Submit milestone deliverable (status: submitted) or approve/reject deliverable.
 */
router.patch("/:id/milestones/:milestoneId/status", async (req, res, next) => {
  try {
    const { status, deliverableNote, deliverableUrl, deliverableFile, feedback } = req.body;
    const result = await updateMilestoneStatusB2BEscrow(
      req.apiKey,
      req.params.id,
      req.params.milestoneId,
      { status, deliverableNote, deliverableUrl, deliverableFile, feedback }
    );
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ─── SCOPE & CONTRACT ───────────────────────────────────────────

/**
 * GET /api/v1/escrows/:id/scope
 * Retrieve detailed deliverables, requirements, and contract terms.
 */
router.get("/:id/scope", async (req, res, next) => {
  try {
    const result = await getScopeB2BEscrow(req.apiKey, req.params.id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/v1/escrows/:id/scope
 * Update scope, acceptance criteria, deliverables, or revision policy for a pending deal.
 */
router.patch("/:id/scope", async (req, res, next) => {
  try {
    const result = await updateScopeB2BEscrow(req.apiKey, req.params.id, req.body);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/scope/request-changes
 * Request changes or revisions to the contract scope.
 */
router.post("/:id/scope/request-changes", async (req, res, next) => {
  try {
    const { proposedChanges, reason } = req.body;
    const result = await requestScopeChangesB2BEscrow(req.apiKey, req.params.id, { proposedChanges, reason });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ─── AI AUDITS ON DEAL ──────────────────────────────────────────

/**
 * POST /api/v1/escrows/:id/ai/audit
 * Run AI Deliverable Audit on milestone submission.
 */
router.post("/:id/ai/audit", async (req, res, next) => {
  try {
    const result = await runAiAuditB2BEscrow(req.apiKey, req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/escrows/:id/ai/audits
 * Retrieve AI Audits history for this deal.
 */
router.get("/:id/ai/audits", async (req, res, next) => {
  try {
    const result = await getAiAuditsB2BEscrow(req.apiKey, req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── DISPUTES & ARBITRATION ─────────────────────────────────────

/**
 * POST /api/v1/escrows/:id/dispute
 * Raise a formal dispute.
 */
router.post("/:id/dispute", async (req, res, next) => {
  try {
    const { reason, evidenceUrl, raisedByRole } = req.body;
    const result = await disputeB2BEscrow(req.apiKey, req.params.id, {
      reason,
      evidenceUrl,
      raisedByRole,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/v1/escrows/:id/dispute
 * Retrieve active or past dispute details, evidence, and resolution status.
 */
router.get("/:id/dispute", async (req, res, next) => {
  try {
    const result = await getDisputeB2BEscrow(req.apiKey, req.params.id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/v1/escrows/:id/dispute/resolve
 * Arbitrate and resolve dispute with settlement payout/refund.
 */
router.patch("/:id/dispute/resolve", async (req, res, next) => {
  try {
    const { resolution, winner, splitDetails } = req.body;
    const result = await resolveDisputeB2BEscrow(req.apiKey, req.params.id, {
      resolution,
      winner,
      splitDetails,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ─── HISTORY & REVIEWS ──────────────────────────────────────────

/**
 * GET /api/v1/escrows/:id/history
 * Retrieve full chronological audit trail and events.
 */
router.get("/:id/history", async (req, res, next) => {
  try {
    const result = await getTransactionHistoryB2BEscrow(req.apiKey, req.params.id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/escrows/:id/reviews
 * Submit rating (1-5) and feedback on a completed escrow transaction.
 */
router.post("/:id/reviews", async (req, res, next) => {
  try {
    const { rating, comment, reviewerRole } = req.body;
    const result = await createReviewB2BEscrow(req.apiKey, req.params.id, {
      rating,
      comment,
      reviewerRole,
    });
    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/v1/escrows/:id/reviews
 * List reviews submitted for an escrow transaction.
 */
router.get("/:id/reviews", async (req, res, next) => {
  try {
    const result = await getReviewsB2BEscrow(req.apiKey, req.params.id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
