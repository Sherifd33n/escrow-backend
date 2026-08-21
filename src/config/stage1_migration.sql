-- =============================================================
-- STAGE 1 MIGRATION — Structured Scope & Acceptance Criteria
-- Run this once against escrow_db to add the two new tables.
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS.
-- =============================================================

USE `escrow_db`;

-- ------------------------------------------------------------------
-- Table: transaction_scope_items
-- One row per deliverable in the agreed project scope.
-- scope_item_id is a stable string key (e.g. "d1", "d2") that
-- matches the scope_item_id in scope_json.deliverables so audits
-- can join the relational record to submission_data.deliverables.
-- locked_at is set when the transaction transitions to inprogress,
-- after which the agreed requirements must not be silently altered.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `transaction_scope_items` (
  `id`               INT            AUTO_INCREMENT PRIMARY KEY,
  `transaction_id`   INT            NOT NULL,
  `scope_item_id`    VARCHAR(50)    NOT NULL,          -- stable: "d1", "d2" …
  `name`             VARCHAR(255)   NOT NULL,
  `description`      TEXT           DEFAULT NULL,
  `required`         TINYINT(1)     NOT NULL DEFAULT 1,
  `critical`         TINYINT(1)     NOT NULL DEFAULT 0,
  `locked_at`        TIMESTAMP      NULL DEFAULT NULL, -- set on funding → inprogress
  `created_at`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_tx_scope_item` (`transaction_id`, `scope_item_id`),
  INDEX `idx_tsi_tx` (`transaction_id`),
  FOREIGN KEY (`transaction_id`)
    REFERENCES `transactions` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------------
-- Table: acceptance_criteria
-- One row per measurable acceptance criterion, linked to a
-- transaction_scope_items row.  criterion_id is a stable string
-- key (e.g. "ac1", "ac2") unique within the transaction.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `acceptance_criteria` (
  `id`               INT            AUTO_INCREMENT PRIMARY KEY,
  `scope_item_id`    INT            NOT NULL,          -- FK → transaction_scope_items.id
  `transaction_id`   INT            NOT NULL,
  `criterion_id`     VARCHAR(50)    NOT NULL,          -- stable: "ac1", "ac2" …
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
