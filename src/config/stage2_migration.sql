-- =============================================================
-- STAGE 2 MIGRATION — Evidence Processing Architecture
-- Adds 4 new tables: evidence_items, evidence_processing_results,
-- evidence_findings, and evidence_chunks.
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS.
-- =============================================================

USE `escrow_db`;

-- 1. Table: evidence_items (tracks metadata & hash for every uploaded file/URL)
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

-- 2. Table: evidence_processing_results (historical & active processor output records)
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

-- 3. Table: evidence_findings (structured evidence observations for Stage 3 evaluation)
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

-- 4. Table: evidence_chunks (traceable document/repository content segments)
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
