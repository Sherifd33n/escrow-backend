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
