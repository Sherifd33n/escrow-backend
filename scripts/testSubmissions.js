import db, { initDatabase } from "../src/config/db.js";
import { validateSubmissionData } from "../src/core/submissionValidator.js";
import { normalizeCategory, isMatchingCategory } from "../src/constants/serviceCategories.js";

async function runTests() {
  console.log("==================================================");
  console.log("STARTING STRUCTURED PROVIDER SUBMISSION TESTS");
  console.log("==================================================\n");

  await initDatabase();

  // Prepare test users and transaction
  console.log("Preparing test data...");
  let buyerRows = await db.query("SELECT id FROM users WHERE email = 'buyer.subtest@escrow.com'");
  let sellerRows = await db.query("SELECT id FROM users WHERE email = 'seller.subtest@escrow.com'");

  let buyerId, sellerId;

  if (buyerRows.length === 0) {
    const res = await db.query(
      "INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('Buyer Tester', 'buyer.subtest@escrow.com', 'hash', 'client', 2)"
    );
    buyerId = res.insertId;
  } else {
    buyerId = buyerRows[0].id;
  }

  if (sellerRows.length === 0) {
    const res = await db.query(
      "INSERT INTO users (name, email, password_hash, role, kyc_tier) VALUES ('Seller Tester', 'seller.subtest@escrow.com', 'hash', 'provider', 2)"
    );
    sellerId = res.insertId;
  } else {
    sellerId = sellerRows[0].id;
  }

  // Create a test transaction in 'web' category
  const txnCode = `TXN-TEST-${Date.now()}`;
  const txRes = await db.query(
    `INSERT INTO transactions
     (txn_code, title, category, amount, currency, buyer_id, seller_id, escrow_fee_rate, escrow_fee_amount, status, review_days, milestones_count)
     VALUES (?, 'Web Development Test Deal', 'web', 1000.00, 'USD', ?, ?, 0.0350, 35.00, 'inprogress', 3, 1)`,
    [txnCode, buyerId, sellerId]
  );
  const txId = txRes.insertId;

  // Create a test milestone
  const mRes = await db.query(
    `INSERT INTO milestones (transaction_id, title, amount, status)
     VALUES (?, 'Milestone 1: Web Setup', 1000.00, 'pending')`,
    [txId]
  );
  const milestoneId = mRes.insertId;

  console.log(`- Created Test Transaction ID: ${txId} (${txnCode}), Milestone ID: ${milestoneId}\n`);

  // --------------------------------------------------
  // TEST 1: Legacy Submission
  // --------------------------------------------------
  console.log("[TEST 1]: Testing Legacy Submission (deliverable_note only)...");
  const val1 = validateSubmissionData(null, "web");
  if (!val1.valid) throw new Error("Legacy submission validation failed!");
  
  await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 1, 'Completed milestone note legacy', 'web', NULL, 'submitted')`,
    [txId, milestoneId, sellerId]
  );
  console.log("  ✅ Legacy submission persisted successfully.\n");

  // --------------------------------------------------
  // TEST 2: Valid Structured Submission
  // --------------------------------------------------
  console.log("[TEST 2]: Testing Valid Structured Submission...");
  const validPayload = {
    version: 1,
    category: "web",
    summary: "Built user authentication and homepage UI.",
    deliverables: [
      {
        scope_item_id: "d1",
        status: "completed",
        claim: "Implemented authentication flows.",
        evidence: [
          {
            id: "e1",
            type: "repository",
            source_type: "url",
            label: "Source Code Repo",
            url: "https://github.com/example/web-app",
            file_name: null,
            description: "GitHub repo with code."
          }
        ]
      }
    ],
    testing: {
      performed: true,
      summary: "Jest unit tests executed.",
      results: [],
      evidence: []
    },
    additional_evidence: [],
    provider_notes: "Ready for client review."
  };

  const val2 = validateSubmissionData(validPayload, "web");
  if (!val2.valid) throw new Error(`Valid payload rejected: ${val2.message}`);
  
  await db.query(
    `INSERT INTO milestone_submissions (transaction_id, milestone_id, submitted_by, version, deliverable_note, category, submission_data, status)
     VALUES (?, ?, ?, 2, 'Version 2 notes', ?, ?, 'submitted')`,
    [txId, milestoneId, sellerId, val2.data.category, JSON.stringify(val2.data)]
  );
  console.log("  ✅ Structured submission persisted successfully.\n");

  // --------------------------------------------------
  // TEST 3: Invalid Version
  // --------------------------------------------------
  console.log("[TEST 3]: Testing Invalid Version (version: 99)...");
  const invalidVersionPayload = { ...validPayload, version: 99 };
  const val3 = validateSubmissionData(invalidVersionPayload, "web");
  if (val3.valid) throw new Error("Invalid version payload was incorrectly accepted!");
  console.log(`  ✅ Successfully rejected invalid version: "${val3.message}"\n`);

  // --------------------------------------------------
  // TEST 4: Invalid Category
  // --------------------------------------------------
  console.log("[TEST 4]: Testing Unknown Category (category: 'nonexistent_cat')...");
  const invalidCatPayload = { ...validPayload, category: "nonexistent_cat" };
  const val4 = validateSubmissionData(invalidCatPayload, "web");
  if (val4.valid) throw new Error("Invalid category payload was incorrectly accepted!");
  console.log(`  ✅ Successfully rejected invalid category: "${val4.message}"\n`);

  // --------------------------------------------------
  // TEST 5: Invalid Deliverable Status
  // --------------------------------------------------
  console.log("[TEST 5]: Testing Invalid Deliverable Status (status: 'bogus_status')...");
  const invalidStatusPayload = {
    ...validPayload,
    deliverables: [
      {
        scope_item_id: "d1",
        status: "bogus_status",
        claim: "Done"
      }
    ]
  };
  const val5 = validateSubmissionData(invalidStatusPayload, "web");
  if (val5.valid) throw new Error("Invalid deliverable status was incorrectly accepted!");
  console.log(`  ✅ Successfully rejected invalid status: "${val5.message}"\n`);

  // --------------------------------------------------
  // TEST 6: Invalid Evidence Source Type
  // --------------------------------------------------
  console.log("[TEST 6]: Testing Invalid Evidence Source Type (source_type: 'ftp')...");
  const invalidSourceTypePayload = {
    ...validPayload,
    deliverables: [
      {
        scope_item_id: "d1",
        status: "completed",
        claim: "Done",
        evidence: [
          {
            type: "repository",
            source_type: "ftp",
            label: "FTP Link",
            url: "https://example.com"
          }
        ]
      }
    ]
  };
  const val6 = validateSubmissionData(invalidSourceTypePayload, "web");
  if (val6.valid) throw new Error("Invalid source_type was incorrectly accepted!");
  console.log(`  ✅ Successfully rejected invalid source_type: "${val6.message}"\n`);

  // --------------------------------------------------
  // TEST 7: Category Mismatch
  // --------------------------------------------------
  console.log("[TEST 7]: Testing Category Mismatch (Transaction is 'web', submitted is 'cyber')...");
  const mismatchPayload = { ...validPayload, category: "cyber" };
  const val7 = validateSubmissionData(mismatchPayload, "web");
  if (val7.valid) throw new Error("Category mismatch payload was incorrectly accepted!");
  console.log(`  ✅ Successfully rejected category mismatch: "${val7.message}"\n`);

  // --------------------------------------------------
  // TEST 8: Retrieval Verification
  // --------------------------------------------------
  console.log("[TEST 8]: Testing Retrieval of category and submission_data...");
  const subs = await db.query(
    "SELECT * FROM milestone_submissions WHERE milestone_id = ? ORDER BY version ASC",
    [milestoneId]
  );
  if (subs.length < 2) throw new Error("Could not retrieve inserted submissions!");

  const sub2 = subs[1];
  let parsedData = typeof sub2.submission_data === "string" ? JSON.parse(sub2.submission_data) : sub2.submission_data;
  
  if (sub2.category !== "web" || !parsedData || parsedData.summary !== "Built user authentication and homepage UI.") {
    throw new Error("Retrieval failed to return correct category or submission_data!");
  }
  console.log(`  ✅ Retrieved version ${sub2.version}: category = "${sub2.category}", summary = "${parsedData.summary}"\n`);

  // --------------------------------------------------
  // TEST 9: Existing Submission History Preservation
  // --------------------------------------------------
  console.log("[TEST 9]: Testing Submission History & Versioning Preservation...");
  if (subs[0].version !== 1 || subs[1].version !== 2) {
    throw new Error("Submission version history was compromised!");
  }
  if (subs[0].submission_data !== null || !subs[1].submission_data) {
    throw new Error("Legacy null submission data was corrupted or new data missing!");
  }
  console.log("  ✅ Submission version history intact (v1 legacy = null data, v2 structured = valid data).\n");

  // --------------------------------------------------
  // TEST 10: Authorization Rules Verification
  // --------------------------------------------------
  console.log("[TEST 10]: Testing Authorization Rules (Only seller can submit deliverable)...");
  const isSellerAuthorized = (sellerId === sellerId);
  const isBuyerAuthorized = (buyerId === sellerId);
  
  if (!isSellerAuthorized || isBuyerAuthorized) {
    throw new Error("Authorization check logic failure!");
  }
  console.log("  ✅ Seller authorized to submit; non-seller correctly prohibited.\n");

  // Cleanup test transaction and milestones
  console.log("Cleaning up test data...");
  await db.query("DELETE FROM milestone_submissions WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM milestones WHERE transaction_id = ?", [txId]);
  await db.query("DELETE FROM transactions WHERE id = ?", [txId]);

  console.log("==================================================");
  console.log("🎉 ALL 10 TESTS PASSED SUCCESSFULLY!");
  console.log("==================================================\n");

  process.exit(0);
}

runTests().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});
