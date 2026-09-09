import db from "../config/db.js";
import { ACTIVE_TRANSACTION_STATUSES } from "../core/transactionStatus.js";
import { getAvailableBalance } from "./walletService.js";
import crypto from "crypto";

export const PLAN_CONFIGS = Object.freeze({
  silver: {
    id: "silver",
    name: "Silver",
    tier: 2,
    monthlyPrice: 19,
    annualPrice: 15.20, // $182.40 / 12
    annualBilledTotal: 182.40,
    maxEscrowUsd: 5000,
    maxActiveDeals: 3,
    escrowFeeRate: 0.035, // 3.5%
    aiAuditsPerMonth: 2,
    requiredKycLevel: 2,
    transactionHistoryMonths: 6,
    apiCallsPerMonth: 0,
    canUseMultiCurrency: false,
    canUseWhiteLabel: false,
    canGenerateUnlimitedContracts: false,
    allowedServices: ["svc-001", "svc-003", "svc-006"],
  },
  gold: {
    id: "gold",
    name: "Gold",
    tier: 3,
    monthlyPrice: 59,
    annualPrice: 47.20, // $566.40 / 12
    annualBilledTotal: 566.40,
    maxEscrowUsd: 50000,
    maxActiveDeals: 15,
    escrowFeeRate: 0.025, // 2.5%
    aiAuditsPerMonth: 15,
    requiredKycLevel: 3,
    transactionHistoryMonths: 24,
    apiCallsPerMonth: 5000,
    canUseMultiCurrency: true,
    canUseWhiteLabel: false,
    canGenerateUnlimitedContracts: true,
    allowedServices: ["svc-001", "svc-002", "svc-003", "svc-004", "svc-005", "svc-006"],
  },
  diamond: {
    id: "diamond",
    name: "Diamond",
    tier: 4,
    monthlyPrice: 149,
    annualPrice: 119.20, // $1430.40 / 12
    annualBilledTotal: 1430.40,
    maxEscrowUsd: Number.MAX_SAFE_INTEGER,
    maxActiveDeals: Number.MAX_SAFE_INTEGER,
    escrowFeeRate: 0.015, // 1.5%
    aiAuditsPerMonth: Number.MAX_SAFE_INTEGER,
    requiredKycLevel: 4,
    transactionHistoryMonths: Number.MAX_SAFE_INTEGER,
    apiCallsPerMonth: Number.MAX_SAFE_INTEGER,
    canUseMultiCurrency: true,
    canUseWhiteLabel: true,
    canGenerateUnlimitedContracts: true,
    allowedServices: ["svc-001", "svc-002", "svc-003", "svc-004", "svc-005", "svc-006"],
  },
});

export const LEVEL_LIMITS = Object.freeze({
  1: {
    maxEscrowUsd: 0,
    maxActiveDeals: 0,
    escrowFeeRate: 0.035,
    aiAuditsPerMonth: 0,
    transactionHistoryMonths: 1,
    apiCallsPerMonth: 0,
    canUseMultiCurrency: false,
    canUseWhiteLabel: false,
    canGenerateUnlimitedContracts: false,
  },
  2: {
    maxEscrowUsd: 5000,
    maxActiveDeals: 3,
    escrowFeeRate: 0.035,
    aiAuditsPerMonth: 2,
    transactionHistoryMonths: 6,
    apiCallsPerMonth: 0,
    canUseMultiCurrency: false,
    canUseWhiteLabel: false,
    canGenerateUnlimitedContracts: false,
  },
  3: {
    maxEscrowUsd: 50000,
    maxActiveDeals: 15,
    escrowFeeRate: 0.025,
    aiAuditsPerMonth: 15,
    transactionHistoryMonths: 24,
    apiCallsPerMonth: 5000,
    canUseMultiCurrency: true,
    canUseWhiteLabel: false,
    canGenerateUnlimitedContracts: true,
  },
  4: {
    maxEscrowUsd: Number.MAX_SAFE_INTEGER,
    maxActiveDeals: Number.MAX_SAFE_INTEGER,
    escrowFeeRate: 0.015,
    aiAuditsPerMonth: Number.MAX_SAFE_INTEGER,
    transactionHistoryMonths: Number.MAX_SAFE_INTEGER,
    apiCallsPerMonth: Number.MAX_SAFE_INTEGER,
    canUseMultiCurrency: true,
    canUseWhiteLabel: true,
    canGenerateUnlimitedContracts: true,
  },
});

/**
 * Fetch current user entitlements authoritatively from DB.
 */
