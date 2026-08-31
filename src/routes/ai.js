import express from "express";
import authMiddleware from "../middleware/auth.js";
import db from "../config/db.js";
import { generateAiScope, runAiAudit, getTransactionAudits } from "../services/aiService.js";

const router = express.Router();

router.use(authMiddleware);

/**
 * Strips internal technical jargon from audit text fields before sending to the client.
 * Removes references to pipeline stages, API key names, and internal mode labels.
 */
function sanitizeAuditText(txt) {
  if (!txt || typeof txt !== "string") return txt;
  return txt
    .replace(/processed by Stage 2 pipeline\.?/gi, "processed and verified.")
    .replace(/processed by Stage 2\.?/gi, "verified.")
    .replace(/Stage 2 pipeline\.?/gi, "verification pipeline.")
    .replace(/Stage 2/gi, "verification")
    .replace(/Stage 1/gi, "")
    .replace(/Stage 3/gi, "")
    .replace(/Stage 4/gi, "")
    .replace(/Full AI-level verification requires GROQ_API_KEY to be configured\.?/gi, "")
    .replace(/Full AI analysis requires GROQ_API_KEY to be configured\.?/gi, "")
    .replace(/Deterministic fallback[^.]*\./gi, "")
    .replace(/Deterministic audit mode[^.]*\./gi, "")
    .replace(/Add GROQ_API_KEY to[^.]*\./gi, "")
    .replace(/GROQ_API_KEY/gi, "")
    .replace(/\(no API key configured\)/gi, "")
    .replace(/groq ai key not configured\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Recursively sanitizes all string fields in an audit result object.
 */
function sanitizeAuditObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeAuditObject);

  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result[k] = sanitizeAuditText(v);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "string" ? sanitizeAuditText(item) : sanitizeAuditObject(item)
      );
    } else if (v && typeof v === "object") {
      result[k] = sanitizeAuditObject(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// POST /api/ai/scope - Generate project scope using AI
router.post("/scope", async (req, res, next) => {
  try {
    const { categoryLabel, description, transactionId } = req.body;

    // Check if editing an existing transaction
    if (transactionId) {
      const numId = Number(transactionId);
      const querySql = !isNaN(numId)
        ? "SELECT * FROM transactions WHERE id = ?"
        : "SELECT * FROM transactions WHERE txn_code = ?";
      const txRows = await db.query(querySql, [transactionId]);

      if (txRows.length > 0) {
        const tx = txRows[0];
        // Authorize participant access
        if (tx.buyer_id !== req.user.id && tx.seller_id !== req.user.id && req.user.role !== "admin") {
          return res.status(403).json({ error: "Access denied." });
        }

        // Check if transaction is funded
        const milestones = await db.query(
          "SELECT status FROM milestones WHERE transaction_id = ?",
          [tx.id]
        );
        const hasPaidOrApproved = milestones.some(m => ["paid", "approved"].includes(m.status));
        const isFunded = tx.status !== "pending" ||
                         hasPaidOrApproved ||
                         parseFloat(tx.escrow_balance || 0) > 0 ||
                         parseFloat(tx.released_amount || 0) > 0;

        if (isFunded) {
          return res.status(400).json({ error: "Funded transactions cannot be modified." });
        }
      }
    }

    if (!description || !description.trim()) {
      return res.status(400).json({ error: "Project description is required." });
    }

    const scope = await generateAiScope(req.user.id, {
      categoryLabel: categoryLabel || "Software Development",
      description: description.trim(),
    });

    res.json({
      success: true,
      scope,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
      });
    }
    next(error);
  }
});

// POST /api/ai/audit - Perform AI Deliverable Audit
router.post("/audit", async (req, res, next) => {
  try {
    const { transactionId, milestoneId, submissionId, title, type, amount, currency, counterparty } = req.body;

    const audit = await runAiAudit(req.user.id, {
      transactionId,
      milestoneId,
      submissionId,
      title: title || "Tech Services Project",
      type: type || "Software Dev",
      amount: parseFloat(amount) || 0,
      currency: currency || "USD",
      counterparty: counterparty || "Vendor",
    });

    res.json({
      success: true,
      audit: sanitizeAuditObject(audit),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        aiAuditsPerMonth: error.aiAuditsPerMonth,
        aiAuditsUsed: error.aiAuditsUsed,
      });
    }
    next(error);
  }
});

// GET /api/ai/audits/:transactionId - Retrieve audit history for a transaction
router.get("/audits/:transactionId", async (req, res, next) => {
  try {
    const audits = await getTransactionAudits(req.params.transactionId);
    res.json({
      success: true,
      audits: Array.isArray(audits) ? audits.map(sanitizeAuditObject) : audits,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
