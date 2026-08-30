-- =============================================================
-- STAGE 3 MIGRATION — Audit + AI Engine Architecture
-- Adds audit_snapshots table and extends ai_audits with deterministic
-- release decision & versioning columns.
-- Safe to re-run.
-- =============================================================

USE `escrow_db`;

-- 1. Table: audit_snapshots (immutable point-in-time snapshot of audited state)
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

-- 2. Extend ai_audits table with deterministic release eligibility & versioning columns
CALL SystemCheck_AddColumn('ai_audits', 'release_eligible', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL SystemCheck_AddColumn('ai_audits', 'release_decision', "VARCHAR(50) NOT NULL DEFAULT 'blocked'");
CALL SystemCheck_AddColumn('ai_audits', 'release_blockers_json', 'JSON DEFAULT NULL');
CALL SystemCheck_AddColumn('ai_audits', 'audit_version', "VARCHAR(20) NOT NULL DEFAULT '3.0'");
CALL SystemCheck_AddColumn('ai_audits', 'snapshot_json', 'JSON DEFAULT NULL');