export async function getUserEntitlements(userId) {
  // 1. Fetch user & KYC tier
  const users = await db.query(
    "SELECT id, name, email, role, kyc_tier, is_verified FROM users WHERE id = ?",
    [userId]
  );

  if (users.length === 0) {
    throw new Error("User not found.");
  }

  const user = users[0];
  const userKycTier = Number(user.kyc_tier) || 1;

  // 2. Fetch current subscription (must be active AND have a verified payment reference)
  const subRows = await db.query(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND provider_reference_id IS NOT NULL",
    [userId]
  );

  let activeSub = null;
  let planId = null;
  let planName = null;
  let subscriptionTier = 0;
  let billingCycle = null;
  let subStatus = "none";
  let startsAt = null;
  let endsAt = null;

  if (subRows.length > 0) {
    activeSub = subRows[0];
    
    // Check if subscription has expired
    if (activeSub.ends_at && new Date(activeSub.ends_at) < new Date()) {
      if (activeSub.pending_plan_id) {
        // A downgrade was scheduled — attempt to pay for the new lower plan from wallet
        const nextPlanId = activeSub.pending_plan_id.toLowerCase();
        const nextCycle = activeSub.pending_billing_cycle || "monthly";
        const nextPlanConfig = PLAN_CONFIGS[nextPlanId];

        if (nextPlanConfig) {
          const nextBilling = getPlanBillingAmount(nextPlanId, nextCycle);
          const costUSD = nextBilling.totalBilled;

          // Check wallet balance (use a plain non-locking query since this is a read path)
          const walletRows = await db.query(
            "SELECT * FROM wallets WHERE user_id = ?",
            [userId]
          );
          const wallet = walletRows[0] || null;
          const walletCurrency = (wallet?.currency || "USD").toUpperCase();
          const availableBalance = wallet ? await getAvailableBalance(userId, null) : 0;

          if (wallet && walletCurrency === "USD" && availableBalance >= costUSD) {
            // Auto-deduct wallet and activate the pending lower plan
            const reference = `SUB-WAL-AUTO-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
            const now = new Date();
            const nextEndsAt = new Date(now);
            if (nextCycle === "annual") nextEndsAt.setFullYear(nextEndsAt.getFullYear() + 1);
            else nextEndsAt.setMonth(nextEndsAt.getMonth() + 1);

            await db.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [costUSD, wallet.id]);
            await db.query(
              `INSERT INTO wallet_transactions (wallet_id, type, amount, currency, description, reference) VALUES (?, 'subscription', ?, 'USD', ?, ?)`,
              [wallet.id, costUSD, `Auto-renewal: ${nextPlanConfig.name} Plan (${nextCycle})`, reference]
            );
            await db.query(
              `INSERT INTO payments (user_id, reference, amount, amount_kobo, currency, exchange_rate, purpose, provider, status, metadata)
               VALUES (?, ?, ?, 0, 'USD', 1.0, 'subscription', 'wallet', 'success', ?)`,
              [userId, reference, costUSD, JSON.stringify({ plan_id: nextPlanId, billing_cycle: nextCycle, auto_renewal: true })]
            );
            await db.query(
              `UPDATE subscriptions 
               SET plan_id = ?, billing_cycle = ?, status = 'active', starts_at = ?, ends_at = ?,
                   payment_provider = 'wallet', provider_reference_id = ?,
                   pending_plan_id = NULL, pending_billing_cycle = NULL 
               WHERE id = ?`,
              [nextPlanId, nextCycle, now, nextEndsAt, reference, activeSub.id]
            );

            subStatus = "active";
            planId = nextPlanId;
            billingCycle = nextCycle;
            startsAt = now;
            endsAt = nextEndsAt;
            activeSub = { ...activeSub, plan_id: nextPlanId, pending_plan_id: null };

            const pConfig = PLAN_CONFIGS[planId];
            if (pConfig) {
              planName = pConfig.name;
              subscriptionTier = pConfig.tier;
            }
          } else {
            // Insufficient wallet balance — expire and clear pending downgrade
            subStatus = "expired";
            await db.query(
              "UPDATE subscriptions SET status = 'expired', pending_plan_id = NULL, pending_billing_cycle = NULL WHERE id = ?",
              [activeSub.id]
            );
          }
        } else {
          // Pending plan no longer valid — just expire
          subStatus = "expired";
          await db.query(
            "UPDATE subscriptions SET status = 'expired', pending_plan_id = NULL, pending_billing_cycle = NULL WHERE id = ?",
            [activeSub.id]
          );
        }
      } else {
        subStatus = "expired";
        await db.query("UPDATE subscriptions SET status = 'expired' WHERE id = ?", [activeSub.id]);
      }
    } else {
      subStatus = activeSub.status;
      planId = activeSub.plan_id ? activeSub.plan_id.toLowerCase() : null;
      billingCycle = activeSub.billing_cycle;
      startsAt = activeSub.starts_at;
      endsAt = activeSub.ends_at;

      const pConfig = planId ? PLAN_CONFIGS[planId] : null;
      if (pConfig) {
        planName = pConfig.name;
        subscriptionTier = pConfig.tier;
      }
    }
  }

  const isSubActive = subStatus === "active" && planId !== null;
  const planConfig = isSubActive ? PLAN_CONFIGS[planId] : null;

  // 3. Compute effective entitlement level: min(subscriptionTier, kycTier) if active, else 1
  const effectiveLevel = isSubActive ? Math.min(subscriptionTier, userKycTier) : 1;

  // Effective capabilities derived from effectiveLevel & planConfig
  const levelLimits = LEVEL_LIMITS[effectiveLevel] || LEVEL_LIMITS[1];

  // Fee rate is based on purchased active plan (if active) or effective level
  const escrowFeeRate = isSubActive && planConfig ? planConfig.escrowFeeRate : levelLimits.escrowFeeRate;

  // 4. Count current active deals for user
  const activeDealsRows = await db.query(
    `SELECT COUNT(*) as count FROM transactions 
     WHERE (buyer_id = ? OR seller_id = ?) 
     AND status IN (?)`,
    [userId, userId, ACTIVE_TRANSACTION_STATUSES]
  );
  const activeDealsCount = activeDealsRows[0]?.count || 0;

  // 5. Count AI audits used this current calendar month
  const firstDayOfMonth = new Date();
  firstDayOfMonth.setDate(1);
  firstDayOfMonth.setHours(0, 0, 0, 0);

  const aiUsageRows = await db.query(
    `SELECT COUNT(*) as count FROM ai_usage 
     WHERE user_id = ? AND feature = 'audit' AND created_at >= ?`,
    [userId, firstDayOfMonth]
  );
  const aiAuditsUsed = aiUsageRows[0]?.count || 0;

  // AI audits quota comes from active subscription plan (or level limits if no active sub)
  const maxAiAudits = isSubActive && planConfig ? planConfig.aiAuditsPerMonth : levelLimits.aiAuditsPerMonth;
  const aiAuditsRemaining = maxAiAudits === Number.MAX_SAFE_INTEGER 
    ? Number.MAX_SAFE_INTEGER 
    : Math.max(0, maxAiAudits - aiAuditsUsed);

  const canUseMultiCurrency = isSubActive && planConfig ? planConfig.canUseMultiCurrency : levelLimits.canUseMultiCurrency;
  const canUseWhiteLabel = isSubActive && planConfig ? planConfig.canUseWhiteLabel : levelLimits.canUseWhiteLabel;
  const canGenerateUnlimitedContracts = isSubActive && planConfig ? planConfig.canGenerateUnlimitedContracts : levelLimits.canGenerateUnlimitedContracts;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    subscription: {
      plan: isSubActive ? planId : null,
      planName: isSubActive ? planName : null,
      status: subStatus,
      billingCycle: isSubActive ? billingCycle : null,
      startsAt,
      endsAt,
      subscriptionTier: isSubActive ? subscriptionTier : 0,
      pendingPlan: isSubActive && activeSub?.pending_plan_id ? activeSub.pending_plan_id.toLowerCase() : null,
      pendingPlanName: isSubActive && activeSub?.pending_plan_id && PLAN_CONFIGS[activeSub.pending_plan_id.toLowerCase()] ? PLAN_CONFIGS[activeSub.pending_plan_id.toLowerCase()].name : null,
      pendingBillingCycle: isSubActive && activeSub?.pending_plan_id ? activeSub.pending_billing_cycle : null,
    },
    kyc: {
      level: userKycTier,
      isVerified: userKycTier > 1,
    },
    effectiveLevel,
    usage: {
      activeDealsCount,
      aiAuditsUsedThisMonth: aiAuditsUsed,
    },
    limits: {
      maxEscrowUsd: levelLimits.maxEscrowUsd,
      maxActiveDeals: levelLimits.maxActiveDeals,
      aiAuditsPerMonth: maxAiAudits,
      escrowFeeRate,
      transactionHistoryMonths: levelLimits.transactionHistoryMonths,
      apiCallsPerMonth: levelLimits.apiCallsPerMonth,
    },
    capabilities: {
      canCreateEscrow: effectiveLevel >= 2 && activeDealsCount < levelLimits.maxActiveDeals,
      canUseSilverServices: isSubActive,
      canUseGoldServices: isSubActive && subscriptionTier >= 3,
      canUseDiamondServices: isSubActive && subscriptionTier >= 4,
      canUseMultiCurrency,
      canUseWhiteLabel,
      canGenerateUnlimitedContracts,
      canRunAiAudit: isSubActive && (maxAiAudits === Number.MAX_SAFE_INTEGER || aiAuditsRemaining > 0),
    },
  };
}

/**
 * Calculates correct annual or monthly price for a plan.
 */
export function getPlanBillingAmount(planId, billingCycle) {
  const plan = PLAN_CONFIGS[planId.toLowerCase()];
  if (!plan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  if (billingCycle === "annual") {
    // Exactly 20% discount: monthlyPrice * 12 * 0.80
    return {
      monthlyEquivalent: plan.annualPrice,
      totalBilled: plan.annualBilledTotal,
      savingsPct: 20,
      currency: "USD",
    };
  }

  return {
    monthlyEquivalent: plan.monthlyPrice,
    totalBilled: plan.monthlyPrice,
    savingsPct: 0,
    currency: "USD",
  };
}
