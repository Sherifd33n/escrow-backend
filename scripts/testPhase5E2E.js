import db, { initDatabase } from "../src/config/db.js";
import { validateSubmissionData } from "../src/core/submissionValidator.js";
import { normalizeCategory } from "../src/constants/serviceCategories.js";
import { normalizeScope, preAnalyzeSubmission, runAiAudit } from "../src/services/aiService.js";

async function runE2ETests() {
  console.log("==================================================");
  console.log("STARTING PHASE 5: FULL E2E VALIDATION & HARDENING");
  console.log("==================================================\n");

  await initDatabase();

  // Prepare test users
  let buyerRows = await db.query("SELECT id FROM users WHERE email = 'e2e.buyer@escrow.com'");
  let sellerRows = await db.query("SELECT id FROM users WHERE email = 'e2e.seller@escrow.com'");
  let unauthorizedRows = await db.query("SELECT id FROM users WHERE email = 'e2e.unauth@escrow.com'");

  let buyerId = buyerRows.length ? buyerRows[0].id : (await db.query("INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('E2E Buyer', 'e2e.buyer@escrow.com', 'hash', 'client', 2)")).insertId;
  let sellerId = sellerRows.length ? sellerRows[0].id : (await db.query("INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('E2E Seller', 'e2e.seller@escrow.com', 'hash', 'provider', 4)")).insertId;
  let unauthId = unauthorizedRows.length ? unauthorizedRows[0].id : (await db.query("INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('E2E Unauthorized', 'e2e.unauth@escrow.com', 'hash', 'provider', 2)")).insertId;

  // Give test seller a diamond subscription for unlimited AI audit test runs
  await db.query("UPDATE users SET kyc_tier = 4 WHERE id = ?", [sellerId]);
  await db.query("INSERT INTO subscriptions (user_id, plan_id, billing_cycle, status) VALUES (?, 'diamond', 'monthly', 'active') ON DUPLICATE KEY UPDATE plan_id = 'diamond', status = 'active'", [sellerId]);

  console.log(`Test Users Prepared: Buyer=${buyerId}, Seller=${sellerId}, Unauth=${unauthId}\n`);

  // -----------------------------------------------------------------
  // SCENARIO 1: Malformed Data & Validation Protection
  // -----------------------------------------------------------------
  console.log("[SCENARIO 1]: Verifying Server-Side Payload Validation...");
  const badPayloads = [
    { data: "string_payload", expectedErr: "submission_data must be" },
    { data: { version: 99 }, expectedErr: "Unsupported submission payload version: 99" },
    { data: { version: 1, category: "bogus_cat" }, expectedErr: "Invalid or unsupported service category" },
    { data: { version: 1, category: "cyber" }, txCat: "web", expectedErr: "does not match transaction category" },
    { data: { version: 1, deliverables: "not_an_array" }, expectedErr: "deliverables must be an array" },
    { data: { version: 1, deliverables: [{ status: "invalid_status" }] }, expectedErr: "Invalid status" },
    { data: { version: 1, deliverables: [{ evidence: [{ source_type: "ftp" }] }] }, expectedErr: "must be \"url\" or \"file\"" },
  ];

  for (const bp of badPayloads) {
    const res = validateSubmissionData(bp.data, bp.txCat || "web");
    if (res.valid) {
      throw new Error(`Validation failed to reject malformed payload: ${JSON.stringify(bp.data)}`);
    }
    if (!res.message.includes(bp.expectedErr)) {
      throw new Error(`Expected error containing "${bp.expectedErr}", got "${res.message}"`);
    }
  }
  console.log("  ✅ All malformed payloads successfully rejected with clear validation error messages.\n");

  // -----------------------------------------------------------------
  // SCENARIO 2: Scope Matching & Evidence Coverage Analysis
  // -----------------------------------------------------------------
  console.log("[SCENARIO 2]: Verifying Scope Matching (d1, d2, d3, d4)...");
  const scope4Items = {
    title: "Full-Stack Web App",
    deliverables: [
      { scope_item_id: "d1", name: "Product Catalog", description: "Display store products" },
      { scope_item_id: "d2", name: "Shopping Cart", description: "Cart management" },
      { scope_item_id: "d3", name: "Checkout Engine", description: "Stripe payment processing" },
      { scope_item_id: "d4", name: "Admin Dashboard", description: "Analytics & store admin" }
    ]
  };

  const normScope4 = normalizeScope(scope4Items);
  
  // Submission contains d1 (completed + repo evidence), d2 (completed + staging evidence), d3 (partial, claim only)
  const sub3Items = {
    version: 1,
    category: "web",
    summary: "Completed store catalog, cart, and partial checkout.",
    deliverables: [
      {
        scope_item_id: "d1",
        status: "completed",
        claim: "Built catalog grid and search.",
        evidence: [{ id: "e1", type: "repository", source_type: "url", url: "https://github.com/test/catalog" }]
      },
      {
        scope_item_id: "d2",
        status: "completed",
        claim: "Built shopping cart state.",
        evidence: [{ id: "e2", type: "staging", source_type: "url", url: "https://staging.example.com/cart" }]
      },
      {
        scope_item_id: "d3",
        status: "partial",
        claim: "Checkout UI completed, Stripe webhook pending.",
        evidence: []
      }
    ],
    testing: { performed: true, summary: "Unit tests executed for cart and catalog." }
  };

  const preAnalysis = preAnalyzeSubmission(normScope4, sub3Items);
  if (preAnalysis.matched_count !== 3) throw new Error(`Expected 3 matched items, got ${preAnalysis.matched_count}`);
  if (preAnalysis.missing_count !== 1) throw new Error(`Expected 1 missing item (d4 Admin Dashboard), got ${preAnalysis.missing_count}`);
  if (preAnalysis.partial_count !== 1) throw new Error(`Expected 1 partial item (d3 Checkout), got ${preAnalysis.partial_count}`);
  
  console.log("  ✅ Scope matching correctly identified:");
  console.log(`     - Matched: ${preAnalysis.matched_count}/4 items`);
  console.log(`     - Missing: d4 (Admin Dashboard)`);
  console.log(`     - Partial: d3 (Checkout Engine)\n`);

  // -----------------------------------------------------------------
  // SCENARIO 3: Complete E2E Database & Escrow Lifecycle
  // -----------------------------------------------------------------
  console.log("[SCENARIO 3]: Testing End-to-End Escrow Lifecycle (Submit -> Audit -> Revision -> Resubmit)...");

  // Create Transaction
  const txnCode = `TXN-E2E-${Date.now()}`;
  const txRes = await db.query(
    `INSERT INTO transactions
     (txn_code, title, category, amount, currency, buyer_id, seller_id, escrow_fee_rate, escrow_fee_amount, status, scope_json)
     VALUES (?, 'Web E-Commerce Storefront', 'web', 3500.00, 'USD', ?, ?, 0.0350, 122.50, 'inprogress', ?)`,
    [txnCode, buyerId, sellerId, JSON.stringify(scope4Items)]
  );
  const txId = txRes.insertId;

  // Create Milestone
  const mRes = await db.query(
    `INSERT INTO milestones (transaction_id, title, amount, status)
     VALUES (?, 'Milestone 1: Web Storefront', 3500.00, 'pending')`,
    [txId]
  );
  const mId = mRes.insertId;

  // Step A: Provider Submits v1 (Partial)
  console.log("  Submitting Version 1 (Partial deliverable)...");
  await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 1, 'Initial submission v1', 'web', ?, 'submitted')`,
    [txId, mId, sellerId, JSON.stringify(sub3Items)]
  );

  // Run AI Audit on v1
  const auditV1 = await runAiAudit(sellerId, {
    transactionId: txId,
    milestoneId: mId,
    title: "Web E-Commerce Storefront",
    type: "web",
    amount: 3500,
    currency: "USD",
    counterparty: "E2E Buyer"
  });

  console.log(`  v1 AI Audit Result: Score = ${auditV1.score}, Status = "${auditV1.status}", Risk = "${auditV1.risk}"`);
  if (!auditV1.requirements || auditV1.requirements.length !== 4) {
    throw new Error("Audit v1 did not return 4 requirement-level items!");
  }

  // Step B: Client Requests Revision
  console.log("  Client requests revision...");
  await db.query("UPDATE milestones SET status = 'rejected' WHERE id = ?", [mId]);
  await db.query(
    `INSERT INTO revision_requests (transaction_id, milestone_id, submission_id, requested_by, reason, details, status)
     VALUES (?, ?, ?, ?, 'Missing Admin Dashboard', 'Please complete d4 Admin Dashboard and attach staging URL for checkout.', 'open')`,
    [txId, mId, 1, buyerId]
  );

  // Step C: Provider Submits v2 (Fully Completed with Evidence)
  console.log("  Provider submits Version 2 (Full Scope + Evidence)...");
  const subV2Items = {
    version: 1,
    category: "web",
    summary: "Completed all 4 deliverables including Admin Dashboard and Stripe webhooks.",
    deliverables: [
      {
        scope_item_id: "d1",
        status: "completed",
        claim: "Catalog complete.",
        evidence: [{ id: "e1", type: "repository", source_type: "url", url: "https://github.com/test/store" }]
      },
      {
        scope_item_id: "d2",
        status: "completed",
        claim: "Cart complete.",
        evidence: [{ id: "e2", type: "staging", source_type: "url", url: "https://staging.example.com" }]
      },
      {
        scope_item_id: "d3",
        status: "completed",
        claim: "Checkout complete with Stripe live webhooks.",
        evidence: [{ id: "e3", type: "staging", source_type: "url", url: "https://staging.example.com/checkout" }]
      },
      {
        scope_item_id: "d4",
        status: "completed",
        claim: "Admin dashboard completed.",
        evidence: [{ id: "e4", type: "staging", source_type: "url", url: "https://staging.example.com/admin" }]
      }
    ],
    testing: { performed: true, summary: "All 24 unit and integration tests passing." },
    provider_notes: "All revision requests addressed."
  };

  await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 2, 'Version 2 full completion', 'web', ?, 'submitted')`,
    [txId, mId, sellerId, JSON.stringify(subV2Items)]
  );

  // Run AI Audit on v2
  const auditV2 = await runAiAudit(sellerId, {
    transactionId: txId,
    milestoneId: mId,
    title: "Web E-Commerce Storefront",
    type: "web",
    amount: 3500,
    currency: "USD",
    counterparty: "E2E Buyer"
  });

  console.log(`  v2 AI Audit Result: Score = ${auditV2.score}, Status = "${auditV2.status}", Risk = "${auditV2.risk}"`);
  if (auditV2.score < 80) {
    throw new Error(`Expected v2 score >= 80, got ${auditV2.score}`);
  }
  console.log("  ✅ Full lifecycle (Submit -> Audit -> Revision -> Resubmit v2) executed cleanly.\n");

  // -----------------------------------------------------------------
  // SCENARIO 4: Legacy Submissions Compatibility Check (submission_data = NULL)
  // -----------------------------------------------------------------
  console.log("[SCENARIO 4]: Verifying Legacy Submissions Compatibility (submission_data = NULL)...");
  await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 3, 'Legacy plain text note submission', NULL, NULL, 'submitted')`,
    [txId, mId, sellerId]
  );

  const legacyAudit = await runAiAudit(sellerId, {
    transactionId: txId,
    milestoneId: mId,
    title: "Web E-Commerce Storefront",
    type: "web",
    amount: 3500,
    currency: "USD",
    counterparty: "E2E Buyer"
  });

  if (!legacyAudit || !legacyAudit.summary) {
    throw new Error("Legacy audit failed to produce result!");
  }
  console.log("  ✅ Legacy submission evaluated without errors.");
  console.log(`     Audit Summary: "${legacyAudit.summary.substring(0, 75)}..."\n`);

  // Cleanup test data
  console.log("Cleaning up test data...");
  await db.query("DELETE FROM ai_audits WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM revision_requests WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM milestone_submissions WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM milestones WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM transactions WHERE id = ?", [txId]);

  console.log("==================================================");
  console.log("🎉 ALL PHASE 5 E2E VALIDATION TESTS PASSED!");
  console.log("==================================================\n");

  process.exit(0);
}

runE2ETests().catch((err) => {
  console.error("\n❌ E2E TEST FAILED:", err);
  process.exit(1);
});
