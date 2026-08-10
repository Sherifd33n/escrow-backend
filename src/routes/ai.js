import express from "express";
import authMiddleware from "../middleware/auth.js";
import { generateAiScope, runAiAudit } from "../services/aiService.js";

const router = express.Router();

router.use(authMiddleware);

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
    const { transactionId, title, type, amount, currency, counterparty } = req.body;

    const audit = await runAiAudit(req.user.id, {
      transactionId,
      title: title || "Tech Services Project",
      type: type || "Software Dev",
      amount: parseFloat(amount) || 0,
      currency: currency || "USD",
      counterparty: counterparty || "Vendor",
    });

    res.json({
      success: true,
      audit,
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

export default router;
