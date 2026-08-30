import express from "express";
import authMiddleware from "../middleware/auth.js";
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
    const { categoryLabel, description } = req.body;
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
