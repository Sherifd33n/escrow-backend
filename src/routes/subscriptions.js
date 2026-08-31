import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  getUserEntitlements,
  PLAN_CONFIGS,
} from "../services/entitlementService.js";
import {
  activateSubscription,
  initiateSubscriptionPayment,
  verifyAndActivateSubscriptionPayment,
  cancelSubscription,
  cancelPendingDowngrade,
} from "../services/subscriptionService.js";
import paystackService from "../services/paystackService.js";

const router = express.Router();

// GET /plans - Return public subscription plan definitions and exact pricing
router.get("/plans", (req, res) => {
  const plans = Object.values(PLAN_CONFIGS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    tier: plan.tier,
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice, // Monthly equivalent for annual billing
    annualBilledTotal: plan.annualBilledTotal, // Full annual amount billed
    savingsPct: 20,
    maxEscrowUsd: plan.maxEscrowUsd,
    maxActiveDeals: plan.maxActiveDeals,
    escrowFeeRate: plan.escrowFeeRate,
    escrowFeePercentage: `${plan.escrowFeeRate * 100}%`,
    aiAuditsPerMonth: plan.aiAuditsPerMonth,
    requiredKycLevel: plan.requiredKycLevel,
    transactionHistoryMonths: plan.transactionHistoryMonths,
    apiCallsPerMonth: plan.apiCallsPerMonth,
    canUseMultiCurrency: plan.canUseMultiCurrency,
    canUseWhiteLabel: plan.canUseWhiteLabel,
    canGenerateUnlimitedContracts: plan.canGenerateUnlimitedContracts,
  }));

  res.json({
    success: true,
    plans,
  });
});

// POST /webhook - Paystack webhook for subscription charge events (server-to-server)
// Must be before authMiddleware so it remains publicly accessible to Paystack
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  // Verify Paystack webhook signature
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body;

  if (!paystackService.verifyWebhookSignature(rawBody, signature)) {
    console.error("[SubscriptionWebhook] Invalid webhook signature.");
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = typeof rawBody === "string" ? JSON.parse(rawBody) : (Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString("utf8")) : rawBody);
  } catch {
    return res.status(400).json({ error: "Malformed webhook payload" });
  }

  try {
    if (
      event &&
      event.event === "charge.success" &&
      event.data &&
      event.data.metadata?.purpose === "subscription"
    ) {
      const reference = event.data.reference;
      if (reference) {
        // userId=null because we derive it from the payment record — ownership already established
        await verifyAndActivateSubscriptionPayment(reference, null);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[SubscriptionWebhook] Processing error:", err.message);
    res.status(500).json({ error: "Webhook processing error" });
  }
});

// All following routes require authentication
router.use(authMiddleware);

// GET /current - Fetch user's current subscription & active plan details
router.get("/current", async (req, res, next) => {
  try {
    const entitlements = await getUserEntitlements(req.user.id);
    res.json({
      success: true,
      subscription: entitlements.subscription,
      kyc: entitlements.kyc,
      effectiveLevel: entitlements.effectiveLevel,
    });
  } catch (error) {
    next(error);
  }
});

// GET /entitlements - Fetch complete user entitlement matrix & usage counters
router.get("/entitlements", async (req, res, next) => {
  try {
    const entitlements = await getUserEntitlements(req.user.id);
    res.json({
      success: true,
      ...entitlements,
    });
  } catch (error) {
    next(error);
  }
});

// POST /initiate-payment - Initialise a Paystack payment for a subscription plan.
// Server calculates amount from PLAN_CONFIGS — client cannot supply a price.
// Returns an authorization_url for the frontend to redirect the user to Paystack.
router.post("/initiate-payment", async (req, res, next) => {
  try {
    const { planId, billingCycle } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "planId is required." });
    }

    const normalizedPlanId = planId.toLowerCase();
    if (!PLAN_CONFIGS[normalizedPlanId]) {
      return res.status(400).json({ error: "Invalid plan ID." });
    }

    const cycle = billingCycle === "annual" ? "annual" : "monthly";

    const session = await initiateSubscriptionPayment(
      req.user.id,
      normalizedPlanId,
      cycle,
      req.user.email
    );

    res.json({
      success: true,
      ...session,
    });
  } catch (error) {
    next(error);
  }
});

// POST /verify-payment/:reference - Verify a subscription payment and activate the plan.
// Calls Paystack server-to-server. Only activates subscription on confirmed success.
// Idempotent: replaying the same verified reference returns success without re-activating.
router.post("/verify-payment/:reference", async (req, res, next) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({ error: "Payment reference is required." });
    }

    const result = await verifyAndActivateSubscriptionPayment(reference, req.user.id);

    if (!result.success) {
      return res.status(400).json({
        error: result.message || "Payment verification failed. Subscription not activated.",
        ...result,
      });
    }

    const entitlements = await getUserEntitlements(req.user.id);

    res.json({
      success: true,
      message: result.message || "Subscription activated successfully.",
      alreadyProcessed: result.alreadyProcessed || false,
      subscription: result.subscription,
      entitlements,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    next(error);
  }
});

// POST /cancel - Cancel auto-renewal for active subscription
router.post("/cancel", async (req, res, next) => {
  try {
    const result = await cancelSubscription(req.user.id);
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

// POST /cancel-pending-downgrade - Cancel scheduled pending downgrade
router.post("/cancel-pending-downgrade", async (req, res, next) => {
  try {
    const result = await cancelPendingDowngrade(req.user.id);
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
