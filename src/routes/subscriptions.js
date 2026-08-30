import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  getUserEntitlements,
  PLAN_CONFIGS,
  getPlanBillingAmount,
} from "../services/entitlementService.js";
import {
  activateSubscription,
  createCheckoutSession,
  cancelSubscription,
} from "../services/subscriptionService.js";

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

// POST /checkout - Initiate checkout for selected plan & cycle
router.post("/checkout", async (req, res, next) => {
  try {
    const { planId, billingCycle } = req.body;
    if (!planId) {
      return res.status(400).json({ error: "planId is required." });
    }

    const cycle = billingCycle === "annual" ? "annual" : "monthly";
    const session = await createCheckoutSession(req.user.id, planId, cycle);

    res.json({
      success: true,
      session,
    });
  } catch (error) {
    next(error);
  }
});

// POST /upgrade - Upgrade or activate subscription after verified payment
router.post("/upgrade", async (req, res, next) => {
  try {
    const { planId, billingCycle, paymentProvider, referenceId } = req.body;
    if (!planId) {
      return res.status(400).json({ error: "planId is required." });
    }

    const cycle = billingCycle === "annual" ? "annual" : "monthly";

    const result = await activateSubscription({
      userId: req.user.id,
      planId,
      billingCycle: cycle,
      paymentProvider: paymentProvider || "card",
      providerReferenceId: referenceId || `REF-${Date.now()}`,
    });

    const entitlements = await getUserEntitlements(req.user.id);

    res.json({
      message: `Successfully subscribed to ${PLAN_CONFIGS[planId.toLowerCase()]?.name || planId}!`,
      subscription: result,
      entitlements,
    });
  } catch (error) {
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

// POST /webhook - Payment provider webhook endpoint (Server-to-server payment verification)
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = req.body;
    // Standard webhook signature verification logic goes here
    if (event && event.type === "charge.success" && event.data) {
      const metadata = event.data.metadata || {};
      if (metadata.userId && metadata.planId) {
        await activateSubscription({
          userId: metadata.userId,
          planId: metadata.planId,
          billingCycle: metadata.billingCycle || "monthly",
          paymentProvider: event.data.channel || "paystack",
          providerReferenceId: event.data.reference,
          metadata: event.data,
        });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    res.status(400).json({ error: "Webhook processing error" });
  }
});

export default router;
