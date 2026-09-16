import db from "../config/db.js";
import { PLAN_CONFIGS, getPlanBillingAmount } from "./entitlementService.js";
import paystackService from "./paystackService.js";
import { getUsdToNgnRate } from "./exchangeRateService.js";
import { getAvailableBalance } from "./walletService.js";
import crypto from "crypto";

/**
 * Internal-only: Creates or updates an active subscription for a user.
 * MUST only be called after successful server-side payment verification
 * (either verified wallet debit or verified Paystack charge).
 * Also archives the previous plan state in subscriptions_history.
 * Idempotent: if providerReferenceId is already recorded on the active
 * subscription, returns success without making any further changes.
 */
export async function activateSubscription({
  userId,
  planId,
  billingCycle = "monthly",
  paymentProvider = "paystack",
  providerCustomerId = null,
  providerSubscriptionId = null,
  providerReferenceId = null,
  metadata = {},
  passedConn = null,
}) {
  const normalizedPlanId = planId.toLowerCase();
  const plan = PLAN_CONFIGS[normalizedPlanId];

  if (!plan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  const billingInfo = getPlanBillingAmount(normalizedPlanId, billingCycle);

  const ownConn = !passedConn;
  const conn = passedConn || (await db.getPool().getConnection());

  try {
    if (ownConn) {
      await conn.beginTransaction();
    }

    // 1. Fetch current subscription if exists (FOR UPDATE locks the row)
    const [existingSubs] = await conn.query(
      "SELECT * FROM subscriptions WHERE user_id = ? FOR UPDATE",
      [userId]
    );

    // 2. Idempotency: if we already have an active sub with this exact reference, do nothing
    if (existingSubs.length > 0 && providerReferenceId) {
      const current = existingSubs[0];
      if (
        current.status === "active" &&
        current.provider_reference_id === providerReferenceId &&
        current.plan_id === normalizedPlanId
      ) {
        if (ownConn) await conn.commit();
        return {
          success: true,
          alreadyActivated: true,
          plan: normalizedPlanId,
          billingCycle,
          startsAt: current.starts_at,
          endsAt: current.ends_at,
          billingInfo,
        };
      }
    }

    const now = new Date();
    let startsAt = now;
    let endsAt = new Date(now);

    if (existingSubs.length > 0) {
      const currentSub = existingSubs[0];
      const isSamePlanRenewal =
        currentSub.status === "active" &&
        currentSub.plan_id.toLowerCase() === normalizedPlanId &&
        currentSub.ends_at &&
        new Date(currentSub.ends_at) > now;

      if (isSamePlanRenewal) {
        // Renewal extends existing end date
        startsAt = currentSub.starts_at || now;
        endsAt = new Date(currentSub.ends_at);
        if (billingCycle === "annual") {
          endsAt.setFullYear(endsAt.getFullYear() + 1);
        } else {
          endsAt.setMonth(endsAt.getMonth() + 1);
        }
      } else {
        // Upgrade / new plan starts from now
        startsAt = now;
        if (billingCycle === "annual") {
          endsAt.setFullYear(endsAt.getFullYear() + 1);
        } else {
          endsAt.setMonth(endsAt.getMonth() + 1);
        }
      }

      // Record historical plan state into subscriptions_history
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

      // Update current subscription row to the new/renewed active plan
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
             pending_plan_id = NULL,
             pending_billing_cycle = NULL,
             metadata = ? 
         WHERE id = ?`,
        [
          normalizedPlanId,
          billingCycle,
          startsAt,
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
      if (billingCycle === "annual") {
        endsAt.setFullYear(endsAt.getFullYear() + 1);
      } else {
        endsAt.setMonth(endsAt.getMonth() + 1);
      }

      await conn.query(
        `INSERT INTO subscriptions 
         (user_id, plan_id, billing_cycle, status, starts_at, ends_at, payment_provider, provider_customer_id, provider_subscription_id, provider_reference_id, auto_renew, pending_plan_id, pending_billing_cycle, metadata)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
        [
          userId,
          normalizedPlanId,
          billingCycle,
          startsAt,
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
          startsAt,
          endsAt,
          paymentProvider,
          providerReferenceId,
        ]
      );
    }

    if (ownConn) {
      await conn.commit();
    }

    return {
      success: true,
      alreadyActivated: false,
      plan: normalizedPlanId,
      billingCycle,
      startsAt,
      endsAt,
      billingInfo,
    };
  } catch (err) {
    if (ownConn) {
      await conn.rollback();
    }
    throw err;
  } finally {
    if (ownConn) {
      conn.release();
    }
  }
}

