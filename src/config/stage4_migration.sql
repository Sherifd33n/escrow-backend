-- =============================================================
-- STAGE 4 MIGRATION — Production, Scaling & Specialized Analysis
-- Adds audit_jobs and analyzer_results tables.
-- Safe to re-run.
-- =============================================================

USE `escrow_db`;

-- 1. Table: audit_jobs (background queue job lifecycle, workers, retries & progress)
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

-- 2. Table: analyzer_results (specialized analyzer findings & versioning)
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
