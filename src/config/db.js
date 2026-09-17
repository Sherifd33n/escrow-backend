import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dns from "dns";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const databaseName = process.env.DB_NAME || "escrow_db";

const isAiven = process.env.DB_HOST?.includes("aivencloud.com");

const caPath = path.join(__dirname, "ca.pem");

let aivenCa;

if (isAiven) {
  if (process.env.AIVEN_CA_CERT) {
    aivenCa = process.env.AIVEN_CA_CERT;
  } else if (fs.existsSync(caPath)) {
    aivenCa = fs.readFileSync(caPath);
  } else {
    throw new Error(
      `Aiven database is configured but no CA certificate was found. Set AIVEN_CA_CERT or provide ${caPath}.`,
    );
  }
}

const sslConfig = isAiven
  ? {
      ca: aivenCa,
      rejectUnauthorized: true,
      servername: process.env.DB_HOST,
    }
  : undefined;

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  timezone: "Z",
  multipleStatements: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 30000,

  ...(sslConfig ? { ssl: sslConfig } : {}),
};

let pool;

async function resolveHost(host) {
  if (!host || host === "localhost" || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host;
  }

  // Aiven requires the hostname for TLS certificate verification,
  // but we can use public DNS to resolve it to an IP when the
  // system DNS resolver is failing.
  if (isAiven) {
    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(["8.8.8.8", "1.1.1.1"]);

      const addresses = await resolver.resolve4(host);

      if (addresses && addresses.length > 0) {
        console.log(
          `Resolved Aiven host ${host} to ${addresses[0]} via public DNS.`,
        );
        return addresses[0];
      }
    } catch (err) {
      console.warn(
        `Public DNS could not resolve Aiven host ${host}:`,
        err.message,
      );
    }

    return host;
  }
  try {
    const res = await dns.promises.lookup(host, { family: 4 });
    return res.address;
  } catch (err) {
    console.warn(
      `System DNS lookup failed for ${host} (${err.code || err.message}). Trying public DNS fallback (8.8.8.8, 1.1.1.1)...`,
    );

    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(["8.8.8.8", "1.1.1.1"]);
      const addresses = await resolver.resolve4(host);

      if (addresses && addresses.length > 0) {
        console.log(
          `Successfully resolved ${host} to ${addresses[0]} via public DNS.`,
        );
        return addresses[0];
      }
    } catch (fallbackErr) {
      console.error(`Public DNS fallback failed for ${host}:`, fallbackErr);
    }

    return host;
  }
}

export async function initDatabase() {
  try {
    let connection;
    let activeHost = dbConfig.host;
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        activeHost = await resolveHost(dbConfig.host);

        connection = await mysql.createConnection({
          ...dbConfig,
          host: activeHost,
        });

        break;
      } catch (err) {
        lastError = err;

        console.warn(
          `Database connection attempt ${attempt}/3 failed: ${err.message}`,
        );

        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (!connection) {
      throw lastError;
    }

    console.log("Connected to MySQL server.");

    /*
     * Create database if it does not already exist.
     */
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    );

    console.log(`Database \`${databaseName}\` checked/created.`);

    await connection.end();

    /*
     * Initialize the application pool using the target database.
     */
    pool = mysql.createPool({
      ...dbConfig,
      host: activeHost,
      database: databaseName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    /*
     * Run schema.sql to create/verify tables.
     */
    const schemaPath = path.join(__dirname, "schema.sql");

    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, "utf8");

      try {
        await query(schemaSql);

        console.log("Database schema successfully verified/initialized.");

        /*
         * Run existing application migrations.
         */
        await runMigrations();
      } catch (schemaErr) {
        console.warn("Schema initialization warning:", schemaErr.message);

        await runMigrations();
      }
    } else {
      console.warn("schema.sql not found, skipping table initialization.");
    }
  } catch (error) {
    console.error("Database initialization failed:", error);

    process.exit(1);
  }
}

