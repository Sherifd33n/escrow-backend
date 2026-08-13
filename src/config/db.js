import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  multipleStatements: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

let pool;

export async function initDatabase() {
  try {
    // Connect without database first
    const connection = await mysql.createConnection(dbConfig);
    console.log("Connected to MySQL server.");

    // Create database if not exists
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || "escrow_db"}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    );
    console.log(
      `Database \`${process.env.DB_NAME || "escrow_db"}\` checked/created.`,
    );
    await connection.end();

    // Now initialize pool with the database specified
    pool = mysql.createPool({
      ...dbConfig,
      database: process.env.DB_NAME || "escrow_db",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    // Run schema.sql to create tables if they don't exist
    const schemaPath = path.join(__dirname, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, "utf8");
      const conn = await pool.getConnection();
      try {
        await conn.query(schemaSql);
        console.log("Database schema successfully verified/initialized.");

        // Run migration to add columns if they are missing
        await runMigrations(conn);
      } finally {
        conn.release();
      }
    } else {
      console.warn("schema.sql not found, skipping table initialization.");
    }
  } catch (error) {
    console.error("Database initialization failed:", error);
    process.exit(1);
  }
}

async function runMigrations(conn) {
  // Check and rename old columns if they exist
  try {
    const [discoveryCols] = await conn.query(
      "SHOW COLUMNS FROM users LIKE 'privacy_discovery'",
    );
    if (discoveryCols.length > 0) {
      console.log("Migration: Renaming privacy_discovery to public_profile...");
      await conn.query(
        "ALTER TABLE users CHANGE COLUMN privacy_discovery public_profile TINYINT(1) NOT NULL DEFAULT 1",
      );
    }
  } catch (err) {
    console.error("Migration failed to rename privacy_discovery:", err);
  }

  try {
    const [marketingCols] = await conn.query(
      "SHOW COLUMNS FROM users LIKE 'privacy_marketing'",
    );
    if (marketingCols.length > 0) {
      console.log(
        "Migration: Renaming privacy_marketing to marketing_comms...",
      );
      await conn.query(
        "ALTER TABLE users CHANGE COLUMN privacy_marketing marketing_comms TINYINT(1) NOT NULL DEFAULT 0",
      );
    }
  } catch (err) {
    console.error("Migration failed to rename privacy_marketing:", err);
  }

  const columnsToAdd = [
    {
      name: "phone",
      definition: "VARCHAR(20) DEFAULT NULL",
    },
    {
      name: "phone_verified",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "phone_verified_at",
      definition: "TIMESTAMP NULL DEFAULT NULL",
    },
    {
      name: "kyc_tier",
      definition: "INT NOT NULL DEFAULT 1",
    },
    {
      name: "is_verified",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "email_verified_at",
      definition: "TIMESTAMP NULL DEFAULT NULL",
    },
    {
      name: "two_factor_enabled",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "notif_email",
      definition: "TINYINT(1) NOT NULL DEFAULT 1",
    },
    {
      name: "notif_sms",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "notif_push",
      definition: "TINYINT(1) NOT NULL DEFAULT 1",
    },
    {
      name: "public_profile",
      definition: "TINYINT(1) NOT NULL DEFAULT 1",
    },
    {
      name: "marketing_comms",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "is_active",
      definition: "TINYINT(1) NOT NULL DEFAULT 1",
    },
  ];

  for (const col of columnsToAdd) {
    const [rows] = await conn.query("SHOW COLUMNS FROM users LIKE ?", [
      col.name,
    ]);

    if (rows.length === 0) {
      console.log(`Migration: Added users.${col.name}`);
      await conn.query(
        `ALTER TABLE users ADD COLUMN \`${col.name}\` ${col.definition}`,
      );
    }
  }

  // ----------------------------------------------------
  // OTP TABLE MIGRATIONS
  // ----------------------------------------------------

  const otpColumns = [
    {
      name: "email",
      definition: "VARCHAR(255) DEFAULT NULL",
    },

    {
      name: "phone",
      definition: "VARCHAR(20) DEFAULT NULL",
    },

    {
      name: "code",
      definition: "VARCHAR(255) NOT NULL",
    },

    {
      name: "attempts",
      definition: "INT NOT NULL DEFAULT 0",
    },
  ];

  for (const col of otpColumns) {
    try {
      const [rows] = await conn.query(`SHOW COLUMNS FROM otp_codes LIKE ?`, [
        col.name,
      ]);

      if (rows.length === 0) {
        console.log(`Migration: Adding otp_codes.${col.name}`);

        await conn.query(
          `ALTER TABLE otp_codes ADD COLUMN \`${col.name}\` ${col.definition}`,
        );
      }
    } catch (err) {
      console.error(`Migration failed for otp_codes.${col.name}`, err);
    }
  }

  // ----------------------------------------------------
  // REMOVE OLD UNIQUE INDEX ON PHONE (IF EXISTS)
  // ----------------------------------------------------

  try {
    const [indexes] = await conn.query(`
    SHOW INDEX FROM users
    WHERE Column_name='phone'
      AND Non_unique = 0
      AND Key_name <> 'PRIMARY'
  `);

    for (const index of indexes) {
      await conn.query(`ALTER TABLE users DROP INDEX \`${index.Key_name}\``);
      console.log(
        `Migration: Dropped unique index ${index.Key_name} from phone.`,
      );
    }
  } catch (err) {
    console.error("Migration failed removing phone unique index:", err);
  }

  // ----------------------------------------------------
  // VERIFY OTP TABLE STRUCTURE
  // ----------------------------------------------------

  try {
    await conn.query(`
    ALTER TABLE otp_codes
    MODIFY COLUMN type ENUM(
      'signup',
      'forgot',
      'phone_verification'
    ) NOT NULL DEFAULT 'signup'
  `);

    console.log("Migration: otp_codes.type verified.");
  } catch (err) {
    console.error("Failed updating otp_codes.type", err);
  }

  // ----------------------------------------------------
  // VERIFY EXISTING NULL VALUES
  // ----------------------------------------------------

  try {
    await conn.query(`
  UPDATE users
SET phone_verified = 0
WHERE phone_verified IS NULL;

`);
    await conn.query(`
UPDATE users
SET kyc_tier = 1
WHERE kyc_tier IS NULL;
`);

    await conn.query(`
UPDATE users
SET is_verified = 0
WHERE is_verified IS NULL;
`);
  } catch (err) {
    console.error("Migration failed:", err);
  }

  // ----------------------------------------------------
  // FIX milestones.status ENUM (add submitted/approved/rejected)
  // ----------------------------------------------------

  try {
    await conn.query(`
    ALTER TABLE transactions
    MODIFY COLUMN status ENUM(
      'pending',
      'funded',
      'inprogress',
      'inspection',
      'audit',
      'approved',
      'revision',
      'completed',
      'disputed'
    ) NOT NULL DEFAULT 'pending'
  `);

    console.log("Migration: transactions.status updated.");
  } catch (err) {
    console.error("Failed updating transactions.status:", err);
  }

  try {
    await conn.query(`
      ALTER TABLE milestones
      MODIFY COLUMN status ENUM(
        'pending', 'paid', 'due', 'upcoming',
        'submitted', 'approved', 'rejected'
      ) NOT NULL DEFAULT 'pending'
    `);
    console.log("Migration: milestones.status ENUM updated.");
  } catch (err) {
    console.error("Migration failed to update milestones.status ENUM:", err);
  }

  // ----------------------------------------------------
  // CREATE notifications TABLE
  // ----------------------------------------------------

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`notifications\` (
        \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\`    INT          NOT NULL,
        \`type\`       VARCHAR(60)  NOT NULL,
        \`title\`      VARCHAR(255) NOT NULL,
        \`message\`    TEXT         NOT NULL,
        \`channel\`    ENUM('in_app','email','sms','push') NOT NULL DEFAULT 'in_app',
        \`is_read\`    TINYINT(1)   NOT NULL DEFAULT 0,
        \`metadata\`   JSON         DEFAULT NULL,
        \`created_at\` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_notifications_user_read\` (\`user_id\`, \`is_read\`),
        INDEX \`idx_notifications_type\`      (\`type\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: notifications table checked/created.");
  } catch (err) {
    console.error("Migration failed to create notifications table:", err);
  }

  // ----------------------------------------------------
  // CREATE push_subscriptions TABLE
  // ----------------------------------------------------

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`push_subscriptions\` (
        \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\`    INT          NOT NULL,
        \`endpoint\`   TEXT         NOT NULL,
        \`p256dh\`     VARCHAR(255) NOT NULL,
        \`auth\`       VARCHAR(255) NOT NULL,
        \`created_at\` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_push_subs_user\` (\`user_id\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("Migration: push_subscriptions table checked/created.");
  } catch (err) {
    console.error("Migration failed to create push_subscriptions table:", err);
  }

  // ----------------------------------------------------
  // TRANSACTIONS TABLE FEE COLUMNS MIGRATION
  // ----------------------------------------------------
  try {
    const [feeRateCols] = await conn.query("SHOW COLUMNS FROM transactions LIKE 'escrow_fee_rate'");
    if (feeRateCols.length === 0) {
      await conn.query("ALTER TABLE transactions ADD COLUMN `escrow_fee_rate` DECIMAL(5, 4) NOT NULL DEFAULT 0.0350");
      console.log("Migration: Added transactions.escrow_fee_rate");
    }
    const [feeAmountCols] = await conn.query("SHOW COLUMNS FROM transactions LIKE 'escrow_fee_amount'");
    if (feeAmountCols.length === 0) {
      await conn.query("ALTER TABLE transactions ADD COLUMN `escrow_fee_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00");
      console.log("Migration: Added transactions.escrow_fee_amount");
    }
    const [ebCols] = await conn.query("SHOW COLUMNS FROM transactions LIKE 'escrow_balance'");
    if (ebCols.length === 0) {
      await conn.query("ALTER TABLE transactions ADD COLUMN `escrow_balance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00");
      console.log("Migration: Added transactions.escrow_balance");
    }
    const [raCols] = await conn.query("SHOW COLUMNS FROM transactions LIKE 'released_amount'");
    if (raCols.length === 0) {
      await conn.query("ALTER TABLE transactions ADD COLUMN `released_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00");
      console.log("Migration: Added transactions.released_amount");
    }
  } catch (err) {
    console.error("Migration failed for transaction fee/balance columns:", err);
  }

  // ----------------------------------------------------
  // SUBSCRIPTIONS TABLE EXTENSION MIGRATION
  // ----------------------------------------------------
  try {
    await conn.query(`
      ALTER TABLE subscriptions
      MODIFY COLUMN status ENUM('pending', 'active', 'past_due', 'cancelled', 'expired', 'suspended') NOT NULL DEFAULT 'active'
    `);
  } catch (err) {
    console.error("Migration failed to update subscriptions.status ENUM:", err);
  }

  const subColumns = [
    { name: "payment_provider", definition: "VARCHAR(50) DEFAULT NULL" },
    { name: "provider_customer_id", definition: "VARCHAR(255) DEFAULT NULL" },
    { name: "provider_subscription_id", definition: "VARCHAR(255) DEFAULT NULL" },
    { name: "provider_reference_id", definition: "VARCHAR(255) DEFAULT NULL" },
    { name: "auto_renew", definition: "TINYINT(1) NOT NULL DEFAULT 1" },
    { name: "cancelled_at", definition: "TIMESTAMP NULL DEFAULT NULL" },
    { name: "metadata", definition: "JSON DEFAULT NULL" }
  ];

  for (const col of subColumns) {
    try {
      const [rows] = await conn.query("SHOW COLUMNS FROM subscriptions LIKE ?", [col.name]);
      if (rows.length === 0) {
        await conn.query(`ALTER TABLE subscriptions ADD COLUMN \`${col.name}\` ${col.definition}`);
        console.log(`Migration: Added subscriptions.${col.name}`);
      }
    } catch (err) {
      console.error(`Migration failed for subscriptions.${col.name}`, err);
    }
  }

  // ----------------------------------------------------
  // CREATE subscriptions_history TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`subscriptions_history\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`plan_id\` VARCHAR(50) NOT NULL,
        \`billing_cycle\` ENUM('monthly', 'annual') NOT NULL DEFAULT 'monthly',
        \`status\` VARCHAR(50) NOT NULL,
        \`starts_at\` TIMESTAMP NULL DEFAULT NULL,
        \`ends_at\` TIMESTAMP NULL DEFAULT NULL,
        \`payment_provider\` VARCHAR(50) DEFAULT NULL,
        \`provider_reference_id\` VARCHAR(255) DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_sub_hist_user\` (\`user_id\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: subscriptions_history table checked/created.");
  } catch (err) {
    console.error("Migration failed to create subscriptions_history table:", err);
  }

  // ----------------------------------------------------
  // CREATE ai_usage TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`ai_usage\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`feature\` VARCHAR(50) NOT NULL,
        \`transaction_id\` INT DEFAULT NULL,
        \`metadata\` JSON DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_ai_usage_user_feature\` (\`user_id\`, \`feature\`, \`created_at\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: ai_usage table checked/created.");
  } catch (err) {
    console.error("Migration failed to create ai_usage table:", err);
  }

  // ----------------------------------------------------
  // DISPUTES TABLE LONGTEXT MIGRATION
  // ----------------------------------------------------
  try {
    await conn.query("ALTER TABLE disputes MODIFY COLUMN evidence LONGTEXT DEFAULT NULL");
    await conn.query("ALTER TABLE disputes MODIFY COLUMN reason LONGTEXT NOT NULL");
    console.log("Migration: Updated disputes.evidence and disputes.reason to LONGTEXT.");
  } catch (err) {
    console.error("Migration failed for disputes LONGTEXT columns:", err);
  }

  // ----------------------------------------------------
  // TRANSACTIONS SCOPE & TIMELINE MIGRATIONS
  // ----------------------------------------------------
  const txScopeColumns = [
    { name: "scope_json", definition: "JSON DEFAULT NULL" },
    { name: "ai_estimated_timeline", definition: "VARCHAR(100) DEFAULT NULL" },
    { name: "agreed_duration", definition: "VARCHAR(100) DEFAULT NULL" },
    { name: "agreed_deadline", definition: "TIMESTAMP NULL DEFAULT NULL" },
    { name: "revision_policy", definition: "VARCHAR(255) DEFAULT '2 rounds of minor revisions'" }
  ];

  for (const col of txScopeColumns) {
    try {
      const [rows] = await conn.query("SHOW COLUMNS FROM transactions LIKE ?", [col.name]);
      if (rows.length === 0) {
        await conn.query(`ALTER TABLE transactions ADD COLUMN \`${col.name}\` ${col.definition}`);
        console.log(`Migration: Added transactions.${col.name}`);
      }
    } catch (err) {
      console.error(`Migration failed for transactions.${col.name}`, err);
    }
  }

  // ----------------------------------------------------
  // MILESTONES EXTENSION MIGRATIONS
  // ----------------------------------------------------
  const milestoneColumns = [
    { name: "description", definition: "TEXT DEFAULT NULL" },
    { name: "ai_suggested_timeline", definition: "VARCHAR(100) DEFAULT NULL" },
    { name: "start_date", definition: "TIMESTAMP NULL DEFAULT NULL" },
    { name: "due_date", definition: "TIMESTAMP NULL DEFAULT NULL" }
  ];

  for (const col of milestoneColumns) {
    try {
      const [rows] = await conn.query("SHOW COLUMNS FROM milestones LIKE ?", [col.name]);
      if (rows.length === 0) {
        await conn.query(`ALTER TABLE milestones ADD COLUMN \`${col.name}\` ${col.definition}`);
        console.log(`Migration: Added milestones.${col.name}`);
      }
    } catch (err) {
      console.error(`Migration failed for milestones.${col.name}`, err);
    }
  }

  // ----------------------------------------------------
  // CREATE transaction_events TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`transaction_events\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`transaction_id\` INT NOT NULL,
        \`user_id\` INT NOT NULL,
        \`action\` VARCHAR(100) NOT NULL,
        \`from_status\` VARCHAR(50) DEFAULT NULL,
        \`to_status\` VARCHAR(50) DEFAULT NULL,
        \`note\` TEXT DEFAULT NULL,
        \`metadata\` JSON DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_tx_events_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: transaction_events table checked/created.");
  } catch (err) {
    console.error("Migration failed to create transaction_events table:", err);
  }

  // ----------------------------------------------------
  // CREATE milestone_submissions TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`milestone_submissions\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`transaction_id\` INT NOT NULL,
        \`milestone_id\` INT NOT NULL,
        \`submitted_by\` INT NOT NULL,
        \`version\` INT NOT NULL DEFAULT 1,
        \`deliverable_note\` TEXT NOT NULL,
        \`attachments\` JSON DEFAULT NULL,
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'submitted',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_m_sub_tx_m\` (\`transaction_id\`, \`milestone_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`milestone_id\`) REFERENCES \`milestones\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`submitted_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: milestone_submissions table checked/created.");
  } catch (err) {
    console.error("Migration failed to create milestone_submissions table:", err);
  }

  // ----------------------------------------------------
  // CREATE revision_requests TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`revision_requests\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`transaction_id\` INT NOT NULL,
        \`milestone_id\` INT NOT NULL,
        \`submission_id\` INT DEFAULT NULL,
        \`requested_by\` INT NOT NULL,
        \`reason\` VARCHAR(255) DEFAULT NULL,
        \`details\` TEXT NOT NULL,
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'open',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_rev_req_tx_m\` (\`transaction_id\`, \`milestone_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`milestone_id\`) REFERENCES \`milestones\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`requested_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: revision_requests table checked/created.");
  } catch (err) {
    console.error("Migration failed to create revision_requests table:", err);
  }

  // ----------------------------------------------------
  // CREATE ai_audits TABLE
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`ai_audits\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`transaction_id\` INT NOT NULL,
        \`milestone_id\` INT DEFAULT NULL,
        \`submission_id\` INT DEFAULT NULL,
        \`audited_by\` INT NOT NULL,
        \`score\` INT NOT NULL DEFAULT 0,
        \`status\` VARCHAR(50) NOT NULL,
        \`risk\` VARCHAR(50) NOT NULL,
        \`risk_score\` INT NOT NULL DEFAULT 0,
        \`summary\` TEXT NOT NULL,
        \`recommendation\` TEXT NOT NULL,
        \`checks_json\` JSON DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_ai_audits_tx\` (\`transaction_id\`),
        INDEX \`idx_ai_audits_m\` (\`milestone_id\`),
        INDEX \`idx_ai_audits_sub\` (\`submission_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`audited_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: ai_audits table checked/created.");
  } catch (err) {
    console.error("Migration failed to create ai_audits table:", err);
  }
}

export async function query(sql, params) {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initDatabase first.");
  }

  const [results] = await pool.query(sql, params);
  return results;
}

export default {
  initDatabase,
  query,
  getPool: () => pool,
};
