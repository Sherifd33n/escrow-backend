import db from "../config/db.js";
import { PLAN_CONFIGS, getPlanBillingAmount } from "./entitlementService.js";
import crypto from "crypto";

/**
 * Creates or updates an active subscription for a user server-side.
 * Also archives the previous plan state in subscriptions_history.
 */
export async function activateSubscription({
  userId,
  planId,
  billingCycle = "monthly",
  paymentProvider = "card",
  providerCustomerId = null,
  providerSubscriptionId = null,
  providerReferenceId = null,
  metadata = {},
}) {
  const normalizedPlanId = planId.toLowerCase();
  const plan = PLAN_CONFIGS[normalizedPlanId];

  if (!plan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  const billingInfo = getPlanBillingAmount(normalizedPlanId, billingCycle);

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Fetch current subscription if exists
    const [existingSubs] = await conn.query(
      "SELECT * FROM subscriptions WHERE user_id = ? FOR UPDATE",
      [userId]
    );

    const now = new Date();
    // Calculate ends_at based on billing cycle (1 month or 1 year)
    const endsAt = new Date(now);
    if (billingCycle === "annual") {
      endsAt.setFullYear(endsAt.getFullYear() + 1);
    } else {
      endsAt.setMonth(endsAt.getMonth() + 1);
    }

    if (existingSubs.length > 0) {
      const currentSub = existingSubs[0];

      // Record historical plan change into subscriptions_history
      await conn.query(
        `INSERT INTO subscriptions_history 
         (user_id, plan_id, billing_cycle, status, starts_at, ends_at, payment_provider, provider_reference_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          currentSub.plan_id,
          currentSub.billing_cycle,
          currentSub.status,
          currentSub.starts_at,
          currentSub.ends_at || now,
          currentSub.payment_provider || paymentProvider,
          currentSub.provider_reference_id || providerReferenceId,
        ]
      );

      // Update current active subscription
      await conn.query(
        `UPDATE subscriptions 
         SET plan_id = ?, 
             billing_cycle = ?, 
             status = 'active', 
             starts_at = ?, 
             ends_at = ?, 
             payment_provider = ?, 
             provider_customer_id = ?, 
             provider_subscription_id = ?, 
             provider_reference_id = ?, 
             auto_renew = 1, 
             cancelled_at = NULL, 
             metadata = ? 
         WHERE id = ?`,
        [
          normalizedPlanId,
          billingCycle,
          now,
          endsAt,
          paymentProvider,
          providerCustomerId,
          providerSubscriptionId,
          providerReferenceId,
          JSON.stringify(metadata),
          currentSub.id,
        ]
      );
    } else {
      // Create new active subscription
      await conn.query(
        `INSERT INTO subscriptions 
         (user_id, plan_id, billing_cycle, status, starts_at, ends_at, payment_provider, provider_customer_id, provider_subscription_id, provider_reference_id, auto_renew, metadata)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          userId,
          normalizedPlanId,
          billingCycle,
          now,
          endsAt,
          paymentProvider,
          providerCustomerId,
          providerSubscriptionId,
          providerReferenceId,
          JSON.stringify(metadata),
        ]
      );

      // Record first subscription entry in history as well
      await conn.query(
        `INSERT INTO subscriptions_history 
         (user_id, plan_id, billing_cycle, status, starts_at, ends_at, payment_provider, provider_reference_id)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
        [
          userId,
          normalizedPlanId,
          billingCycle,
          now,
          endsAt,
          paymentProvider,
          providerReferenceId,
        ]
      );
    }

    await conn.commit();

    return {
      success: true,
      plan: normalizedPlanId,
      billingCycle,
      startsAt: now,
      endsAt,
      billingInfo,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Creates checkout/payment intent details for frontend.
 * Server calculates exact amount independently based on plan & cycle.
 */
export async function createCheckoutSession(userId, planId, billingCycle = "monthly") {
  const normalizedPlanId = planId.toLowerCase();
  const plan = PLAN_CONFIGS[normalizedPlanId];
  if (!plan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  const billing = getPlanBillingAmount(normalizedPlanId, billingCycle);
  const reference = `SUB-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  return {
    reference,
    planId: normalizedPlanId,
    planName: plan.name,
    billingCycle,
    amountUsd: billing.totalBilled,
    monthlyEquivalent: billing.monthlyEquivalent,
    currency: "USD",
    checkoutUrl: null, // Ready for Paystack/Flutterwave redirect URL if API keys configured
  };
}

/**
 * Cancels auto-renewal for user subscription while maintaining access until period end.
 */
export async function cancelSubscription(userId) {
  const subs = await db.query(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'",
    [userId]
  );

  if (subs.length === 0) {
    throw new Error("No active subscription found to cancel.");
  }

  const sub = subs[0];
  const now = new Date();

  await db.query(
    `UPDATE subscriptions 
     SET auto_renew = 0, cancelled_at = ? 
     WHERE id = ?`,
    [now, sub.id]
  );

  return {
    message: "Subscription cancelled successfully. You retain access until the end of your billing cycle.",
    endsAt: sub.ends_at,
    autoRenew: false,
  };
}
