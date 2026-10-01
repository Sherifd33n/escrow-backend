import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateWebhookConfig,
} from "../services/apiKeyService.js";
import { dispatchPartnerWebhook } from "../services/webhookDispatcherService.js";

const router = express.Router();

router.use(authMiddleware);

// GET /api/developer/keys - List all API keys for authenticated user
router.get("/", async (req, res, next) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({
      success: true,
      data: keys,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/developer/keys - Generate a new API key pair
router.post("/", async (req, res, next) => {
  try {
    const { name = "Default App", environment = "test" } = req.body;
    const newKey = await createApiKey(req.user.id, {
      name,
      environment: environment === "live" ? "live" : "test",
    });

    res.status(201).json({
      success: true,
      message: "API Key created successfully. Store your Secret Key safely!",
      data: newKey,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/developer/keys/:id - Revoke an API key
router.delete("/:id", async (req, res, next) => {
  try {
    const keyId = parseInt(req.params.id, 10);
    const result = await revokeApiKey(req.user.id, keyId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /api/developer/keys/:id/webhook - Configure Webhook URL
router.patch("/:id/webhook", async (req, res, next) => {
  try {
    const keyId = parseInt(req.params.id, 10);
    const { webhookUrl } = req.body;
    const result = await updateWebhookConfig(req.user.id, keyId, { webhookUrl });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/developer/keys/:id/test-webhook - Send test webhook event
router.post("/:id/test-webhook", async (req, res, next) => {
  try {
    const keyId = parseInt(req.params.id, 10);
    const keys = await listApiKeys(req.user.id);
    const targetKey = keys.find((k) => k.id === keyId);

    if (!targetKey || !targetKey.webhookUrl) {
      return res.status(400).json({
        success: false,
        error: "No webhook URL configured for this API Key.",
      });
    }

    const testPayload = {
      test: true,
      message: "This is a test ping from Lumbrr Escrow API.",
      partnerApp: targetKey.name,
      environment: targetKey.environment,
      sampleEscrow: {
        id: 9999,
        title: "Sample Escrow Deal",
        amount: 100.0,
        currency: "USD",
        status: "funded",
        escrowFeeAmount: 3.5,
      },
    };

    const dispatchResult = await dispatchPartnerWebhook({
      apiKeyId: targetKey.id,
      webhookUrl: targetKey.webhookUrl,
      webhookSecret: targetKey.webhookSecret,
      eventType: "ping.test",
      transactionId: null,
      data: testPayload,
    });

    res.json({
      success: true,
      message: "Test webhook dispatched.",
      result: dispatchResult,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