/**
 * Cancels a scheduled pending downgrade for a user.
 */
export async function cancelPendingDowngrade(userId) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [subs] = await conn.query(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' FOR UPDATE",
      [userId]
    );

    if (!subs || subs.length === 0) {
      throw new Error("No active subscription found.");
    }

    const sub = subs[0];

    await conn.query(
      "UPDATE subscriptions SET pending_plan_id = NULL, pending_billing_cycle = NULL WHERE id = ?",
      [sub.id]
    );

    await conn.commit();

    return {
      success: true,
      message: "Scheduled pending downgrade has been cancelled. You remain on your current plan.",
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Initialises or processes a subscription payment/change for a user.
 * Evaluates subscription lifecycle rules:
 *
 * - NEW SUBSCRIPTION: Payment -> Immediate activation
 * - UPGRADE (Higher Tier): Payment -> Immediate replacement & activation
 * - DOWNGRADE (Lower Tier): NO payment -> Schedule pending_plan_id for period end
 * - SAME PLAN / CANCEL PENDING DOWNGRADE: Clears pending downgrade (if set) or handles RENEWAL
 * - WALLET VS PAYSTACK: Uses available wallet balance when sufficient, else Paystack fallback
 *
 * @param {number} userId
 * @param {string} planId
 * @param {string} billingCycle  'monthly' | 'annual'
 * @param {string} userEmail
 */
export async function initiateSubscriptionPayment(userId, planId, billingCycle, userEmail) {
  const normalizedPlanId = planId.toLowerCase();
  const targetPlan = PLAN_CONFIGS[normalizedPlanId];
  if (!targetPlan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  const cycle = billingCycle === "annual" ? "annual" : "monthly";

  // Derive authoritative price at function scope — used in BOTH wallet path and Paystack fallback path
  const billing = getPlanBillingAmount(normalizedPlanId, cycle);
  const costUSD = billing.totalBilled;

  // 1. Lock user's wallet and subscription row to evaluate lifecycle rules safely
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [existingSubs] = await conn.query(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' FOR UPDATE",
      [userId]
    );

    let activeSub = existingSubs.length > 0 ? existingSubs[0] : null;

    // Check if subscription has expired
    if (activeSub && activeSub.ends_at && new Date(activeSub.ends_at) < new Date()) {
      // If expired, clear any pending downgrade and mark as expired — user must pay for new period
      await conn.query(
        "UPDATE subscriptions SET status = 'expired', pending_plan_id = NULL, pending_billing_cycle = NULL WHERE id = ?",
        [activeSub.id]
      );
      activeSub = null;
    }

    // =========================================================================
    // EVALUATE SUBSCRIPTION LIFECYCLE RULES
    // =========================================================================
    if (activeSub) {
      const currentPlanId = activeSub.plan_id.toLowerCase();
      const currentPlan = PLAN_CONFIGS[currentPlanId] || PLAN_CONFIGS.silver;

      // -----------------------------------------------------------------------
      // RULE 1: DOWNGRADE (Target Tier < Current Tier)
      // -----------------------------------------------------------------------
      if (targetPlan.tier < currentPlan.tier) {
        // Schedule downgrade to take effect at current period end date. NO payment taken now!
        await conn.query(
          `UPDATE subscriptions 
           SET pending_plan_id = ?, pending_billing_cycle = ? 
           WHERE id = ?`,
          [normalizedPlanId, cycle, activeSub.id]
        );

        await conn.commit();

        const formattedEndDate = new Date(activeSub.ends_at).toLocaleDateString();

        return {
          success: true,
          isDowngrade: true,
          action: "downgrade_scheduled",
          planId: normalizedPlanId,
          planName: targetPlan.name,
          currentPlanName: currentPlan.name,
          endsAt: activeSub.ends_at,
          message: `Downgrade to ${targetPlan.name} scheduled for the end of your current billing period (${formattedEndDate}).`,
        };
      }

      // -----------------------------------------------------------------------
      // RULE 2: SAME TIER (Target Tier === Current Tier)
      // -----------------------------------------------------------------------
      if (targetPlan.tier === currentPlan.tier) {
        if (activeSub.pending_plan_id) {
          // User selected their current plan tier or changed their mind: Cancel pending downgrade!
          await conn.query(
            `UPDATE subscriptions 
             SET pending_plan_id = NULL, pending_billing_cycle = NULL 
             WHERE id = ?`,
            [activeSub.id]
          );

          await conn.commit();

          return {
            success: true,
            isCancellation: true,
            action: "pending_downgrade_cancelled",
            planId: currentPlanId,
            planName: currentPlan.name,
            message: `Pending downgrade cancelled. You remain on your active ${currentPlan.name} plan.`,
          };
        }

        // If no pending downgrade exists, selecting same plan is a RENEWAL (handled below)
      }

      // -----------------------------------------------------------------------
      // RULE 3: UPGRADE (Target Tier > Current Tier)
      // If upgrading, clear any previous pending downgrade automatically!
      // -----------------------------------------------------------------------
      if (activeSub.pending_plan_id) {
        await conn.query(
          `UPDATE subscriptions SET pending_plan_id = NULL, pending_billing_cycle = NULL WHERE id = ?`,
          [activeSub.id]
        );
      }
    }


    // Lock user's wallet FOR UPDATE to check spendable balance safely
    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [userId]
    );

    let wallet;
    if (!wallets.length) {
      const [insert] = await conn.query(
        "INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)",
        [userId]
      );
      const [created] = await conn.query(
        "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
        [insert.insertId]
      );
      wallet = created[0];
    } else {
      wallet = wallets[0];
    }

    const availableBalanceUSD = await getAvailableBalance(userId, conn);
    const walletCurrency = (wallet.currency || "USD").toUpperCase();

    // -------------------------------------------------------------------------
    // OPTION A: SUFFICIENT MATCHING WALLET BALANCE -> Deduct from wallet & activate/upgrade/renew
    // (Subscriptions are denominated in USD, so wallet must be USD)
    // -------------------------------------------------------------------------
    if (walletCurrency === "USD" && availableBalanceUSD >= costUSD) {
      // --- Duplicate payment guard: prevent double-debit from rapid clicks ---
      const [recentPayments] = await conn.query(
        `SELECT p.reference, s.starts_at, s.ends_at FROM payments p
         JOIN subscriptions s ON s.user_id = p.user_id AND s.status = 'active'
         WHERE p.user_id = ? AND p.purpose = 'subscription' AND p.provider = 'wallet'
           AND p.status = 'success' AND p.created_at >= DATE_SUB(NOW(), INTERVAL 60 SECOND)
           AND JSON_EXTRACT(p.metadata, '$.plan_id') = ?`,
        [userId, normalizedPlanId]
      );
      if (recentPayments.length > 0) {
        // Already processed — return idempotent success without deducting again
        await conn.commit();
        return {
          success: true,
          paymentMethod: "wallet",
          reference: recentPayments[0].reference,
          planId: normalizedPlanId,
          planName: targetPlan.name,
          billingCycle: cycle,
          amountUsd: costUSD,
          subscription: {
            alreadyActivated: true,
            plan: normalizedPlanId,
            billingCycle: cycle,
            startsAt: recentPayments[0].starts_at,
            endsAt: recentPayments[0].ends_at,
          },
          message: `${targetPlan.name} Plan is already active!`,
        };
      }

      const reference = `SUB-WAL-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

      // 1. Deduct subscription cost from wallet balance
      const balBefore = parseFloat(wallet.balance) || 0;
      const balAfter = balBefore - costUSD;

      await conn.query(
        "UPDATE wallets SET balance = balance - ? WHERE id = ?",
        [costUSD, wallet.id]
      );

      const subMetadata = {
        plan_id: normalizedPlanId,
        plan_name: targetPlan.name,
        billing_cycle: cycle,
        user_email: userEmail,
        payment_method: "wallet",
      };

      // 2. Record ledger entry in wallet_transactions
      const [txResult] = await conn.query(
        `INSERT INTO wallet_transactions
         (wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status)
         VALUES (?, 'subscription', ?, 'USD', ?, ?, ?, ?, ?, 'completed')`,
        [
          wallet.id,
          costUSD,
          `Wallet Subscription Payment for ${targetPlan.name} Plan (${cycle})`,
          reference,
          balBefore,
          balAfter,
          JSON.stringify(subMetadata),
        ]
      );

      const walletTxId = txResult.insertId;

      // 3. Insert completed payment record (provider='wallet', status='success')
      await conn.query(
        `INSERT INTO payments
         (user_id, reference, amount, amount_kobo, currency, exchange_rate, purpose, provider, status, wallet_transaction_id, metadata)
         VALUES (?, ?, ?, 0, 'USD', 1.0, 'subscription', 'wallet', 'success', ?, ?)`,
        [
          userId,
          reference,
          costUSD,
          walletTxId,
          JSON.stringify({
            plan_id: normalizedPlanId,
            billing_cycle: cycle,
            user_email: userEmail,
            usd_amount: costUSD,
            payment_method: "wallet",
          }),
        ]
      );

      // 4. Activate / Upgrade / Renew subscription idempotently in SAME connection
      const activationResult = await activateSubscription({
        userId,
        planId: normalizedPlanId,
        billingCycle: cycle,
        paymentProvider: "wallet",
        providerReferenceId: reference,
        metadata: { payment_method: "wallet", reference },
        passedConn: conn,
      });

      await conn.commit();

      return {
        success: true,
        paymentMethod: "wallet",
        reference,
        planId: normalizedPlanId,
        planName: targetPlan.name,
        billingCycle: cycle,
        amountUsd: costUSD,
        subscription: activationResult,
        message: `Successfully activated ${targetPlan.name} Plan using your wallet balance!`,
      };
    }

    // -------------------------------------------------------------------------
    // OPTION B: INSUFFICIENT WALLET BALANCE -> Paystack Fallback
    // -------------------------------------------------------------------------
    await conn.rollback(); // Release transaction lock on wallet before initializing external Paystack payment
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Convert USD price to NGN using live exchange rate (same pattern as wallet funding)
  const ngnRate = await getUsdToNgnRate();
  const amountNgn = parseFloat((targetPlan.totalBilled || costUSD * ngnRate).toFixed(2));
  const amountKobo = Math.round(amountNgn * 100);

  const reference = `SUB-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  // Store a pending payment record before calling Paystack
  await db.query(
    `INSERT INTO payments
     (user_id, reference, amount, amount_kobo, currency, exchange_rate, purpose, provider, status, metadata)
     VALUES (?, ?, ?, ?, 'NGN', ?, 'subscription', 'paystack', 'pending', ?)`,
    [
      userId,
      reference,
      costUSD,
      amountKobo,
      ngnRate,
      JSON.stringify({
        plan_id: normalizedPlanId,
        billing_cycle: cycle,
        user_email: userEmail,
        usd_amount: costUSD,
        payment_method: "paystack",
      }),
    ]
  );

  // Initialise Paystack transaction
  let paystackResponse;
  try {
    paystackResponse = await paystackService.initializeTransaction({
      email: userEmail,
      amountKobo,
      reference,
      callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
      metadata: {
        user_id: userId,
        purpose: "subscription",
        plan_id: normalizedPlanId,
        billing_cycle: cycle,
        usd_amount: costUSD,
        payment_method: "paystack",
      },
    });
  } catch (err) {
    await db.query("UPDATE payments SET status = 'failed' WHERE reference = ?", [reference]);
    throw err;
  }

  return {
    success: true,
    paymentMethod: "paystack",
    reference,
    authorization_url: paystackResponse.authorization_url,
    access_code: paystackResponse.access_code,
    planId: normalizedPlanId,
    planName: targetPlan.name,
    billingCycle: cycle,
    amountUsd: costUSD,
    amountNgn,
  };
}

/**
 * Verifies a subscription payment reference server-to-server with Paystack
 * and, on success, activates the subscription.
 *
 * Concurrency-safe: uses a DB transaction with FOR UPDATE on the payments row
 * so that simultaneous webhook + callback calls on the same reference are
 * serialized — the second caller always sees status='success' and returns early.
 *
 * Idempotent: replaying the same reference returns success without re-activating.
 *
 * @param {string} reference  The payment reference from the DB / Paystack callback
 * @param {number|null} userId  The authenticated user's ID (null when called from webhook)
 * @returns {{ success, alreadyProcessed, alreadyActivated, subscription }}
 */
export async function verifyAndActivateSubscriptionPayment(reference, userId) {
  const conn = await db.getPool().getConnection();
  let planId, billingCycle, payment;

  try {
    await conn.beginTransaction();

    // 1. Lock the payment row immediately — serializes concurrent webhook + callback calls
    const [paymentRows] = await conn.query(
      "SELECT * FROM payments WHERE reference = ? FOR UPDATE",
      [reference]
    );

    if (!paymentRows || paymentRows.length === 0) {
      await conn.rollback();
      throw new Error("Payment record not found.");
    }

    payment = paymentRows[0];

    // 2. Ownership check — prevent cross-user activation
    if (userId !== null && payment.user_id !== userId) {
      await conn.rollback();
      const err = new Error("You are not authorised to verify this payment.");
      err.statusCode = 403;
      throw err;
    }

    // 3. Purpose check
    if (payment.purpose !== "subscription") {
      await conn.rollback();
      const err = new Error("This payment reference is not for a subscription.");
      err.statusCode = 400;
      throw err;
    }

    // 4. Idempotency — another concurrent path already processed this reference
    if (payment.status === "success") {
      await conn.commit();
      return {
        success: true,
        alreadyProcessed: true,
        alreadyActivated: true,
        message: "Subscription payment has already been processed.",
      };
    }

    // 5. Extract plan metadata before calling Paystack (metadata is safe — already in DB)
    let meta = {};
    try {
      meta = typeof payment.metadata === "string" ? JSON.parse(payment.metadata) : (payment.metadata || {});
    } catch {
      meta = {};
    }

    planId = meta.plan_id;
    billingCycle = meta.billing_cycle;

    if (!planId || !PLAN_CONFIGS[planId]) {
      await conn.rollback();
      throw new Error("Subscription payment metadata is missing or contains an invalid plan.");
    }
    if (!billingCycle || !["monthly", "annual"].includes(billingCycle)) {
      await conn.rollback();
      throw new Error("Subscription payment metadata contains an invalid billing cycle.");
    }

    // 6. Verify with Paystack server-to-server (done while holding the lock — prevents double processing)
    let pData;
    try {
      pData = await paystackService.verifyTransaction(reference);
    } catch (verifyErr) {
      await conn.rollback();
      throw verifyErr;
    }

    if (pData.status !== "success") {
      const newStatus = pData.status === "failed" ? "failed" : "abandoned";
      await conn.query("UPDATE payments SET status = ? WHERE reference = ?", [newStatus, reference]);
      await conn.commit();
      return {
        success: false,
        alreadyProcessed: false,
        message: `Payment was not successful (Paystack status: ${pData.status}). Subscription not activated.`,
      };
    }

    // 7. Amount verification (Paystack returns amount in kobo)
    const expectedKobo = BigInt(payment.amount_kobo);
    const actualKobo = BigInt(pData.amount);
    if (expectedKobo !== actualKobo) {
      await conn.query("UPDATE payments SET status = 'failed' WHERE reference = ?", [reference]);
      await conn.commit();
      throw new Error("Payment verification failed: amount paid does not match the expected subscription price.");
    }

    // 8. Mark payment as success within the same transaction
    await conn.query(
      `UPDATE payments
       SET status = 'success',
           provider_transaction_id = ?,
           provider_reference = ?
       WHERE reference = ?`,
      [
        String(pData.id || pData.transaction_id || ""),
        pData.reference || reference,
        reference,
      ]
    );

    // 9. Activate subscription within the same transaction — eliminates the second lock acquisition
    const activationResult = await activateSubscription({
      userId: payment.user_id,
      planId,
      billingCycle,
      paymentProvider: pData.channel || "paystack",
      providerReferenceId: reference,
      metadata: { paystack_data: pData },
      passedConn: conn,
    });

    await conn.commit();

    return {
      success: true,
      alreadyProcessed: false,
      alreadyActivated: activationResult.alreadyActivated || false,
      subscription: activationResult,
      message: `Successfully subscribed to ${PLAN_CONFIGS[planId].name}!`,
    };

  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore rollback errors */ }
    throw err;
  } finally {
    conn.release();
  }
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
     SET auto_renew = 0, cancelled_at = ?, pending_plan_id = NULL, pending_billing_cycle = NULL 
     WHERE id = ?`,
    [now, sub.id]
  );

  return {
    message: "Subscription cancelled successfully. You retain access until the end of your billing cycle.",
    endsAt: sub.ends_at,
    autoRenew: false,
  };
}

/**
 * Recurring background task to process expired subscriptions and apply pending plan changes/downgrades.
 */
export async function processSubscriptionLifecycle() {
  try {
    const expiredSubs = await db.query(
      `SELECT * FROM subscriptions 
       WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= NOW()`
    );

    for (const sub of expiredSubs) {
      const conn = await db.getPool().getConnection();
      try {
        await conn.beginTransaction();

        if (sub.pending_plan_id) {
          const newPlanId = sub.pending_plan_id.toLowerCase();
          const newCycle = sub.pending_billing_cycle || "monthly";
          const startsAt = new Date();
          const endsAt = new Date();
          if (newCycle === "annual") endsAt.setFullYear(endsAt.getFullYear() + 1);
          else endsAt.setMonth(endsAt.getMonth() + 1);

          await conn.query(
            `UPDATE subscriptions 
             SET plan_id = ?, billing_cycle = ?, status = 'active', starts_at = ?, ends_at = ?, pending_plan_id = NULL, pending_billing_cycle = NULL
             WHERE id = ?`,
            [newPlanId, newCycle, startsAt, endsAt, sub.id]
          );

          await conn.query(
            `INSERT INTO subscriptions_history (user_id, plan_id, billing_cycle, status, starts_at, ends_at)
             VALUES (?, ?, ?, 'active', ?, ?)`,
            [sub.user_id, newPlanId, newCycle, startsAt, endsAt]
          );
        } else {
          await conn.query(
            `UPDATE subscriptions SET status = 'expired' WHERE id = ?`,
            [sub.id]
          );

          await conn.query(
            `INSERT INTO subscriptions_history (user_id, plan_id, billing_cycle, status, starts_at, ends_at)
             VALUES (?, ?, ?, 'expired', ?, NOW())`,
            [sub.user_id, sub.plan_id, sub.billing_cycle, sub.starts_at]
          );
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        console.error(`[subscriptionService] Error processing expired sub ID ${sub.id}:`, err.message);
      } finally {
        conn.release();
      }
    }
  } catch (err) {
    console.error("[subscriptionService] Subscription lifecycle error:", err.message);
  }
}

