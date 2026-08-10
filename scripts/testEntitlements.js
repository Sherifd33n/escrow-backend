import db, { initDatabase } from "../src/config/db.js";
import { getUserEntitlements, PLAN_CONFIGS, getPlanBillingAmount } from "../src/services/entitlementService.js";
import { activateSubscription } from "../src/services/subscriptionService.js";
import { generateAiScope, runAiAudit } from "../src/services/aiService.js";
import axios from "axios";

async function runTests() {
  console.log("==================================================");
  console.log("STARTING SUBSCRIPTION + KYC + ENTITLEMENT ENGINE TESTS");
  console.log("==================================================\n");

  await initDatabase();

  // 1. Verify Annual Discount Formula (Exact 20% savings)
  console.log("[TEST 1]: Verifying Annual Pricing Math (Exact 20% Savings)...");
  
  const silverBilling = getPlanBillingAmount("silver", "annual");
  console.log(`- Silver Annual: $${silverBilling.monthlyEquivalent}/mo equivalent, Billed Total: $${silverBilling.totalBilled}`);
  if (silverBilling.totalBilled !== 182.40 || silverBilling.monthlyEquivalent !== 15.20) {
    throw new Error(`Silver annual math mismatch! Got ${silverBilling.totalBilled}, expected 182.40`);
  }

  const goldBilling = getPlanBillingAmount("gold", "annual");
  console.log(`- Gold Annual: $${goldBilling.monthlyEquivalent}/mo equivalent, Billed Total: $${goldBilling.totalBilled}`);
  if (goldBilling.totalBilled !== 566.40 || goldBilling.monthlyEquivalent !== 47.20) {
    throw new Error(`Gold annual math mismatch! Got ${goldBilling.totalBilled}, expected 566.40`);
  }

  const diamondBilling = getPlanBillingAmount("diamond", "annual");
  console.log(`- Diamond Annual: $${diamondBilling.monthlyEquivalent}/mo equivalent, Billed Total: $${diamondBilling.totalBilled}`);
  if (diamondBilling.totalBilled !== 1430.40 || diamondBilling.monthlyEquivalent !== 119.20) {
    throw new Error(`Diamond annual math mismatch! Got ${diamondBilling.totalBilled}, expected 1430.40`);
  }
  console.log("✅ [PASSED] Annual Pricing Math is 100% correct!\n");

  // 2. Find or create test user
  console.log("[TEST 2]: Preparing Test User in Database...");
  let users = await db.query("SELECT id FROM users WHERE email = 'entitlement.test@escrow.com'");
  let testUserId;

  if (users.length === 0) {
    const res = await db.query(
      "INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('Entitlement Tester', 'entitlement.test@escrow.com', 'hash', 'client', 1)"
    );
    testUserId = res.insertId;
  } else {
    testUserId = users[0].id;
  }
  console.log(`- Test user ID: ${testUserId}\n`);

  // 3. Test Effective Level Math: Silver + KYC Level 1 -> Effective Level 1
  console.log("[TEST 3]: Testing Silver + KYC Level 1 -> Effective Level 1...");
  await db.query("UPDATE users SET kyc_tier = 1 WHERE id = ?", [testUserId]);
  await activateSubscription({ userId: testUserId, planId: "silver", billingCycle: "monthly" });

  let ent = await getUserEntitlements(testUserId);
  console.log(`- Effective Level: ${ent.effectiveLevel} (Expected: 1)`);
  console.log(`- Can Create Escrow: ${ent.capabilities.canCreateEscrow} (Expected: false)`);
  if (ent.effectiveLevel !== 1 || ent.capabilities.canCreateEscrow !== false) {
    throw new Error("Effective Level 1 evaluation failed!");
  }
  console.log("✅ [PASSED] Silver + KYC Level 1 correctly yields Effective Level 1!\n");

  // 4. Test Effective Level Math: Silver + KYC Level 2 -> Effective Level 2
  console.log("[TEST 4]: Testing Silver + KYC Level 2 -> Effective Level 2...");
  await db.query("UPDATE users SET kyc_tier = 2 WHERE id = ?", [testUserId]);

  ent = await getUserEntitlements(testUserId);
  console.log(`- Effective Level: ${ent.effectiveLevel} (Expected: 2)`);
  console.log(`- Max Escrow USD: $${ent.limits.maxEscrowUsd} (Expected: 5000)`);
  console.log(`- Max Active Deals: ${ent.limits.maxActiveDeals} (Expected: 3)`);
  console.log(`- Escrow Fee Rate: ${ent.limits.escrowFeeRate * 100}% (Expected: 3.5%)`);
  if (ent.effectiveLevel !== 2 || ent.limits.maxEscrowUsd !== 5000 || ent.limits.maxActiveDeals !== 3) {
    throw new Error("Silver + KYC Level 2 evaluation failed!");
  }
  console.log("✅ [PASSED] Silver + KYC Level 2 correctly yields Effective Level 2!\n");

  // 5. Test Effective Level Math: Gold + KYC Level 2 -> Effective Level 2 (User paid Gold, but KYC is Level 2)
  console.log("[TEST 5]: Testing Gold + KYC Level 2 -> Effective Level 2...");
  await activateSubscription({ userId: testUserId, planId: "gold", billingCycle: "monthly" });

  ent = await getUserEntitlements(testUserId);
  console.log(`- Subscription Plan: ${ent.subscription.plan} (Expected: gold)`);
  console.log(`- KYC Level: ${ent.kyc.level} (Expected: 2)`);
  console.log(`- Effective Level: ${ent.effectiveLevel} (Expected: 2)`);
  console.log(`- Max Escrow USD: $${ent.limits.maxEscrowUsd} (Expected: 5000)`);
  console.log(`- Escrow Fee Rate: ${ent.limits.escrowFeeRate * 100}% (Expected: 2.5%)`);
  if (ent.subscription.plan !== "gold" || ent.effectiveLevel !== 2 || ent.limits.maxEscrowUsd !== 5000) {
    throw new Error("Gold + KYC Level 2 evaluation failed!");
  }
  console.log("✅ [PASSED] Gold + KYC Level 2 retains Gold plan while restricting capabilities to Level 2!\n");

  // 6. Test Gold + KYC Level 3 -> Effective Level 3
  console.log("[TEST 6]: Testing Gold + KYC Level 3 -> Effective Level 3...");
  await db.query("UPDATE users SET kyc_tier = 3 WHERE id = ?", [testUserId]);

  ent = await getUserEntitlements(testUserId);
  console.log(`- Effective Level: ${ent.effectiveLevel} (Expected: 3)`);
  console.log(`- Max Escrow USD: $${ent.limits.maxEscrowUsd} (Expected: 50000)`);
  console.log(`- Max Active Deals: ${ent.limits.maxActiveDeals} (Expected: 15)`);
  console.log(`- Multi-currency Access: ${ent.capabilities.canUseMultiCurrency} (Expected: true)`);
  if (ent.effectiveLevel !== 3 || ent.limits.maxEscrowUsd !== 50000 || !ent.capabilities.canUseMultiCurrency) {
    throw new Error("Gold + KYC Level 3 evaluation failed!");
  }
  console.log("✅ [PASSED] Gold + KYC Level 3 correctly unlocks Level 3 capabilities!\n");

  // 7. Test AI Audit Monthly Quota Enforcement
  console.log("[TEST 7]: Testing AI Audit Monthly Quota Enforcement...");
  // Clear previous ai_usage for test user
  await db.query("DELETE FROM ai_usage WHERE user_id = ?", [testUserId]);

  // Downgrade to Silver (quota = 2 audits/mo)
  await activateSubscription({ userId: testUserId, planId: "silver", billingCycle: "monthly" });

  const audit1 = await runAiAudit(testUserId, { title: "Audit 1", type: "Web Dev", amount: 1000 });
  console.log(`- Audit 1 completed with score: ${audit1.score}`);

  const audit2 = await runAiAudit(testUserId, { title: "Audit 2", type: "Web Dev", amount: 1000 });
  console.log(`- Audit 2 completed with score: ${audit2.score}`);

  let quotaBlocked = false;
  try {
    await runAiAudit(testUserId, { title: "Audit 3", type: "Web Dev", amount: 1000 });
  } catch (err) {
    if (err.code === "AI_QUOTA_EXCEEDED") {
      quotaBlocked = true;
      console.log(`- Audit 3 correctly blocked with message: "${err.message}"`);
    }
  }
  if (!quotaBlocked) {
    throw new Error("AI Quota enforcement failed to block 3rd audit on Silver plan!");
  }
  console.log("✅ [PASSED] AI Audit Monthly Quota enforcement works perfectly!\n");

  // 8. Check Subscription History preservation
  console.log("[TEST 8]: Verifying Subscription History Preservation...");
  const history = await db.query("SELECT * FROM subscriptions_history WHERE user_id = ? ORDER BY id ASC", [testUserId]);
  console.log(`- Recorded ${history.length} historical subscription transitions:`);
  history.forEach(h => console.log(`  * Plan: ${h.plan_id}, Status: ${h.status}, Cycle: ${h.billing_cycle}`));
  if (history.length < 3) {
    throw new Error("Subscription history entries missing!");
  }
  console.log("✅ [PASSED] Subscription history is fully preserved!\n");

  console.log("==================================================");
  console.log("ALL ENTITLEMENT & SUBSCRIPTION TESTS PASSED CLEANLY!");
  console.log("==================================================");

  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
