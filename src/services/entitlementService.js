import db from "../config/db.js";
import { ACTIVE_TRANSACTION_STATUSES } from "../core/transactionStatus.js";

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

  // 2. Fetch current subscription
  const subRows = await db.query(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'",
    [userId]
  );

  let activeSub = null;
  let planId = "silver";
  let subscriptionTier = 2; // Default starting tier is Silver (Level 2)
  let billingCycle = "monthly";
  let subStatus = "none";
  let startsAt = null;
  let endsAt = null;

  if (subRows.length > 0) {
    activeSub = subRows[0];
    
    // Check if subscription has expired
    if (activeSub.ends_at && new Date(activeSub.ends_at) < new Date()) {
      subStatus = "expired";
      // Update DB to mark expired
      await db.query("UPDATE subscriptions SET status = 'expired' WHERE id = ?", [activeSub.id]);
    } else {
      subStatus = activeSub.status;
      planId = activeSub.plan_id.toLowerCase();
      billingCycle = activeSub.billing_cycle;
      startsAt = activeSub.starts_at;
      endsAt = activeSub.ends_at;

      const planConfig = PLAN_CONFIGS[planId] || PLAN_CONFIGS.silver;
      subscriptionTier = planConfig.tier;
    }
  }

  const planConfig = PLAN_CONFIGS[planId] || PLAN_CONFIGS.silver;

  // 3. Compute effective entitlement level: min(subscriptionTier, kycTier)
  const effectiveLevel = Math.min(subscriptionTier, userKycTier);

  // Effective capabilities derived from effectiveLevel & planConfig
  const levelLimits = LEVEL_LIMITS[effectiveLevel] || LEVEL_LIMITS[1];

  // Fee rate is based on purchased active plan (if active) or effective level
  const escrowFeeRate = subStatus === "active" ? planConfig.escrowFeeRate : levelLimits.escrowFeeRate;

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
  const maxAiAudits = subStatus === "active" ? planConfig.aiAuditsPerMonth : levelLimits.aiAuditsPerMonth;
  const aiAuditsRemaining = maxAiAudits === Number.MAX_SAFE_INTEGER 
    ? Number.MAX_SAFE_INTEGER 
    : Math.max(0, maxAiAudits - aiAuditsUsed);

  const canUseMultiCurrency = subStatus === "active" ? planConfig.canUseMultiCurrency : levelLimits.canUseMultiCurrency;
  const canUseWhiteLabel = subStatus === "active" ? planConfig.canUseWhiteLabel : levelLimits.canUseWhiteLabel;
  const canGenerateUnlimitedContracts = subStatus === "active" ? planConfig.canGenerateUnlimitedContracts : levelLimits.canGenerateUnlimitedContracts;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    subscription: {
      plan: planId,
      planName: planConfig.name,
      status: subStatus,
      billingCycle,
      startsAt,
      endsAt,
      subscriptionTier,
    },
    kyc: {
      level: userKycTier,
      isVerified: user.is_verified === 1 || userKycTier > 1,
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
      canUseSilverServices: effectiveLevel >= 2 || subStatus === "active",
      canUseGoldServices: effectiveLevel >= 3 || (subStatus === "active" && subscriptionTier >= 3),
      canUseDiamondServices: effectiveLevel >= 4 || (subStatus === "active" && subscriptionTier >= 4),
      canUseMultiCurrency,
      canUseWhiteLabel,
      canGenerateUnlimitedContracts,
      canRunAiAudit: subStatus === "active" ? (maxAiAudits === Number.MAX_SAFE_INTEGER || aiAuditsRemaining > 0) : (effectiveLevel >= 2 && aiAuditsRemaining > 0),
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
