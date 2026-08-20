import db, { initDatabase } from "../src/config/db.js";
import { validateSubmissionData } from "../src/core/submissionValidator.js";
import { SERVICE_CATEGORIES, isSupportedCategory } from "../src/constants/serviceCategories.js";
import { normalizeScope, preAnalyzeSubmission, runAiAudit } from "../src/services/aiService.js";

const ALL_10_CATEGORIES = [
  "software",
  "mobile",
  "web",
  "uiux",
  "cyber",
  "cloud",
  "ai",
  "it",
  "data",
  "docs",
];

async function runPhase7CategoryTests() {
  console.log("==================================================================");
  console.log("STARTING PHASE 7: COMPLETE 10-CATEGORY SUBMISSION SYSTEM TESTS");
  console.log("==================================================================\n");

  await initDatabase();

  // Test 1: Category Registration Check
  console.log("[TEST 1]: Verifying All 10 Categories are Recognized in Service Registry...");
  for (const cat of ALL_10_CATEGORIES) {
    if (!isSupportedCategory(cat)) {
      throw new Error(`Category "${cat}" is not registered in serviceCategories.js!`);
    }
  }
  console.log("  ✅ All 10 categories (software, mobile, web, uiux, cyber, cloud, ai, it, data, docs) registered successfully.\n");

  // Prepare test user & upgrade to Diamond plan for unlimited test runs
  let sellerRows = await db.query("SELECT id FROM users WHERE email = 'p7.seller@escrow.com'");
  let buyerRows = await db.query("SELECT id FROM users WHERE email = 'p7.buyer@escrow.com'");

  let buyerId = buyerRows.length ? buyerRows[0].id : (await db.query("INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('P7 Buyer', 'p7.buyer@escrow.com', 'hash', 'client', 2)")).insertId;
  let sellerId = sellerRows.length ? sellerRows[0].id : (await db.query("INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('P7 Seller', 'p7.seller@escrow.com', 'hash', 'provider', 4)")).insertId;

  await db.query("UPDATE users SET kyc_tier = 4 WHERE id = ?", [sellerId]);
  await db.query("INSERT INTO subscriptions (user_id, plan_id, billing_cycle, status) VALUES (?, 'diamond', 'monthly', 'active') ON DUPLICATE KEY UPDATE plan_id = 'diamond', status = 'active'", [sellerId]);

  // Test 2: Category Matrix Test Suite
  console.log("[TEST 2]: Executing End-to-End Submission & AI Audit for All 10 Categories...\n");

  const categoryTestData = {
    software: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Auth Microservice", description: "JWT auth API" }] },
      sub: {
        version: 1,
        category: "software",
        summary: "Software deliverable auth microservice.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Built auth microservice", evidence: [{ id: "e1", type: "repository", source_type: "url", url: "https://github.com/org/software-repo" }] }],
        testing: { performed: true, summary: "100% unit test pass" },
      },
    },
    mobile: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "iOS & Android App", description: "Mobile checkout flow" }] },
      sub: {
        version: 1,
        category: "mobile",
        summary: "Mobile app build and TestFlight link.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Built mobile app screens", evidence: [{ id: "e1", type: "build", source_type: "url", url: "https://testflight.apple.com/join/app123" }] }],
        testing: { performed: true, summary: "Tested on iOS 17 & Android 14" },
      },
    },
    web: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Web E-Commerce", description: "React Storefront" }] },
      sub: {
        version: 1,
        category: "web",
        summary: "Web storefront frontend.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Web storefront built", evidence: [{ id: "e1", type: "staging", source_type: "url", url: "https://staging.example.com" }] }],
        testing: { performed: true, summary: "Vitest pass rate 95%" },
      },
    },
    uiux: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Design System & Screens", description: "Figma master file" }] },
      sub: {
        version: 1,
        category: "uiux",
        summary: "Figma design system and prototype.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Designed 15 screens in Figma", evidence: [{ id: "e1", type: "figma", source_type: "url", url: "https://figma.com/file/sample" }] }],
      },
    },
    cyber: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Penetration Test", description: "OWASP audit" }] },
      sub: {
        version: 1,
        category: "cyber",
        summary: "Penetration test report & remediation.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Penetration audit completed", evidence: [{ id: "e1", type: "security_report", source_type: "url", url: "https://secure.example.com/report.pdf" }] }],
        custom_fields: { criticalFindings: 0, highFindings: 0, retestStatus: "Clean (All Fixed)" },
      },
    },
    cloud: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Terraform Infrastructure", description: "AWS ECS cluster" }] },
      sub: {
        version: 1,
        category: "cloud",
        summary: "Terraform IaC and Grafana dashboard.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Deployed Terraform IaC", evidence: [{ id: "e1", type: "repository", source_type: "url", url: "https://github.com/org/terraform-infra" }] }],
        testing: { performed: true, summary: "Failover verified" },
      },
    },
    ai: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Sentiment Model", description: "F1 Score >= 0.90" }] },
      sub: {
        version: 1,
        category: "ai",
        summary: "AI sentiment model and inference API.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Model trained F1=0.92", evidence: [{ id: "e1", type: "staging", source_type: "url", url: "https://api.model.example.com" }] }],
        custom_fields: { accuracy: "94.5%", f1Score: "0.92" },
      },
    },
    it: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "IT Strategy Report", description: "Cloud migration roadmap" }] },
      sub: {
        version: 1,
        category: "it",
        summary: "IT consulting strategy report.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Strategy report delivered", evidence: [{ id: "e1", type: "documentation", source_type: "url", url: "https://docs.example.com/strategy.pdf" }] }],
      },
    },
    data: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "Executive Dashboard", description: "PowerBI dashboard" }] },
      sub: {
        version: 1,
        category: "data",
        summary: "PowerBI dashboard and dbt pipeline.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "PowerBI dashboard active", evidence: [{ id: "e1", type: "dashboard", source_type: "url", url: "https://app.powerbi.com/groups/sample" }] }],
      },
    },
    docs: {
      scope: { deliverables: [{ scope_item_id: "d1", name: "API Portal Docs", description: "GitBook documentation" }] },
      sub: {
        version: 1,
        category: "docs",
        summary: "GitBook documentation portal.",
        deliverables: [{ scope_item_id: "d1", status: "completed", claim: "Documentation portal live", evidence: [{ id: "e1", type: "documentation", source_type: "url", url: "https://docs.mycompany.com" }] }],
      },
    },
  };

  const resultsMatrix = [];

  for (const catId of ALL_10_CATEGORIES) {
    const testItem = categoryTestData[catId];
    if (!testItem) throw new Error(`Missing test data definition for category: ${catId}`);

    // 1. Validate payload schema
    const valRes = validateSubmissionData(testItem.sub, catId);
    if (!valRes.valid) {
      throw new Error(`Validation failed for category ${catId}: ${valRes.message}`);
    }

    // 2. Create Transaction & Milestone
    const txnCode = `TXN-P7-${catId.toUpperCase()}-${Date.now()}`;
    const txRes = await db.query(
      `INSERT INTO transactions
       (txn_code, title, category, amount, currency, buyer_id, seller_id, escrow_fee_rate, escrow_fee_amount, status, scope_json)
       VALUES (?, ?, ?, 1500.00, 'USD', ?, ?, 0.0350, 52.50, 'inspection', ?)`,
      [txnCode, `${catId.toUpperCase()} Project`, catId, buyerId, sellerId, JSON.stringify(testItem.scope)]
    );
    const txId = txRes.insertId;

    const mRes = await db.query(
      `INSERT INTO milestones (transaction_id, title, amount, status) VALUES (?, 'Milestone 1', 1500.00, 'submitted')`,
      [txId]
    );
    const mId = mRes.insertId;

    // 3. Store Submission
    const subRes = await db.query(
      `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'submitted')`,
      [txId, mId, sellerId, testItem.sub.summary, catId, JSON.stringify(testItem.sub)]
    );
    const subId = subRes.insertId;

    // 4. Run AI Audit
    const auditRes = await runAiAudit(sellerId, {
      transactionId: txId,
      milestoneId: mId,
      submissionId: subId,
      title: `${catId.toUpperCase()} Project`,
      type: catId,
      amount: 1500,
      currency: "USD",
      counterparty: "P7 Buyer",
    });

    if (!auditRes || !auditRes.status) {
      throw new Error(`AI Audit failed to produce result for category ${catId}`);
    }

    resultsMatrix.push({
      category: catId,
      validated: true,
      persisted: true,
      auditScore: auditRes.score,
      auditStatus: auditRes.status,
    });

    console.log(`  ✅ Category [${catId.toUpperCase()}]: Validation ✓ | Persisted ✓ | Audit Score = ${auditRes.score} (${auditRes.status})`);

    // Cleanup transaction
    await db.query("DELETE FROM ai_audits WHERE transaction_id = ?", [txId]);
    await db.query("DELETE FROM milestone_submissions WHERE transaction_id = ?", [txId]);
    await db.query("DELETE FROM milestones WHERE transaction_id = ?", [txId]);
    await db.query("DELETE FROM transactions WHERE id = ?", [txId]);
  }

  console.log("\n==================================================================");
  console.log("🎉 ALL 10 SERVICE CATEGORIES VERIFIED END-TO-END SUCCESSFULLY!");
  console.log("==================================================================\n");

  process.exit(0);
}

runPhase7CategoryTests().catch((err) => {
  console.error("\n❌ PHASE 7 TEST FAILED:", err);
  process.exit(1);
});
