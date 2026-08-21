CREATE DATABASE IF NOT EXISTS `escrow_db` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Users table
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('client', 'provider', 'admin') NOT NULL DEFAULT 'client',
 `phone` VARCHAR(20) DEFAULT NULL,

`phone_verified` TINYINT(1) NOT NULL DEFAULT 0,
`phone_verified_at` TIMESTAMP NULL DEFAULT NULL,
`kyc_tier` INT NOT NULL DEFAULT 1,
`is_verified` TINYINT(1) NOT NULL DEFAULT 0,
`is_active` TINYINT(1) NOT NULL DEFAULT 1,
`email_verified_at` TIMESTAMP NULL DEFAULT NULL,
  `two_factor_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `notif_email` TINYINT(1) NOT NULL DEFAULT 1,
  `notif_sms` TINYINT(1) NOT NULL DEFAULT 0,
  `notif_push` TINYINT(1) NOT NULL DEFAULT 1,
  `public_profile` TINYINT(1) NOT NULL DEFAULT 1,
  `marketing_comms` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- OTP codes table
CREATE TABLE IF NOT EXISTS `otp_codes` (

    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `email` VARCHAR(255) DEFAULT NULL,
    `phone` VARCHAR(20) DEFAULT NULL,
   `code` VARCHAR(255) NOT NULL,
    `type` ENUM(
        'signup',
        'forgot',
        'phone_verification'
    ) NOT NULL DEFAULT 'signup',
    `expires_at` TIMESTAMP NULL DEFAULT NULL,
    `used` TINYINT(1) NOT NULL DEFAULT 0,
    `attempts` INT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`user_id`)
        REFERENCES `users` (`id`)
        ON DELETE CASCADE

) ENGINE=InnoDB;

-- Wallets table
CREATE TABLE IF NOT EXISTS `wallets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL UNIQUE,
  `balance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
  `currency` VARCHAR(3) NOT NULL DEFAULT 'USD',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Transactions (Escrow deals) table
CREATE TABLE IF NOT EXISTS `transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `txn_code` VARCHAR(50) NOT NULL UNIQUE,
  `title` VARCHAR(255) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `amount` DECIMAL(15, 2) NOT NULL,
  `currency` VARCHAR(3) NOT NULL DEFAULT 'USD',
  `buyer_id` INT NOT NULL,
  `seller_id` INT NOT NULL,
  `escrow_fee_rate` DECIMAL(5, 4) NOT NULL DEFAULT 0.0350,
  `escrow_fee_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
  `escrow_balance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
  `released_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
  `status` ENUM('pending', 'funded', 'inprogress', 'inspection', 'audit', 'approved', 'revision', 'completed', 'disputed') NOT NULL DEFAULT 'pending',
  `review_days` INT NOT NULL DEFAULT 3,
  `milestones_count` INT NOT NULL DEFAULT 1,
  `scope_json` JSON DEFAULT NULL,
  `ai_estimated_timeline` VARCHAR(100) DEFAULT NULL,
  `agreed_duration` VARCHAR(100) DEFAULT NULL,
  `agreed_deadline` TIMESTAMP NULL DEFAULT NULL,
  `revision_policy` VARCHAR(255) DEFAULT '2 rounds of minor revisions',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`buyer_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`seller_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- AI Audits table (preserves audit history per submission)
CREATE TABLE IF NOT EXISTS `ai_audits` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `milestone_id` INT DEFAULT NULL,
  `submission_id` INT DEFAULT NULL,
  `audited_by` INT NOT NULL,
  `score` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(50) NOT NULL,
  `risk` VARCHAR(50) NOT NULL,
  `risk_score` INT NOT NULL DEFAULT 0,
  `summary` TEXT NOT NULL,
  `recommendation` TEXT NOT NULL,
  `checks_json` JSON DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ai_audits_tx` (`transaction_id`),
  INDEX `idx_ai_audits_m` (`milestone_id`),
  INDEX `idx_ai_audits_sub` (`submission_id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`audited_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Subscriptions table
CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL UNIQUE,
  `plan_id` VARCHAR(50) NOT NULL DEFAULT 'silver',
  `billing_cycle` ENUM('monthly', 'annual') NOT NULL DEFAULT 'monthly',
  `status` ENUM('pending', 'active', 'past_due', 'cancelled', 'expired', 'suspended') NOT NULL DEFAULT 'active',
  `starts_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `ends_at` TIMESTAMP NULL DEFAULT NULL,
  `payment_provider` VARCHAR(50) DEFAULT NULL,
  `provider_customer_id` VARCHAR(255) DEFAULT NULL,
  `provider_subscription_id` VARCHAR(255) DEFAULT NULL,
  `provider_reference_id` VARCHAR(255) DEFAULT NULL,
  `auto_renew` TINYINT(1) NOT NULL DEFAULT 1,
  `cancelled_at` TIMESTAMP NULL DEFAULT NULL,
  `metadata` JSON DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Subscription History table
CREATE TABLE IF NOT EXISTS `subscriptions_history` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `plan_id` VARCHAR(50) NOT NULL,
  `billing_cycle` ENUM('monthly', 'annual') NOT NULL DEFAULT 'monthly',
  `status` VARCHAR(50) NOT NULL,
  `starts_at` TIMESTAMP NULL DEFAULT NULL,
  `ends_at` TIMESTAMP NULL DEFAULT NULL,
  `payment_provider` VARCHAR(50) DEFAULT NULL,
  `provider_reference_id` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sub_hist_user` (`user_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- AI Usage tracking table
CREATE TABLE IF NOT EXISTS `ai_usage` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `feature` VARCHAR(50) NOT NULL,
  `transaction_id` INT DEFAULT NULL,
  `metadata` JSON DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ai_usage_user_feature` (`user_id`, `feature`, `created_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Milestones table
CREATE TABLE IF NOT EXISTS `milestones` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(15, 2) NOT NULL,
  `status` ENUM('pending', 'paid', 'due', 'upcoming', 'submitted', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `deliverable_note` TEXT DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `ai_suggested_timeline` VARCHAR(100) DEFAULT NULL,
  `start_date` TIMESTAMP NULL DEFAULT NULL,
  `due_date` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Milestone Submissions table
CREATE TABLE IF NOT EXISTS `milestone_submissions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `milestone_id` INT NOT NULL,
  `submitted_by` INT NOT NULL,
  `version` INT NOT NULL DEFAULT 1,
  `deliverable_note` TEXT NOT NULL,
  `attachments` JSON DEFAULT NULL,
  `category` VARCHAR(50) DEFAULT NULL,
  `submission_data` JSON DEFAULT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'submitted',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_m_sub_tx_m` (`transaction_id`, `milestone_id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`milestone_id`) REFERENCES `milestones` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`submitted_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Wallet transactions (history) table
CREATE TABLE IF NOT EXISTS `wallet_transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `wallet_id` INT NOT NULL,
  `type` ENUM('deposit', 'withdrawal', 'escrow_hold', 'escrow_release', 'escrow_refund') NOT NULL,
  `amount` DECIMAL(15, 2) NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `reference` VARCHAR(100) NOT NULL UNIQUE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`wallet_id`) REFERENCES `wallets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Subscriptions table
CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL UNIQUE,
  `plan_id` VARCHAR(50) NOT NULL DEFAULT 'silver',
  `billing_cycle` ENUM('monthly', 'annual') NOT NULL DEFAULT 'monthly',
  `status` ENUM('active', 'expired', 'cancelled') NOT NULL DEFAULT 'active',
  `starts_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `ends_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Disputes table
CREATE TABLE IF NOT EXISTS `disputes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `filed_by` INT NOT NULL,
  `reason` LONGTEXT NOT NULL,
  `evidence` LONGTEXT DEFAULT NULL,
  `status` ENUM('filed', 'under_review', 'resolved') NOT NULL DEFAULT 'filed',
  `resolution` LONGTEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`filed_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- User sessions table
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `token_jti` VARCHAR(255) NOT NULL UNIQUE,
  `device` VARCHAR(255) NOT NULL,
  `ip_address` VARCHAR(50) DEFAULT NULL,
  `location` VARCHAR(100) DEFAULT NULL,
  `last_active` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- KYC submissions table
CREATE TABLE IF NOT EXISTS `kyc_submissions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `phone` VARCHAR(50) NOT NULL,
  `id_type` VARCHAR(50) NOT NULL,
  `id_number` VARCHAR(100) NOT NULL,
  `id_file` VARCHAR(255) NOT NULL,
  `selfie_file` VARCHAR(255) DEFAULT NULL,
  `biz_name` VARCHAR(255) DEFAULT NULL,
  `biz_reg` VARCHAR(100) DEFAULT NULL,
  `biz_file` VARCHAR(255) DEFAULT NULL,
  `incorp_file` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `rejection_reason` TEXT DEFAULT NULL,
  `reviewed_by` INT DEFAULT NULL,
  `reviewed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Reviews table
CREATE TABLE IF NOT EXISTS `reviews` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `reviewer_id` INT NOT NULL,
  `reviewee_id` INT NOT NULL,
  `rating` INT NOT NULL,
  `comment` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`reviewer_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`reviewee_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  UNIQUE KEY `unique_reviewer_transaction` (`transaction_id`, `reviewer_id`)
) ENGINE=InnoDB;

-- Notifications table
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`    INT          NOT NULL,
  `type`       VARCHAR(60)  NOT NULL,
  `title`      VARCHAR(255) NOT NULL,
  `message`    TEXT         NOT NULL,
  `channel`    ENUM('in_app','email','sms','push') NOT NULL DEFAULT 'in_app',
  `is_read`    TINYINT(1)   NOT NULL DEFAULT 0,
  `metadata`   JSON         DEFAULT NULL,
  `created_at` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_notifications_user_read` (`user_id`, `is_read`),
  INDEX `idx_notifications_type`      (`type`),
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 1 — Structured Scope Items (immutable once locked)
CREATE TABLE IF NOT EXISTS `transaction_scope_items` (
  `id`               INT            AUTO_INCREMENT PRIMARY KEY,
  `transaction_id`   INT            NOT NULL,
  `scope_item_id`    VARCHAR(50)    NOT NULL,
  `name`             VARCHAR(255)   NOT NULL,
  `description`      TEXT           DEFAULT NULL,
  `required`         TINYINT(1)     NOT NULL DEFAULT 1,
  `critical`         TINYINT(1)     NOT NULL DEFAULT 0,
  `locked_at`        TIMESTAMP      NULL DEFAULT NULL,
  `created_at`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_tx_scope_item` (`transaction_id`, `scope_item_id`),
  INDEX `idx_tsi_tx` (`transaction_id`),
  FOREIGN KEY (`transaction_id`)
    REFERENCES `transactions` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 1 — Per-deliverable Acceptance Criteria (stable criterion IDs)
CREATE TABLE IF NOT EXISTS `acceptance_criteria` (
  `id`               INT            AUTO_INCREMENT PRIMARY KEY,
  `scope_item_id`    INT            NOT NULL,
  `transaction_id`   INT            NOT NULL,
  `criterion_id`     VARCHAR(50)    NOT NULL,
  `description`      TEXT           NOT NULL,
  `required`         TINYINT(1)     NOT NULL DEFAULT 1,
  `critical`         TINYINT(1)     NOT NULL DEFAULT 0,
  `created_at`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_tx_criterion` (`transaction_id`, `criterion_id`),
  INDEX `idx_ac_scope_item` (`scope_item_id`),
  INDEX `idx_ac_tx` (`transaction_id`),
  FOREIGN KEY (`scope_item_id`)
    REFERENCES `transaction_scope_items` (`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`transaction_id`)
    REFERENCES `transactions` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 2 — Evidence Items (metadata, hashes, storage & status)
CREATE TABLE IF NOT EXISTS `evidence_items` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `evidence_id`        VARCHAR(100)   NOT NULL UNIQUE,
  `transaction_id`     INT            NOT NULL,
  `milestone_id`       INT            DEFAULT NULL,
  `submission_id`      INT            DEFAULT NULL,
  `scope_item_id`      VARCHAR(50)    DEFAULT NULL,
  `criterion_id`       VARCHAR(50)    DEFAULT NULL,
  `evidence_type`      VARCHAR(50)    NOT NULL,
  `original_url`       TEXT           DEFAULT NULL,
  `storage_path`       VARCHAR(255)   DEFAULT NULL,
  `file_name`          VARCHAR(255)   DEFAULT NULL,
  `mime_type`          VARCHAR(100)   DEFAULT NULL,
  `file_size`          BIGINT         DEFAULT 0,
  `sha256_hash`        VARCHAR(64)    DEFAULT NULL,
  `processing_status`  ENUM('pending', 'processing', 'processed', 'failed', 'unsupported', 'blocked', 'access_required') NOT NULL DEFAULT 'pending',
  `processor_used`     VARCHAR(50)    DEFAULT NULL,
  `processing_error`   TEXT           DEFAULT NULL,
  `created_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  `processed_at`       TIMESTAMP      NULL DEFAULT NULL,
  INDEX `idx_ei_tx` (`transaction_id`),
  INDEX `idx_ei_sub` (`submission_id`),
  INDEX `idx_ei_scope` (`transaction_id`, `scope_item_id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 2 — Evidence Processing Results (processor output logs)
CREATE TABLE IF NOT EXISTS `evidence_processing_results` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `evidence_item_id`   INT            NOT NULL,
  `processor_name`     VARCHAR(50)    NOT NULL,
  `processor_version`  VARCHAR(20)    DEFAULT '1.0.0',
  `status`             VARCHAR(50)    NOT NULL,
  `result_json`        JSON           DEFAULT NULL,
  `error_message`      TEXT           DEFAULT NULL,
  `started_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  `completed_at`       TIMESTAMP      NULL DEFAULT NULL,
  INDEX `idx_epr_item` (`evidence_item_id`),
  FOREIGN KEY (`evidence_item_id`) REFERENCES `evidence_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 2 — Evidence Findings (structured evidence observations for Stage 3 evaluation)
CREATE TABLE IF NOT EXISTS `evidence_findings` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `evidence_item_id`   INT            NOT NULL,
  `transaction_id`     INT            NOT NULL,
  `submission_id`      INT            DEFAULT NULL,
  `scope_item_id`      VARCHAR(50)    DEFAULT NULL,
  `criterion_id`       VARCHAR(50)    DEFAULT NULL,
  `finding_type`       VARCHAR(50)    NOT NULL,
  `location`           VARCHAR(255)   DEFAULT NULL,
  `finding_text`       TEXT           NOT NULL,
  `metadata_json`      JSON           DEFAULT NULL,
  `created_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ef_item` (`evidence_item_id`),
  INDEX `idx_ef_tx_scope` (`transaction_id`, `scope_item_id`),
  FOREIGN KEY (`evidence_item_id`) REFERENCES `evidence_items` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 2 — Evidence Chunks (content segments with traceability)
CREATE TABLE IF NOT EXISTS `evidence_chunks` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `chunk_id`           VARCHAR(100)   NOT NULL UNIQUE,
  `evidence_item_id`   INT            NOT NULL,
  `transaction_id`     INT            NOT NULL,
  `source_type`        VARCHAR(50)    NOT NULL,
  `source_location`    VARCHAR(255)   DEFAULT NULL,
  `chunk_index`        INT            NOT NULL DEFAULT 0,
  `content`            LONGTEXT       NOT NULL,
  `metadata_json`      JSON           DEFAULT NULL,
  `created_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ec_item` (`evidence_item_id`),
  INDEX `idx_ec_tx` (`transaction_id`),
  FOREIGN KEY (`evidence_item_id`) REFERENCES `evidence_items` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 3 — Audit Snapshots (immutable point-in-time snapshot of audited state)
CREATE TABLE IF NOT EXISTS `audit_snapshots` (
  `id`                    INT            AUTO_INCREMENT PRIMARY KEY,
  `snapshot_id`           VARCHAR(100)   NOT NULL UNIQUE,
  `transaction_id`        INT            NOT NULL,
  `milestone_id`          INT            DEFAULT NULL,
  `submission_id`         INT            DEFAULT NULL,
  `audit_type`             ENUM('milestone', 'final') NOT NULL DEFAULT 'milestone',
  `scope_locked`          TINYINT(1)     NOT NULL DEFAULT 0,
  `requirements_json`     JSON           DEFAULT NULL,
  `submission_json`       JSON           DEFAULT NULL,
  `evidence_hashes_json`  JSON           DEFAULT NULL,
  `created_at`            TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_as_tx` (`transaction_id`),
  INDEX `idx_as_sub` (`submission_id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 4 — Audit Jobs (background job queue, worker claims & retries)
CREATE TABLE IF NOT EXISTS `audit_jobs` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `job_id`             VARCHAR(100)   NOT NULL UNIQUE,
  `transaction_id`     INT            NOT NULL,
  `milestone_id`       INT            DEFAULT NULL,
  `submission_id`      INT            DEFAULT NULL,
  `user_id`            INT            NOT NULL,
  `status`             ENUM('queued', 'processing', 'completed', 'failed', 'cancelled', 'manual_review_required') NOT NULL DEFAULT 'queued',
  `phase`              VARCHAR(50)    NOT NULL DEFAULT 'queued',
  `progress`           INT            NOT NULL DEFAULT 0,
  `current_task`       VARCHAR(255)   DEFAULT NULL,
  `worker_id`          VARCHAR(100)   DEFAULT NULL,
  `claimed_at`         TIMESTAMP      NULL DEFAULT NULL,
  `started_at`         TIMESTAMP      NULL DEFAULT NULL,
  `completed_at`       TIMESTAMP      NULL DEFAULT NULL,
  `retry_count`        INT            NOT NULL DEFAULT 0,
  `max_retries`        INT            NOT NULL DEFAULT 3,
  `last_error`         TEXT           DEFAULT NULL,
  `next_retry_at`      TIMESTAMP      NULL DEFAULT NULL,
  `idempotency_key`    VARCHAR(255)   DEFAULT NULL UNIQUE,
  `audit_id`           INT            DEFAULT NULL,
  `created_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_aj_status` (`status`, `next_retry_at`),
  INDEX `idx_aj_tx` (`transaction_id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stage 4 — Specialized Analyzer Results
CREATE TABLE IF NOT EXISTS `analyzer_results` (
  `id`                 INT            AUTO_INCREMENT PRIMARY KEY,
  `audit_job_id`       INT            NOT NULL,
  `analyzer_name`      VARCHAR(50)    NOT NULL,
  `analyzer_version`   VARCHAR(20)    NOT NULL DEFAULT '1.0.0',
  `status`             VARCHAR(50)    NOT NULL DEFAULT 'completed',
  `findings_json`      JSON           DEFAULT NULL,
  `limitations_json`   JSON           DEFAULT NULL,
  `created_at`         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ar_job` (`audit_job_id`),
  FOREIGN KEY (`audit_job_id`) REFERENCES `audit_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
