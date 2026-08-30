import db, { initDatabase } from "../src/config/db.js";
import { normalizeScope, preAnalyzeSubmission, runAiAudit } from "../src/services/aiService.js";

async function runAuditTests() {
  console.log("==================================================");
  console.log("STARTING PHASE 3 AI AUDIT MATCHING ENGINE TESTS");
  console.log("==================================================\n");

  await initDatabase();

  // Test 1: Scope Normalization
  console.log("[TEST 1]: Testing Scope Normalization (normalizeScope)...");
  const sampleScope = {
    title: "E-Commerce Web Project",
    deliverables: [
      { scope_item_id: "d1", name: "User Authentication", description: "JWT Login & Signup" },
      { scope_item_id: "d2", name: "Stripe Checkout", description: "Payment gateway integration" },
      { scope_item_id: "d3", name: "Admin Dashboard", description: "Analytics & user management" }
    ],
    acceptance: ["95% unit test pass rate", "Deployed on staging environment"]
  };

  const normalized = normalizeScope(sampleScope);
  if (normalized.deliverables.length !== 3 || normalized.deliverables[0].id !== "d1") {
    throw new Error("normalizeScope failed to normalize deliverables!");
  }
  console.log(`  ✅ Successfully normalized ${normalized.deliverables.length} scope items with preserved IDs.\n`);

  // Test 2: Deterministic Pre-Analysis
  console.log("[TEST 2]: Testing Pre-Analysis (preAnalyzeSubmission)...");
  const sampleSubmission = {
    version: 1,
    category: "web",
    summary: "Completed authentication and checkout.",
    deliverables: [
      {
        scope_item_id: "d1",
        status: "completed",
        claim: "Implemented JWT auth",
        evidence: [{ id: "e1", type: "repository", source_type: "url", url: "https://github.com/test/repo" }]
      },
      {
        scope_item_id: "d2",
        status: "completed",
        claim: "Implemented Stripe checkout",
        evidence: [{ id: "e2", type: "staging", source_type: "url", url: "https://staging.example.com" }]
      }
    ],
    testing: { performed: true, summary: "Jest tests passed." }
  };

  const preAnalysis = preAnalyzeSubmission(normalized, sampleSubmission);
  if (preAnalysis.matched_count !== 2 || preAnalysis.missing_count !== 1) {
    throw new Error("preAnalyzeSubmission failed metric calculation!");
  }
  console.log(`  ✅ Pre-Analysis correctly identified ${preAnalysis.matched_count} matched items and ${preAnalysis.missing_count} missing item.\n`);

  // Test 3: AI Audit Execution with Groq (Full Structured Submission)
  console.log("[TEST 3]: Testing AI Audit Execution with Groq LLM...");
  // Create a temporary transaction & user for audit execution
  let buyerRows = await db.query("SELECT id FROM users WHERE email = 'buyer.subtest@escrow.com'");
  let sellerRows = await db.query("SELECT id FROM users WHERE email = 'seller.subtest@escrow.com'");
  const buyerId = buyerRows.length ? buyerRows[0].id : 1;
  const sellerId = sellerRows.length ? sellerRows[0].id : 2;

  // Upgrade sellerId user to Diamond plan for unlimited AI audit test runs
  await db.query("UPDATE users SET kyc_tier = 4 WHERE id = ?", [sellerId]);
  await db.query("INSERT INTO subscriptions (user_id, plan_id, billing_cycle, status) VALUES (?, 'diamond', 'monthly', 'active') ON DUPLICATE KEY UPDATE plan_id = 'diamond', status = 'active'", [sellerId]);

  const txnCode = `TXN-AUDIT-${Date.now()}`;
  const txRes = await db.query(
    `INSERT INTO transactions
     (txn_code, title, category, amount, currency, buyer_id, seller_id, escrow_fee_rate, escrow_fee_amount, status, scope_json)
     VALUES (?, 'Web E-Commerce App', 'web', 2500.00, 'USD', ?, ?, 0.0350, 87.50, 'inspection', ?)`,
    [txnCode, buyerId, sellerId, JSON.stringify(sampleScope)]
  );
  const txId = txRes.insertId;

  const mRes = await db.query(
    `INSERT INTO milestones (transaction_id, title, amount, status)
     VALUES (?, 'Milestone 1: Web Features', 2500.00, 'submitted')`,
    [txId]
  );
  const mId = mRes.insertId;

  const subRes = await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 1, 'Completed auth and checkout', 'web', ?, 'submitted')`,
    [txId, mId, sellerId, JSON.stringify(sampleSubmission)]
  );
  const subId = subRes.insertId;

  const auditResult = await runAiAudit(sellerId, {
    transactionId: txId,
    milestoneId: mId,
    submissionId: subId,
    title: "Web E-Commerce App",
    type: "web",
    amount: 2500,
    currency: "USD",
    counterparty: "Client"
  });

  if (!auditResult || typeof auditResult.score !== "number" || !auditResult.status) {
    throw new Error("runAiAudit failed to return valid audit result!");
  }
  if (!Array.isArray(auditResult.requirements) || auditResult.requirements.length === 0) {
    throw new Error("runAiAudit failed to return requirement-level results!");
  }
  console.log(`  ✅ Audit execution succeeded: Score = ${auditResult.score}, Status = "${auditResult.status}", Risk = "${auditResult.risk}".`);
  console.log(`  ✅ Requirement breakdown generated for ${auditResult.requirements.length} scope items.`);

  // Cleanup test data
  console.log("Cleaning up test data...");
  await db.query("DELETE FROM ai_audits WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM milestone_submissions WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM milestones WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM transactions WHERE id = ?", [txId]);

  console.log("==================================================");
  console.log("🎉 ALL PHASE 3 AUDIT MATCHING TESTS PASSED!");
  console.log("==================================================\n");

  process.exit(0);
}

runAuditTests().catch((err) => {
  console.error("\n❌ AUDIT TEST FAILED:", err);
  process.exit(1);
});
