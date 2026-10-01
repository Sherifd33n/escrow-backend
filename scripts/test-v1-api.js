/**
 * Lumbrr V1 API - Automated End-to-End Test Suite
 * 
 * Runs all 25+ endpoints in sequence against the live API server.
 * Usage: node scripts/test-v1-api.js
 */

import db from "../src/config/db.js";

const BASE_URL = process.env.API_URL || "http://localhost:4000/api/v1/escrows";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;

async function request(endpoint, options = {}, apiKey) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function assert(condition, name, details = "") {
  if (condition) {
    console.log(`  ${colors.green}✔ PASS${colors.reset}: ${name}`);
    passed++;
  } else {
    console.error(`  ${colors.red}✖ FAIL${colors.reset}: ${name} ${details ? `(${details})` : ""}`);
    failed++;
  }
}

async function runTestSuite() {
  console.log(`\n${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}   Lumbrr V1 API - Professional Automated Test Runner        ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}\n`);

  // 1. Initialize database connection pool
  await db.initDatabase();

  // 2. Get or create a test API Key from the database
  console.log(`${colors.yellow}🔍 Step 0: Retrieving Test API Key from DB...${colors.reset}`);
  let apiKeyRows = await db.query(
    "SELECT public_key, environment FROM api_keys WHERE is_active = 1 ORDER BY id DESC LIMIT 1"
  );

  let apiKey = null;
  if (apiKeyRows && apiKeyRows.length > 0) {
    apiKey = apiKeyRows[0].public_key;
    console.log(`  Found active key: ${apiKey.slice(0, 14)}••••`);
  } else {
    // Generate test key directly
    const [userRows] = await db.query("SELECT id FROM users LIMIT 1");
    if (!userRows.length) {
      console.error("No users found in database to attach API key.");
      process.exit(1);
    }
    const testKey = `lmb_test_${Date.now()}_testsuite`;
    await db.query(
      "INSERT INTO api_keys (user_id, name, public_key, environment, is_active) VALUES (?, 'Test Suite', ?, 'test', 1)",
      [userRows[0].id, testKey]
    );
    apiKey = testKey;
    console.log(`  Provisioned new test key: ${apiKey.slice(0, 14)}••••`);
  }

  // ─── TEST 1: Auth Protection (401 on missing key) ───
  console.log(`\n${colors.bold}1. Authentication Guard Verification${colors.reset}`);
  const unauthRes = await request("/wallet");
  assert(unauthRes.status === 401, "GET /wallet without auth returns 401 Unauthorized");

  // ─── TEST 2: Wallet & Balance ───
  console.log(`\n${colors.bold}2. Partner Wallet Balance${colors.reset}`);
  const walletRes = await request("/wallet", { method: "GET" }, apiKey);
  assert(walletRes.ok && walletRes.data.success, "GET /wallet returns partner balance");

  // ─── TEST 3: AI Scope Generation ───
  console.log(`\n${colors.bold}3. AI Scope Generation${colors.reset}`);
  const aiScopeRes = await request("/ai/scope", {
    method: "POST",
    body: {
      categoryLabel: "Full-Stack Web App",
      description: "Build an Airbnb clone with Next.js and escrow booking system.",
    },
  }, apiKey);
  assert(aiScopeRes.ok && aiScopeRes.data.success, "POST /ai/scope generates contract deliverables");

  // ─── TEST 4: Create Escrow Deal ───
  console.log(`\n${colors.bold}4. Create Multi-Milestone Escrow Deal${colors.reset}`);
  const createRes = await request("", {
    method: "POST",
    body: {
      title: "Fullstack Marketplace Platform",
      amount: 1000,
      currency: "USD",
      buyerEmail: `buyer_${Date.now()}@lumbrrtest.com`,
      buyerName: "Enterprise Buyer",
      sellerEmail: `seller_${Date.now()}@lumbrrtest.com`,
      sellerName: "Super Agency",
      inspectionPeriodDays: 4,
      partnerPlatformFee: 15,
      milestones: [
        { title: "Milestone 1: Backend Architecture", amount: 400 },
        { title: "Milestone 2: Frontend Client", amount: 600 },
      ],
      scope: {
        deliverables: ["REST API", "React Frontend"],
        requirements: "Production grade",
      },
    },
  }, apiKey);

  assert(createRes.status === 201 && createRes.data.success, "POST /api/v1/escrows creates deal (201 Created)");
  const dealId = createRes.data?.data?.id;
  const milestone1Id = createRes.data?.data?.milestones?.[0]?.id;
  const milestone2Id = createRes.data?.data?.milestones?.[1]?.id;

  // ─── TEST 5: Get Escrow Details ───
  console.log(`\n${colors.bold}5. Fetch Escrow Details${colors.reset}`);
  const getRes = await request(`/${dealId}`, { method: "GET" }, apiKey);
  assert(getRes.ok && getRes.data?.data?.id === dealId, `GET /api/v1/escrows/${dealId} retrieves deal`);

  // ─── TEST 6: List Escrows ───
  console.log(`\n${colors.bold}6. List Escrows with Search & Filters${colors.reset}`);
  const listRes = await request(`?page=1&limit=5&status=pending`, { method: "GET" }, apiKey);
  assert(listRes.ok && Array.isArray(listRes.data?.data), "GET /api/v1/escrows lists deals");

  // ─── TEST 7: Milestone CRUD (Add, Edit, Delete) ───
  console.log(`\n${colors.bold}7. Milestone Management (Add, Edit, Delete)${colors.reset}`);
  const addMilestoneRes = await request(`/${dealId}/milestones`, {
    method: "POST",
    body: { title: "Milestone 3: QA & Testing", amount: 200 },
  }, apiKey);
  assert(addMilestoneRes.status === 201, "POST /:id/milestones adds milestone");
  const milestone3Id = addMilestoneRes.data?.data?.milestoneId;

  if (milestone3Id) {
    const editMRes = await request(`/${dealId}/milestones/${milestone3Id}`, {
      method: "PATCH",
      body: { title: "Milestone 3: Security & QA", amount: 250 },
    }, apiKey);
    assert(editMRes.ok, "PATCH /:id/milestones/:mId updates milestone");

    const delMRes = await request(`/${dealId}/milestones/${milestone3Id}`, {
      method: "DELETE",
    }, apiKey);
    assert(delMRes.ok, "DELETE /:id/milestones/:mId deletes milestone");
  }

  // ─── TEST 8: Scope Management ───
  console.log(`\n${colors.bold}8. Scope Contract Management${colors.reset}`);
  const getScopeRes = await request(`/${dealId}/scope`, { method: "GET" }, apiKey);
  assert(getScopeRes.ok && getScopeRes.data.success, "GET /:id/scope fetches scope");

  const patchScopeRes = await request(`/${dealId}/scope`, {
    method: "PATCH",
    body: {
      deliverables: ["Microservices API", "Web App UI"],
      revisionPolicy: "3 revisions included",
    },
  }, apiKey);
  assert(patchScopeRes.ok, "PATCH /:id/scope updates scope");

  const reqChangeRes = await request(`/${dealId}/scope/request-changes`, {
    method: "POST",
    body: { proposedChanges: { newFeature: "Stripe Billing" }, reason: "Client request" },
  }, apiKey);
  assert(reqChangeRes.ok, "POST /:id/scope/request-changes logs scope modification");

  // ─── TEST 9: Fund Milestone ───
  console.log(`\n${colors.bold}9. Fund Milestone into Escrow${colors.reset}`);
  // Give buyer wallet test balance to fund
  const buyerId = createRes.data?.data?.buyer?.id;
  if (buyerId) {
    await db.query("UPDATE wallets SET balance = balance + 5000 WHERE user_id = ?", [buyerId]);
  }
  const fundRes = await request(`/${dealId}/milestones/${milestone1Id}/fund`, { method: "POST" }, apiKey);
  assert(fundRes.ok && fundRes.data.success, "POST /:id/milestones/:mId/fund funds milestone into escrow");

  // ─── TEST 10: Status Transitions ───
  console.log(`\n${colors.bold}10. Status Transitions${colors.reset}`);
  const startWorkRes = await request(`/${dealId}/status`, {
    method: "PATCH",
    body: { status: "inprogress", note: "Developer has started Sprint 1." },
  }, apiKey);
  assert(startWorkRes.ok, "PATCH /:id/status transitions status to 'inprogress'");

  // ─── TEST 11: Deliverable Submission & Approval ───
  console.log(`\n${colors.bold}11. Deliverable Submission, AI Audit & Milestone Approval${colors.reset}`);
  const submitRes = await request(`/${dealId}/milestones/${milestone1Id}/status`, {
    method: "PATCH",
    body: {
      status: "submitted",
      deliverableNote: "Sprint 1 backend deployed to AWS staging.",
      deliverableUrl: "https://staging.lumbrrtest.com",
    },
  }, apiKey);
  assert(submitRes.ok, "PATCH /:id/milestones/:mId/status submits deliverable (status: submitted)");

  // Run AI Audit on deliverable
  const auditRes = await request(`/${dealId}/ai/audit`, {
    method: "POST",
    body: { milestoneId: milestone1Id, title: "Backend Architecture", amount: 400 },
  }, apiKey);
  assert(auditRes.ok, "POST /:id/ai/audit executes AI deliverable audit");

  const getAuditsRes = await request(`/${dealId}/ai/audits`, { method: "GET" }, apiKey);
  assert(getAuditsRes.ok, "GET /:id/ai/audits fetches past audits");

  // Approve milestone 1
  const approveM1Res = await request(`/${dealId}/milestones/${milestone1Id}/status`, {
    method: "PATCH",
    body: { status: "approved", feedback: "Backend code approved" },
  }, apiKey);
  assert(approveM1Res.ok, "PATCH /:id/milestones/:mId/status approves milestone (status: approved)");

  // Fund and approve milestone 2 so deal can complete
  if (milestone2Id) {
    await request(`/${dealId}/milestones/${milestone2Id}/fund`, { method: "POST" }, apiKey);
    await request(`/${dealId}/milestones/${milestone2Id}/status`, {
      method: "PATCH",
      body: { status: "approved", feedback: "Frontend accepted" },
    }, apiKey);
  }

  // ─── TEST 12: Escrow Release & Reviews ───
  console.log(`\n${colors.bold}12. Full Escrow Release & Reviews${colors.reset}`);
  const releaseRes = await request(`/${dealId}/release`, {
    method: "POST",
    body: { reason: "Work accepted by client." },
  }, apiKey);
  assert(releaseRes.ok && releaseRes.data.success, "POST /:id/release releases funds to seller");

  const reviewRes = await request(`/${dealId}/reviews`, {
    method: "POST",
    body: { rating: 5, comment: "Top tier execution!", reviewerRole: "buyer" },
  }, apiKey);
  assert(reviewRes.status === 201, "POST /:id/reviews submits review");

  const getReviewsRes = await request(`/${dealId}/reviews`, { method: "GET" }, apiKey);
  assert(getReviewsRes.ok && Array.isArray(getReviewsRes.data?.data?.reviews), "GET /:id/reviews retrieves reviews");

  // ─── TEST 13: Transaction Audit History ───
  console.log(`\n${colors.bold}13. Transaction Audit Trail${colors.reset}`);
  const histRes = await request(`/${dealId}/history`, { method: "GET" }, apiKey);
  assert(histRes.ok && Array.isArray(histRes.data?.data?.events), "GET /:id/history returns event timeline");

  // ─── TEST 14: Dispute & Resolution ───
  console.log(`\n${colors.bold}14. Dispute & Arbitration Flow${colors.reset}`);
  // Create a separate deal to dispute
  const disputeDealRes = await request("", {
    method: "POST",
    body: {
      title: "Dispute Test Deal",
      amount: 500,
      currency: "USD",
      buyerEmail: `buyer_disp_${Date.now()}@test.com`,
      sellerEmail: `seller_disp_${Date.now()}@test.com`,
    },
  }, apiKey);
  const dispDealId = disputeDealRes.data?.data?.id;
  const dispMilestoneId = disputeDealRes.data?.data?.milestones?.[0]?.id;

  if (dispDealId && dispMilestoneId) {
    // Fund & start
    const bId = disputeDealRes.data?.data?.buyer?.id;
    await db.query("UPDATE wallets SET balance = balance + 2000 WHERE user_id = ?", [bId]);
    await request(`/${dispDealId}/milestones/${dispMilestoneId}/fund`, { method: "POST" }, apiKey);
    await request(`/${dispDealId}/status`, { method: "PATCH", body: { status: "inprogress" } }, apiKey);

    // Open dispute
    const openDispRes = await request(`/${dispDealId}/dispute`, {
      method: "POST",
      body: { reason: "Work not delivered according to specs.", raisedByRole: "buyer" },
    }, apiKey);
    assert(openDispRes.ok, "POST /:id/dispute files formal dispute");

    // Get dispute
    const getDispRes = await request(`/${dispDealId}/dispute`, { method: "GET" }, apiKey);
    assert(getDispRes.ok && getDispRes.data.success, "GET /:id/dispute retrieves dispute info");

    // Resolve dispute
    const resolveDispRes = await request(`/${dispDealId}/dispute/resolve`, {
      method: "PATCH",
      body: { winner: "buyer", resolution: "Refunded to client due to non-delivery." },
    }, apiKey);
    assert(resolveDispRes.ok, "PATCH /:id/dispute/resolve arbitrates and resolves dispute");
  }

  // ─── TEST 15: Banking & Withdrawals ───
  console.log(`\n${colors.bold}15. Banking & Withdrawals${colors.reset}`);
  const bankRes = await request("/wallet/bank-accounts", {
    method: "POST",
    body: {
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "DevStudio Technologies LTD",
    },
  }, apiKey);
  assert(bankRes.status === 201, "POST /wallet/bank-accounts saves bank account");

  const listBanksRes = await request("/wallet/bank-accounts", { method: "GET" }, apiKey);
  assert(listBanksRes.ok && listBanksRes.data?.data?.length > 0, "GET /wallet/bank-accounts lists bank accounts");

  const listWithdrawRes = await request("/wallet/withdrawals", { method: "GET" }, apiKey);
  assert(listWithdrawRes.ok, "GET /wallet/withdrawals lists withdrawal history");

  // ─── TEST 16: Webhook Logs ───
  console.log(`\n${colors.bold}16. Webhook Deliveries & Logs${colors.reset}`);
  const webhooksRes = await request("/webhooks/deliveries", { method: "GET" }, apiKey);
  assert(webhooksRes.ok, "GET /webhooks/deliveries lists webhook events");

  console.log(`\n${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}Test Results Summary:${colors.reset}`);
  console.log(`  ${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTestSuite().catch((err) => {
  console.error("Test runner encountered an error:", err);
  process.exit(1);
});