async function runMigrations(
  conn = { query: async (s, p) => [await query(s, p)] },
) {
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
    {
      name: "deleted_at",
      definition: "TIMESTAMP NULL DEFAULT NULL",
    },
    {
      name: "portfolio_url",
      definition: "VARCHAR(255) DEFAULT NULL",
    },
    {
      name: "portfolio_verified",
      definition: "TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      name: "portfolio_verified_at",
      definition: "TIMESTAMP NULL DEFAULT NULL",
    },
    {
      name: "portfolio_status",
      definition: "VARCHAR(20) NOT NULL DEFAULT 'none'",
    },
    {
      name: "portfolio_rejection_reason",
      definition: "TEXT DEFAULT NULL",
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
      'phone_verification',
      'login_2fa'
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
    const [feeRateCols] = await conn.query(
      "SHOW COLUMNS FROM transactions LIKE 'escrow_fee_rate'",
    );
    if (feeRateCols.length === 0) {
      await conn.query(
        "ALTER TABLE transactions ADD COLUMN `escrow_fee_rate` DECIMAL(5, 4) NOT NULL DEFAULT 0.0350",
      );
      console.log("Migration: Added transactions.escrow_fee_rate");
    }
    const [feeAmountCols] = await conn.query(
      "SHOW COLUMNS FROM transactions LIKE 'escrow_fee_amount'",
    );
    if (feeAmountCols.length === 0) {
      await conn.query(
        "ALTER TABLE transactions ADD COLUMN `escrow_fee_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00",
      );
      console.log("Migration: Added transactions.escrow_fee_amount");
    }
    const [ebCols] = await conn.query(
      "SHOW COLUMNS FROM transactions LIKE 'escrow_balance'",
    );
    if (ebCols.length === 0) {
      await conn.query(
        "ALTER TABLE transactions ADD COLUMN `escrow_balance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00",
      );
      console.log("Migration: Added transactions.escrow_balance");
    }
    const [raCols] = await conn.query(
      "SHOW COLUMNS FROM transactions LIKE 'released_amount'",
    );
    if (raCols.length === 0) {
      await conn.query(
        "ALTER TABLE transactions ADD COLUMN `released_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00",
      );
      console.log("Migration: Added transactions.released_amount");
    }
  } catch (err) {
    console.error("Migration failed for transaction fee/balance columns:", err);
  }

  // ----------------------------------------------------
  // KYC SUBMISSIONS TABLE EXTENSION MIGRATION
  // ----------------------------------------------------
  try {
    // Make id_type, id_number, id_file, phone nullable to support business-only verification
    await conn.query(
      "ALTER TABLE kyc_submissions MODIFY COLUMN phone VARCHAR(50) DEFAULT NULL",
    );
    await conn.query(
      "ALTER TABLE kyc_submissions MODIFY COLUMN id_type VARCHAR(50) DEFAULT NULL",
    );
    await conn.query(
      "ALTER TABLE kyc_submissions MODIFY COLUMN id_number VARCHAR(100) DEFAULT NULL",
    );
    await conn.query(
      "ALTER TABLE kyc_submissions MODIFY COLUMN id_file VARCHAR(255) DEFAULT NULL",
    );

    const [typeCols] = await conn.query(
      "SHOW COLUMNS FROM kyc_submissions LIKE 'submission_type'",
    );
    if (typeCols.length === 0) {
      await conn.query(
        "ALTER TABLE kyc_submissions ADD COLUMN `submission_type` ENUM('govt_id', 'business') NOT NULL DEFAULT 'govt_id'",
      );
      console.log("Migration: Added kyc_submissions.submission_type");
    }
  } catch (err) {
    console.error("Migration failed for kyc_submissions columns:", err);
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
    {
      name: "provider_subscription_id",
      definition: "VARCHAR(255) DEFAULT NULL",
    },
    { name: "provider_reference_id", definition: "VARCHAR(255) DEFAULT NULL" },
    { name: "auto_renew", definition: "TINYINT(1) NOT NULL DEFAULT 1" },
    { name: "cancelled_at", definition: "TIMESTAMP NULL DEFAULT NULL" },
    { name: "metadata", definition: "JSON DEFAULT NULL" },
    { name: "pending_plan_id", definition: "VARCHAR(50) DEFAULT NULL" },
    { name: "pending_billing_cycle", definition: "VARCHAR(50) DEFAULT NULL" },
  ];

  for (const col of subColumns) {
    try {
      const [rows] = await conn.query(
        "SHOW COLUMNS FROM subscriptions LIKE ?",
        [col.name],
      );
      if (rows.length === 0) {
        await conn.query(
          `ALTER TABLE subscriptions ADD COLUMN \`${col.name}\` ${col.definition}`,
        );
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
    console.error(
      "Migration failed to create subscriptions_history table:",
      err,
    );
  }

  // Clean up any unverified subscription records auto-inserted during signup prior to the security fix
  try {
    await conn.query(`
      UPDATE subscriptions
      SET status = 'expired'
      WHERE provider_reference_id IS NULL AND status = 'active'
    `);
  } catch (err) {
    console.error(
      "Migration failed to clean up unverified subscriptions:",
      err,
    );
  }

  // Update wallet_transactions.type ENUM to include 'subscription', 'escrow_fee', and 'adjustment'
  try {
    await conn.query(`
      ALTER TABLE wallet_transactions
      MODIFY COLUMN type ENUM('deposit', 'withdrawal', 'escrow_hold', 'escrow_release', 'escrow_refund', 'subscription', 'escrow_fee', 'adjustment') NOT NULL
    `);
  } catch (err) {
    console.error(
      "Migration failed to update wallet_transactions.type ENUM:",
      err,
    );
  }

  // Ensure wallet_transactions has currency column
  try {
    const [wtCurrencyCols] = await conn.query(
      "SHOW COLUMNS FROM wallet_transactions LIKE 'currency'",
    );
    if (wtCurrencyCols.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD COLUMN `currency` VARCHAR(3) NOT NULL DEFAULT 'USD'",
      );
      console.log("Migration: Added wallet_transactions.currency column.");
    }
  } catch (err) {
    console.error("Migration failed to add wallet_transactions.currency:", err);
  }

  // Ensure wallet_transactions has balance_before column
  try {
    const [wtBbCols] = await conn.query(
      "SHOW COLUMNS FROM wallet_transactions LIKE 'balance_before'",
    );
    if (wtBbCols.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD COLUMN `balance_before` DECIMAL(15,2) NULL DEFAULT NULL",
      );
      console.log(
        "Migration: Added wallet_transactions.balance_before column.",
      );
    }
  } catch (err) {
    console.error(
      "Migration failed to add wallet_transactions.balance_before:",
      err,
    );
  }

  // Ensure wallet_transactions has balance_after column
  try {
    const [wtBaCols] = await conn.query(
      "SHOW COLUMNS FROM wallet_transactions LIKE 'balance_after'",
    );
    if (wtBaCols.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD COLUMN `balance_after` DECIMAL(15,2) NULL DEFAULT NULL",
      );
      console.log("Migration: Added wallet_transactions.balance_after column.");
    }
  } catch (err) {
    console.error(
      "Migration failed to add wallet_transactions.balance_after:",
      err,
    );
  }

  // Ensure wallet_transactions has metadata column
  try {
    const [wtMetaCols] = await conn.query(
      "SHOW COLUMNS FROM wallet_transactions LIKE 'metadata'",
    );
    if (wtMetaCols.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD COLUMN `metadata` JSON NULL DEFAULT NULL",
      );
      console.log("Migration: Added wallet_transactions.metadata column.");
    }
  } catch (err) {
    console.error("Migration failed to add wallet_transactions.metadata:", err);
  }

  // Ensure wallet_transactions has status column
  try {
    const [wtStatusCols] = await conn.query(
      "SHOW COLUMNS FROM wallet_transactions LIKE 'status'",
    );
    if (wtStatusCols.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD COLUMN `status` ENUM('completed', 'pending', 'failed', 'reversed') NOT NULL DEFAULT 'completed'",
      );
      console.log("Migration: Added wallet_transactions.status column.");
    }
  } catch (err) {
    console.error("Migration failed to add wallet_transactions.status:", err);
  }

  // Ensure index on wallet_transactions(wallet_id, created_at)
  try {
    const [wtIdx] = await conn.query(
      "SHOW INDEX FROM wallet_transactions WHERE Key_name = 'idx_wt_wallet_created'",
    );
    if (wtIdx.length === 0) {
      await conn.query(
        "ALTER TABLE wallet_transactions ADD INDEX `idx_wt_wallet_created` (`wallet_id`, `created_at`)",
      );
      console.log("Migration: Added idx_wt_wallet_created index.");
    }
  } catch (err) {
    // Non-critical index error
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
    await conn.query(
      "ALTER TABLE disputes MODIFY COLUMN evidence LONGTEXT DEFAULT NULL",
    );
    await conn.query(
      "ALTER TABLE disputes MODIFY COLUMN reason LONGTEXT NOT NULL",
    );
    console.log(
      "Migration: Updated disputes.evidence and disputes.reason to LONGTEXT.",
    );
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
    { name: "deadline_notified_at", definition: "TIMESTAMP NULL DEFAULT NULL" },
    {
      name: "revision_policy",
      definition: "VARCHAR(255) DEFAULT '2 rounds of minor revisions'",
    },
  ];

  for (const col of txScopeColumns) {
    try {
      const [rows] = await conn.query("SHOW COLUMNS FROM transactions LIKE ?", [
        col.name,
      ]);
      if (rows.length === 0) {
        await conn.query(
          `ALTER TABLE transactions ADD COLUMN \`${col.name}\` ${col.definition}`,
        );
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
    { name: "due_date", definition: "TIMESTAMP NULL DEFAULT NULL" },
  ];

  for (const col of milestoneColumns) {
    try {
      const [rows] = await conn.query("SHOW COLUMNS FROM milestones LIKE ?", [
        col.name,
      ]);
      if (rows.length === 0) {
        await conn.query(
          `ALTER TABLE milestones ADD COLUMN \`${col.name}\` ${col.definition}`,
        );
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
        \`category\` VARCHAR(50) DEFAULT NULL,
        \`submission_data\` JSON DEFAULT NULL,
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
    console.error(
      "Migration failed to create milestone_submissions table:",
      err,
    );
  }

  // ----------------------------------------------------
  // MILESTONE_SUBMISSIONS EXTENSION MIGRATION
  // ----------------------------------------------------
  const subDataColumns = [
    { name: "category", definition: "VARCHAR(50) DEFAULT NULL" },
    { name: "submission_data", definition: "JSON DEFAULT NULL" },
  ];

  for (const col of subDataColumns) {
    try {
      const [rows] = await conn.query(
        "SHOW COLUMNS FROM milestone_submissions LIKE ?",
        [col.name],
      );
      if (rows.length === 0) {
        await conn.query(
          `ALTER TABLE milestone_submissions ADD COLUMN \`${col.name}\` ${col.definition}`,
        );
        console.log(`Migration: Added milestone_submissions.${col.name}`);
      }
    } catch (err) {
      console.error(
        `Migration failed for milestone_submissions.${col.name}`,
        err,
      );
    }
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
  // STAGE 1 — CREATE transaction_scope_items & acceptance_criteria TABLES
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`transaction_scope_items\` (
        \`id\`               INT            AUTO_INCREMENT PRIMARY KEY,
        \`transaction_id\`   INT            NOT NULL,
        \`scope_item_id\`    VARCHAR(50)    NOT NULL,
        \`name\`             VARCHAR(255)   NOT NULL,
        \`description\`      TEXT           DEFAULT NULL,
        \`required\`         TINYINT(1)     NOT NULL DEFAULT 1,
        \`critical\`         TINYINT(1)     NOT NULL DEFAULT 0,
        \`locked_at\`        TIMESTAMP      NULL DEFAULT NULL,
        \`created_at\`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uq_tx_scope_item\` (\`transaction_id\`, \`scope_item_id\`),
        INDEX \`idx_tsi_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: transaction_scope_items table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`acceptance_criteria\` (
        \`id\`               INT            AUTO_INCREMENT PRIMARY KEY,
        \`scope_item_id\`    INT            NOT NULL,
        \`transaction_id\`   INT            NOT NULL,
        \`criterion_id\`     VARCHAR(50)    NOT NULL,
        \`description\`      TEXT           NOT NULL,
        \`required\`         TINYINT(1)     NOT NULL DEFAULT 1,
        \`critical\`         TINYINT(1)     NOT NULL DEFAULT 0,
        \`created_at\`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`uq_tx_criterion\` (\`transaction_id\`, \`criterion_id\`),
        INDEX \`idx_ac_scope_item\` (\`scope_item_id\`),
        INDEX \`idx_ac_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`scope_item_id\`) REFERENCES \`transaction_scope_items\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: acceptance_criteria table checked/created.");

    // ----------------------------------------------------
    // STAGE 2 — CREATE EVIDENCE PROCESSING TABLES
    // ----------------------------------------------------
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`evidence_items\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`evidence_id\`        VARCHAR(100)   NOT NULL UNIQUE,
        \`transaction_id\`     INT            NOT NULL,
        \`milestone_id\`       INT            DEFAULT NULL,
        \`submission_id\`      INT            DEFAULT NULL,
        \`scope_item_id\`      VARCHAR(50)    DEFAULT NULL,
        \`criterion_id\`       VARCHAR(50)    DEFAULT NULL,
        \`evidence_type\`      VARCHAR(50)    NOT NULL,
        \`original_url\`       TEXT           DEFAULT NULL,
        \`storage_path\`       VARCHAR(255)   DEFAULT NULL,
        \`file_name\`          VARCHAR(255)   DEFAULT NULL,
        \`mime_type\`          VARCHAR(100)   DEFAULT NULL,
        \`file_size\`          BIGINT         DEFAULT 0,
        \`sha256_hash\`        VARCHAR(64)    DEFAULT NULL,
        \`processing_status\`  ENUM('pending', 'processing', 'processed', 'failed', 'unsupported', 'blocked', 'access_required') NOT NULL DEFAULT 'pending',
        \`processor_used\`     VARCHAR(50)    DEFAULT NULL,
        \`processing_error\`   TEXT           DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        \`processed_at\`       TIMESTAMP      NULL DEFAULT NULL,
        INDEX \`idx_ei_tx\` (\`transaction_id\`),
        INDEX \`idx_ei_sub\` (\`submission_id\`),
        INDEX \`idx_ei_scope\` (\`transaction_id\`, \`scope_item_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: evidence_items table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`evidence_processing_results\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`evidence_item_id\`   INT            NOT NULL,
        \`processor_name\`     VARCHAR(50)    NOT NULL,
        \`processor_version\`  VARCHAR(20)    DEFAULT '1.0.0',
        \`status\`             VARCHAR(50)    NOT NULL,
        \`result_json\`        JSON           DEFAULT NULL,
        \`error_message\`      TEXT           DEFAULT NULL,
        \`started_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        \`completed_at\`       TIMESTAMP      NULL DEFAULT NULL,
        INDEX \`idx_epr_item\` (\`evidence_item_id\`),
        FOREIGN KEY (\`evidence_item_id\`) REFERENCES \`evidence_items\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log(
      "Migration: evidence_processing_results table checked/created.",
    );

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`evidence_findings\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`evidence_item_id\`   INT            NOT NULL,
        \`transaction_id\`     INT            NOT NULL,
        \`submission_id\`      INT            DEFAULT NULL,
        \`scope_item_id\`      VARCHAR(50)    DEFAULT NULL,
        \`criterion_id\`       VARCHAR(50)    DEFAULT NULL,
        \`finding_type\`       VARCHAR(50)    NOT NULL,
        \`location\`           VARCHAR(255)   DEFAULT NULL,
        \`finding_text\`       TEXT           NOT NULL,
        \`metadata_json\`      JSON           DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_ef_item\` (\`evidence_item_id\`),
        INDEX \`idx_ef_tx_scope\` (\`transaction_id\`, \`scope_item_id\`),
        FOREIGN KEY (\`evidence_item_id\`) REFERENCES \`evidence_items\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: evidence_findings table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`evidence_chunks\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`chunk_id\`           VARCHAR(100)   NOT NULL UNIQUE,
        \`evidence_item_id\`   INT            NOT NULL,
        \`transaction_id\`     INT            NOT NULL,
        \`source_type\`        VARCHAR(50)    NOT NULL,
        \`source_location\`    VARCHAR(255)   DEFAULT NULL,
        \`chunk_index\`        INT            NOT NULL DEFAULT 0,
        \`content\`            LONGTEXT       NOT NULL,
        \`metadata_json\`      JSON           DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_ec_item\` (\`evidence_item_id\`),
        INDEX \`idx_ec_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`evidence_item_id\`) REFERENCES \`evidence_items\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: evidence_chunks table checked/created.");

    // ----------------------------------------------------
    // STAGE 3 — AUDIT SNAPSHOTS & AI_AUDITS EXTENSION
    // ----------------------------------------------------
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`audit_snapshots\` (
        \`id\`                    INT            AUTO_INCREMENT PRIMARY KEY,
        \`snapshot_id\`           VARCHAR(100)   NOT NULL UNIQUE,
        \`transaction_id\`        INT            NOT NULL,
        \`milestone_id\`          INT            DEFAULT NULL,
        \`submission_id\`         INT            DEFAULT NULL,
        \`audit_type\`             ENUM('milestone', 'final') NOT NULL DEFAULT 'milestone',
        \`scope_locked\`          TINYINT(1)     NOT NULL DEFAULT 0,
        \`requirements_json\`     JSON           DEFAULT NULL,
        \`submission_json\`       JSON           DEFAULT NULL,
        \`evidence_hashes_json\`  JSON           DEFAULT NULL,
        \`created_at\`            TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_as_tx\` (\`transaction_id\`),
        INDEX \`idx_as_sub\` (\`submission_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: audit_snapshots table checked/created.");

    const aiAuditColumns = [
      { name: "release_eligible", definition: "TINYINT(1) NOT NULL DEFAULT 0" },
      {
        name: "release_decision",
        definition: "VARCHAR(50) NOT NULL DEFAULT 'blocked'",
      },
      { name: "release_blockers_json", definition: "JSON DEFAULT NULL" },
      {
        name: "audit_version",
        definition: "VARCHAR(20) NOT NULL DEFAULT '3.0'",
      },
      { name: "snapshot_json", definition: "JSON DEFAULT NULL" },
    ];

    for (const col of aiAuditColumns) {
      try {
        const [rows] = await conn.query("SHOW COLUMNS FROM ai_audits LIKE ?", [
          col.name,
        ]);
        if (rows.length === 0) {
          await conn.query(
            `ALTER TABLE ai_audits ADD COLUMN \`${col.name}\` ${col.definition}`,
          );
          console.log(`Migration: Added ai_audits.${col.name}`);
        }
      } catch (colErr) {
        console.error(
          `Migration failed for ai_audits.${col.name}:`,
          colErr.message,
        );
      }
    }
    // ----------------------------------------------------
    // STAGE 4 — CREATE AUDIT JOBS & ANALYZER RESULTS TABLES
    // ----------------------------------------------------
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`audit_jobs\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`job_id\`             VARCHAR(100)   NOT NULL UNIQUE,
        \`transaction_id\`     INT            NOT NULL,
        \`milestone_id\`       INT            DEFAULT NULL,
        \`submission_id\`      INT            DEFAULT NULL,
        \`user_id\`            INT            NOT NULL,
        \`status\`             ENUM('queued', 'processing', 'completed', 'failed', 'cancelled', 'manual_review_required') NOT NULL DEFAULT 'queued',
        \`phase\`              VARCHAR(50)    NOT NULL DEFAULT 'queued',
        \`progress\`           INT            NOT NULL DEFAULT 0,
        \`current_task\`       VARCHAR(255)   DEFAULT NULL,
        \`worker_id\`          VARCHAR(100)   DEFAULT NULL,
        \`claimed_at\`         TIMESTAMP      NULL DEFAULT NULL,
        \`started_at\`         TIMESTAMP      NULL DEFAULT NULL,
        \`completed_at\`       TIMESTAMP      NULL DEFAULT NULL,
        \`retry_count\`        INT            NOT NULL DEFAULT 0,
        \`max_retries\`        INT            NOT NULL DEFAULT 3,
        \`last_error\`         TEXT           DEFAULT NULL,
        \`next_retry_at\`      TIMESTAMP      NULL DEFAULT NULL,
        \`idempotency_key\`    VARCHAR(255)   DEFAULT NULL UNIQUE,
        \`audit_id\`           INT            DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_aj_status\` (\`status\`, \`next_retry_at\`),
        INDEX \`idx_aj_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: audit_jobs table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`analyzer_results\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`audit_job_id\`       INT            NOT NULL,
        \`analyzer_name\`      VARCHAR(50)    NOT NULL,
        \`analyzer_version\`   VARCHAR(20)    NOT NULL DEFAULT '1.0.0',
        \`status\`             VARCHAR(50)    NOT NULL DEFAULT 'completed',
        \`findings_json\`      JSON           DEFAULT NULL,
        \`limitations_json\`   JSON           DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_ar_job\` (\`audit_job_id\`),
        FOREIGN KEY (\`audit_job_id\`) REFERENCES \`audit_jobs\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: analyzer_results table checked/created.");

    // ----------------------------------------------------
    // AI DISPUTE ANALYSES TABLE
    // ----------------------------------------------------
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`ai_dispute_analyses\` (
        \`id\`                 INT            AUTO_INCREMENT PRIMARY KEY,
        \`dispute_id\`         INT            NOT NULL,
        \`transaction_id\`     INT            NOT NULL,
        \`analysis_version\`   INT            NOT NULL DEFAULT 1,
        \`recommendation\`     VARCHAR(50)    NOT NULL,
        \`confidence_score\`   INT            NOT NULL DEFAULT 0,
        \`summary\`            TEXT           DEFAULT NULL,
        \`contract_analysis\`  JSON           DEFAULT NULL,
        \`evidence_evaluation\` JSON          DEFAULT NULL,
        \`findings\`           JSON           DEFAULT NULL,
        \`fault_attribution\`  JSON           DEFAULT NULL,
        \`recommended_split\`  JSON           DEFAULT NULL,
        \`reasoning\`          TEXT           DEFAULT NULL,
        \`risk_factors\`       JSON           DEFAULT NULL,
        \`suggested_action\`   TEXT           DEFAULT NULL,
        \`model_used\`         VARCHAR(100)   DEFAULT NULL,
        \`tokens_used\`        INT            DEFAULT 0,
        \`admin_override\`     BOOLEAN        DEFAULT FALSE,
        \`admin_decision\`     VARCHAR(50)    DEFAULT NULL,
        \`admin_feedback\`     TEXT           DEFAULT NULL,
        \`created_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_ada_dispute\` (\`dispute_id\`),
        INDEX \`idx_ada_tx\` (\`transaction_id\`),
        FOREIGN KEY (\`dispute_id\`) REFERENCES \`disputes\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: ai_dispute_analyses table checked/created.");
  } catch (err) {
    console.error(
      "Migration failed to create Stage 1/2/3/4/Dispute tables:",
      err,
    );
  }

  // ----------------------------------------------------
  // PAYSTACK TABLES MIGRATIONS (payments, bank_accounts, withdrawals, webhook_events)
  // ----------------------------------------------------
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`payments\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`reference\` VARCHAR(100) NOT NULL UNIQUE,
        \`amount\` DECIMAL(15,2) NOT NULL,
        \`amount_kobo\` BIGINT NOT NULL,
        \`currency\` VARCHAR(3) NOT NULL DEFAULT 'NGN',
        \`exchange_rate\` DECIMAL(15,4) DEFAULT NULL,
        \`purpose\` VARCHAR(50) NOT NULL DEFAULT 'wallet_funding',
        \`provider\` VARCHAR(20) NOT NULL DEFAULT 'paystack',
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'pending',
        \`provider_reference\` VARCHAR(100) DEFAULT NULL,
        \`provider_transaction_id\` VARCHAR(100) DEFAULT NULL,
        \`wallet_transaction_id\` INT DEFAULT NULL,
        \`metadata\` JSON DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_payments_user\` (\`user_id\`),
        INDEX \`idx_payments_status\` (\`status\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: payments table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`bank_accounts\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`account_holder_name\` VARCHAR(255) NOT NULL,
        \`bank_name\` VARCHAR(255) NOT NULL,
        \`bank_code\` VARCHAR(20) NOT NULL,
        \`account_number\` VARCHAR(20) NOT NULL,
        \`recipient_code\` VARCHAR(100) DEFAULT NULL,
        \`is_verified\` TINYINT(1) NOT NULL DEFAULT 0,
        \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_bank_accounts_user\` (\`user_id\`),
        UNIQUE KEY \`uq_user_bank_acct\` (\`user_id\`, \`bank_code\`, \`account_number\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: bank_accounts table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`withdrawals\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`bank_account_id\` INT NOT NULL,
        \`reference\` VARCHAR(100) NOT NULL UNIQUE,
        \`amount\` DECIMAL(15,2) NOT NULL,
        \`amount_kobo\` BIGINT NOT NULL,
        \`currency\` VARCHAR(3) NOT NULL DEFAULT 'NGN',
        \`exchange_rate\` DECIMAL(15,4) DEFAULT NULL,
        \`provider\` VARCHAR(20) NOT NULL DEFAULT 'paystack',
        \`status\` VARCHAR(30) NOT NULL DEFAULT 'pending',
        \`provider_transfer_code\` VARCHAR(100) DEFAULT NULL,
        \`provider_recipient_code\` VARCHAR(100) DEFAULT NULL,
        \`wallet_transaction_id\` INT DEFAULT NULL,
        \`failure_reason\` TEXT DEFAULT NULL,
        \`requested_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`processed_at\` TIMESTAMP NULL DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_withdrawals_user\` (\`user_id\`),
        INDEX \`idx_withdrawals_status\` (\`status\`),
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`bank_account_id\`) REFERENCES \`bank_accounts\` (\`id\`)
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: withdrawals table checked/created.");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`webhook_events\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`provider\` VARCHAR(20) NOT NULL DEFAULT 'paystack',
        \`event_type\` VARCHAR(100) NOT NULL,
        \`provider_reference\` VARCHAR(100) NOT NULL,
        \`idempotency_key\` VARCHAR(255) NOT NULL UNIQUE,
        \`payload\` JSON DEFAULT NULL,
        \`processed_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_webhook_events_ref\` (\`provider_reference\`)
      ) ENGINE=InnoDB;
    `);
    console.log("Migration: webhook_events table checked/created.");
  } catch (err) {
    console.error("Migration failed for Paystack tables:", err);
  }
}

export async function query(sql, params) {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initDatabase first.");
  }

  const RETRYABLE_CODES = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "PROTOCOL_CONNECTION_LOST",
    "EPIPE",
    "ER_CON_COUNT_ERROR",
    "ER_SERVER_SHUTDOWN",
  ]);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [results] = await pool.query(sql, params);
      return results;
    } catch (err) {
      lastError = err;
      if (RETRYABLE_CODES.has(err.code) && attempt < 3) {
        console.warn(
          `[DB] Query failed with ${err.code}, retrying (${attempt}/3)...`,
        );
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export default {
  initDatabase,
  query,
  getPool: () => pool,
};
