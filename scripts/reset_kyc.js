import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log("Connected to database:", process.env.DB_NAME);

  const [users] = await conn.query("SELECT id, name, email, role, kyc_tier, is_verified FROM users");
  console.log("--- BEFORE RESET ---");
  console.table(users);

  const [subs] = await conn.query("SELECT id, user_id, status, created_at FROM kyc_submissions");
  console.log("--- KYC SUBMISSIONS BEFORE RESET ---");
  console.table(subs);

  // Reset KYC status for all users (or client users)
  const [updateRes] = await conn.query("UPDATE users SET kyc_tier = 1, is_verified = 0");
  console.log("Updated users count:", updateRes.affectedRows);

  const [delRes] = await conn.query("DELETE FROM kyc_submissions");
  console.log("Deleted kyc_submissions count:", delRes.affectedRows);

  const [updatedUsers] = await conn.query("SELECT id, name, email, role, kyc_tier, is_verified FROM users");
  console.log("--- AFTER RESET ---");
  console.table(updatedUsers);

  await conn.end();
  console.log("KYC successfully reset!");
  process.exit(0);
}

run().catch((err) => {
  console.error("Error resetting KYC:", err);
  process.exit(1);
});
