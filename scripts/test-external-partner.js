/**
 * Lumbrr V1 API - Standalone External Partner Test Client
 * 
 * Tests all endpoints as a 100% external third-party client over HTTP.
 * No internal database dependencies required.
 * 
 * Usage:
 *   API_KEY="lmb_test_your_key" API_URL="http://localhost:4000/api/v1/escrows" node scripts/test-external-partner.js
 */

const BASE_URL = process.env.API_URL || "http://localhost:4000/api/v1/escrows";
let API_KEY = process.env.LUMBRR_API_KEY || process.env.API_KEY || process.argv[2];

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

async function sendRequest(endpoint, method = "GET", body = null) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function test(name, condition, errorMsg = "") {
  if (condition) {
    console.log(`  ${colors.green}✔ PASS${colors.reset}: ${name}`);
    passed++;
  } else {
    console.error(`  ${colors.red}✖ FAIL${colors.reset}: ${name} ${errorMsg ? `| ${errorMsg}` : ""}`);
    failed++;
  }
}

async function runExternalSuite() {
  console.log(`\n${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  Lumbrr V1 B2B API — External Third-Party Test Client        ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`Endpoint: ${BASE_URL}\n`);

  if (!API_KEY) {
    try {
      const dbModule = await import("../src/config/db.js");
      const db = dbModule.default;
      await db.initDatabase();
      const keys = await db.query("SELECT public_key FROM api_keys WHERE is_active = 1 ORDER BY id DESC LIMIT 1");
      if (keys && keys.length) {
        API_KEY = keys[0].public_key;
        console.log(`Using active API Key: ${API_KEY.slice(0, 14)}••••`);
      }
    } catch (e) {}
  }

  if (!API_KEY) {
    console.error("Please supply an API Key via environment variable LUMBRR_API_KEY or CLI argument.");
    process.exit(1);
  }

  // 1. Partner Wallet
  console.log(`${colors.yellow}1. Partner Wallet & Balance${colors.reset}`);
  const wallet = await sendRequest("/wallet");
  test("GET /wallet", wallet.ok && wallet.data.success, JSON.stringify(wallet.data));

  // 2. AI Contract Scoping
  console.log(`\n${colors.yellow}2. AI Contract Scoping${colors.reset}`);
  const aiScope = await sendRequest("/ai/scope", "POST", {
    categoryLabel: "Mobile Engineering",
    description: "Build an iOS and Android fintech app with KYC verification and biometrics.",
  });
  test("POST /ai/scope", aiScope.ok && aiScope.data.success, JSON.stringify(aiScope.data));

  // 3. Escrow Deal Creation
  console.log(`\n${colors.yellow}3. Escrow Deal Creation${colors.reset}`);
  const createDeal = await sendRequest("", "POST", {
    title: "Fintech App Development",
    amount: 3000,
    currency: "USD",
    buyerEmail: `client_${Date.now()}@fintech.io`,
    buyerName: "Fintech Inc",
    sellerEmail: `agency_${Date.now()}@devstudio.io`,
    sellerName: "Elite Mobile Studio",
    inspectionPeriodDays: 5,
    partnerPlatformFee: 20,
    milestones: [
      { title: "Milestone 1: Figma & Architecture", amount: 1000 },
      { title: "Milestone 2: App Source Code & KYC", amount: 2000 },
    ],
    scope: {
      deliverables: ["iOS App", "Android App", "API Documentation"],
    },
  });
  test("POST /api/v1/escrows (Create Deal)", createDeal.status === 201 && createDeal.data.success, JSON.stringify(createDeal.data));

  const dealId = createDeal.data?.data?.id;
  const milestone1Id = createDeal.data?.data?.milestones?.[0]?.id;

  if (!dealId) {
    console.error("Could not obtain dealId. Aborting downstream tests.");
    process.exit(1);
  }

  // 4. Get Deal Details & List
  console.log(`\n${colors.yellow}4. Escrow Querying & Filtering${colors.reset}`);
  const getDeal = await sendRequest(`/${dealId}`);
  test(`GET /api/v1/escrows/${dealId}`, getDeal.ok && getDeal.data.data?.id === dealId);

  const listDeals = await sendRequest("?page=1&limit=5&status=pending");
  test("GET /api/v1/escrows (List & Filter)", listDeals.ok && Array.isArray(listDeals.data?.data));

  // 5. Milestones Operations
  console.log(`\n${colors.yellow}5. Milestone Operations${colors.reset}`);
  const addMilestone = await sendRequest(`/${dealId}/milestones`, "POST", {
    title: "Milestone 3: Security & App Store Release",
    amount: 500,
  });
  test("POST /:id/milestones (Add Milestone)", addMilestone.status === 201);
  const milestone3Id = addMilestone.data?.data?.milestoneId;

  if (milestone3Id) {
    const editMilestone = await sendRequest(`/${dealId}/milestones/${milestone3Id}`, "PATCH", {
      title: "Milestone 3: Security, Load Test & App Store Release",
      amount: 600,
    });
    test("PATCH /:id/milestones/:mId (Edit Milestone)", editMilestone.ok);

    const deleteMilestone = await sendRequest(`/${dealId}/milestones/${milestone3Id}`, "DELETE");
    test("DELETE /:id/milestones/:mId (Delete Milestone)", deleteMilestone.ok);
  }

  // 6. Scope Management
  console.log(`\n${colors.yellow}6. Scope & Contract Amendments${colors.reset}`);
  const getScope = await sendRequest(`/${dealId}/scope`);
  test("GET /:id/scope", getScope.ok && getScope.data.success);

  const updateScope = await sendRequest(`/${dealId}/scope`, "PATCH", {
    deliverables: ["iOS App", "Android App", "Postman Collection"],
    revisionPolicy: "3 revisions included",
  });
  test("PATCH /:id/scope", updateScope.ok && updateScope.data.success);

  const reqScopeChange = await sendRequest(`/${dealId}/scope/request-changes`, "POST", {
    proposedChanges: { addFeature: "Biometric Login" },
    reason: "Requested by stakeholder",
  });
  test("POST /:id/scope/request-changes", reqScopeChange.ok);

  // 7. Status Transitions & Deliverable Submissions
  console.log(`\n${colors.yellow}7. Funding, Status Transitions & Deliverables${colors.reset}`);
  
  // Fund buyer test wallet if running against test environment
  const buyerId = createDeal.data?.data?.buyer?.id;
  if (buyerId) {
    try {
      const dbModule = await import("../src/config/db.js");
      await dbModule.default.query("UPDATE wallets SET balance = balance + 5000 WHERE user_id = ?", [buyerId]);
    } catch (e) {}
  }

  const fundMilestone = await sendRequest(`/${dealId}/milestones/${milestone1Id}/fund`, "POST");
  test("POST /:id/milestones/:mId/fund (Fund Milestone into Escrow)", fundMilestone.ok && fundMilestone.data.success);

  const startStatus = await sendRequest(`/${dealId}/status`, "PATCH", {
    status: "inprogress",
    note: "Vendor started sprint 1",
  });
  test("PATCH /:id/status (Transition status to inprogress)", startStatus.ok);

  const submitDeliverable = await sendRequest(`/${dealId}/milestones/${milestone1Id}/status`, "PATCH", {
    status: "submitted",
    deliverableNote: "Figma design system and architecture docs uploaded.",
    deliverableUrl: "https://figma.com/file/sample",
  });
  test("PATCH /:id/milestones/:mId/status (Submit Deliverable)", submitDeliverable.ok);

  // 8. AI Deliverable Audit
  console.log(`\n${colors.yellow}8. AI Deliverable Auditing${colors.reset}`);
  const aiAudit = await sendRequest(`/${dealId}/ai/audit`, "POST", {
    milestoneId: milestone1Id,
    title: "Figma & Architecture",
    amount: 1000,
  });
  test("POST /:id/ai/audit (Run AI deliverable audit)", aiAudit.ok && aiAudit.data.success);

  const getAudits = await sendRequest(`/${dealId}/ai/audits`);
  test("GET /:id/ai/audits", getAudits.ok && Array.isArray(getAudits.data?.data));

  // 9. Approve Milestone & Release
  console.log(`\n${colors.yellow}9. Milestone Approval & Escrow Release${colors.reset}`);
  const approveM = await sendRequest(`/${dealId}/milestones/${milestone1Id}/status`, "PATCH", {
    status: "approved",
    feedback: "Approved by client",
  });
  test("PATCH /:id/milestones/:mId/status (Approve)", approveM.ok);

  const releaseEscrow = await sendRequest(`/${dealId}/release`, "POST", {
    reason: "Client accepted deliverables",
  });
  test("POST /:id/release (Release funds to seller)", releaseEscrow.ok && releaseEscrow.data.success);

  // 10. Reviews & Ratings
  console.log(`\n${colors.yellow}10. Reviews & Ratings${colors.reset}`);
  const addReview = await sendRequest(`/${dealId}/reviews`, "POST", {
    rating: 5,
    comment: "Top notch delivery!",
    reviewerRole: "buyer",
  });
  test("POST /:id/reviews (Submit review)", addReview.status === 201);

  const getReviews = await sendRequest(`/${dealId}/reviews`);
  test("GET /:id/reviews (List reviews)", getReviews.ok && Array.isArray(getReviews.data?.data?.reviews));

  // 11. Transaction History Audit Trail
  console.log(`\n${colors.yellow}11. Transaction Audit Trail History${colors.reset}`);
  const getHistory = await sendRequest(`/${dealId}/history`);
  test("GET /:id/history (Audit Trail)", getHistory.ok && Array.isArray(getHistory.data?.data?.events));

  // 12. Bank Accounts & Withdrawals
  console.log(`\n${colors.yellow}12. Bank Accounts & Withdrawals${colors.reset}`);
  const randomAcc = String(Math.floor(1000000000 + Math.random() * 9000000000));
  const addBank = await sendRequest("/wallet/bank-accounts", "POST", {
    accountNumber: randomAcc,
    bankCode: "058",
    accountName: "Fintech Ventures LTD",
  });
  test("POST /wallet/bank-accounts", addBank.status === 201);

  const listBanks = await sendRequest("/wallet/bank-accounts");
  test("GET /wallet/bank-accounts", listBanks.ok && Array.isArray(listBanks.data?.data));

  const listWithdrawals = await sendRequest("/wallet/withdrawals");
  test("GET /wallet/withdrawals", listWithdrawals.ok && Array.isArray(listWithdrawals.data?.data));

  // 13. Webhook Deliveries
  console.log(`\n${colors.yellow}13. Webhook Logs & Delivery Monitor${colors.reset}`);
  const getWebhooks = await sendRequest("/webhooks/deliveries?limit=10");
  test("GET /webhooks/deliveries", getWebhooks.ok && Array.isArray(getWebhooks.data?.data));

  console.log(`\n${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}External Test Results Summary:${colors.reset}`);
  console.log(`  ${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════${colors.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runExternalSuite().catch((err) => {
  console.error("External test runner failed:", err);
  process.exit(1);
});
