import dns from "dns";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}
try {
  dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch (e) {
  // Ignore in case environment restricts custom DNS
}

import db, { initDatabase } from "../src/config/db.js";
import { checkAndNotifyExpiredDeadlines, parseDurationToMs } from "../src/services/jobs/deadlineWorker.js";
import { isEmailConfigured } from "../src/services/emailService.js";
import { buildEmailContent } from "../src/services/notificationTemplates.js";
import { NOTIFICATION_TYPE } from "../src/constants/notificationTypes.js";

async function runTest() {
  console.log("==================================================");
  console.log("   LUMBRR DEADLINE WORKER & EMAIL SYSTEM TEST    ");
  console.log("==================================================");

  // 1. Check SMTP Config
  console.log(`\n[1] Checking SMTP configuration...`);
  const emailReady = isEmailConfigured();
  console.log(`    SMTP configured: ${emailReady ? "YES ✅" : "NO ⚠️"}`);
  console.log(`    SMTP Host: ${process.env.SMTP_HOST || "not set"}`);
  console.log(`    SMTP Port: ${process.env.SMTP_PORT || "not set"}`);
  console.log(`    SMTP From: ${process.env.SMTP_FROM || "not set"}`);

  // 2. Test duration parser
  console.log(`\n[2] Testing duration parser...`);
  const tests = [
    { input: "3 days", expectedDays: 3 },
    { input: "14 days", expectedDays: 14 },
    { input: "1 week", expectedDays: 7 },
    { input: "1 month", expectedDays: 30 },
  ];
  for (const t of tests) {
    const ms = parseDurationToMs(t.input);
    const days = ms ? ms / (24 * 60 * 60 * 1000) : null;
    const passed = days === t.expectedDays;
    console.log(`    "${t.input}" -> ${days} days ${passed ? "✅" : "❌"}`);
  }

  // 3. Test Email Template Generation
  console.log(`\n[3] Testing email template generation...`);
  const emailContent = buildEmailContent(NOTIFICATION_TYPE.TRANSACTION_DEADLINE_REACHED, {
    transaction: "Full-Stack Web App Delivery",
    code: "TXN-12345-6789",
    deadline: "Sep 10, 2026",
    amount: "1500.00",
    recipientName: "Test Provider",
    dashboardUrl: "http://localhost:5173",
  });

  if (emailContent && emailContent.subject && emailContent.html) {
    console.log(`    Subject: "${emailContent.subject}" ✅`);
    console.log(`    HTML length: ${emailContent.html.length} bytes ✅`);
  } else {
    console.error(`    Failed to build email content! ❌`);
  }

  // 4. Test Database Connection & Scan Loop
  console.log(`\n[4] Initializing database and running deadline scan...`);
  try {
    await initDatabase();
    console.log(`    Database initialized successfully.`);

    const pool = db.getPool();
    const [activeTxns] = await pool.query(`
      SELECT id, txn_code, title, status, agreed_duration, agreed_deadline, deadline_notified_at
      FROM transactions
      WHERE status IN ('funded', 'inprogress', 'revision')
      ORDER BY id DESC
      LIMIT 10
    `);

    console.log(`    Active transactions in funded/inprogress/revision states: ${activeTxns.length}`);
    if (activeTxns.length > 0) {
      console.log(`    Sample active transactions:`);
      for (const tx of activeTxns) {
        console.log(`      - #${tx.id} [${tx.txn_code}] status=${tx.status} deadline=${tx.agreed_deadline || "NULL"} duration=${tx.agreed_duration || "NULL"} notified=${tx.deadline_notified_at || "NULL"}`);
      }
    }

    console.log(`\n[5] Executing checkAndNotifyExpiredDeadlines()...`);
    await checkAndNotifyExpiredDeadlines();
    console.log(`    Deadline check executed without errors. ✅`);

  } catch (dbErr) {
    console.error(`    Database or execution error:`, dbErr.message);
  }

  console.log("\n==================================================");
  console.log("   DEADLINE WORKER TEST COMPLETE                  ");
  console.log("==================================================");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
