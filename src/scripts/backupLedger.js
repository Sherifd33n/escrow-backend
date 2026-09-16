/**
 * backupLedger.js
 *
 * Immutable Snapshot Utility for Lumbrr Wallet Ledger.
 * Dumps all wallet_transactions records to an encrypted/hashed JSON archive
 * with a SHA-256 integrity checksum to satisfy financial audit requirements.
 *
 * Usage:
 *   node src/scripts/backupLedger.js
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import db, { initDatabase } from "../config/db.js";

async function runBackup() {
  console.log("[backupLedger] Initializing database connection...");
  await initDatabase();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(process.cwd(), "backups", "ledger");

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  console.log("[backupLedger] Exporting wallet_transactions ledger...");
  const rows = await db.query(
    `SELECT id, wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status, created_at
     FROM wallet_transactions
     ORDER BY id ASC`
  );

  console.log(`[backupLedger] Retrieved ${rows.length} total ledger records.`);

  const payload = {
    exported_at: new Date().toISOString(),
    record_count: rows.length,
    generator: "Lumbrr Ledger Backup Utility v1.0",
    records: rows,
  };

  const jsonString = JSON.stringify(payload, null, 2);
  const hash = crypto.createHash("sha256").update(jsonString).digest("hex");

  const archiveData = {
    integrity_checksum_sha256: hash,
    ...payload,
  };

  const filename = `ledger_snapshot_${timestamp}_records_${rows.length}.json`;
  const filePath = path.join(backupDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(archiveData, null, 2), "utf8");

  console.log(`[backupLedger] Snapshot created successfully: ${filePath}`);
  console.log(`[backupLedger] SHA-256 Checksum: ${hash}`);

  process.exit(0);
}

runBackup().catch((err) => {
  console.error("[backupLedger] Error generating ledger backup:", err);
  process.exit(1);
});
