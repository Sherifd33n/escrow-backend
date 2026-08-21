/**
 * scopeService.js
 * Stage 1 — Foundation & Data Model
 *
 * Manages the relational scope tables:
 *   - transaction_scope_items  (one row per deliverable, locked once work starts)
 *   - acceptance_criteria      (one row per measurable criterion per deliverable)
 *
 * These tables are the canonical "contractual source of truth" for AI audits.
 * Raw scope_json is still stored on the transactions row for backwards
 * compatibility, but runAiAudit() will prefer the relational records once
 * they exist.
 */

import db from "../config/db.js";

// ---------------------------------------------------------------------------
// Internal: parse scope_json into a normalised shape
// ---------------------------------------------------------------------------

/**
 * Extracts deliverables and global acceptance criteria from a scope_json
 * object (the structure produced by generateAiScope / the AI scope generator).
 *
 * Returns:
 * {
 *   deliverables: [{ scope_item_id, name, description, acceptance_criteria: [] }],
 *   globalCriteria: [string]          // top-level scope_json.acceptance array
 * }
 */
function parseScopeJson(scopeJson) {
  let parsed = scopeJson;
  if (typeof scopeJson === "string") {
    try {
      parsed = JSON.parse(scopeJson);
    } catch (_) {
      return { deliverables: [], globalCriteria: [] };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { deliverables: [], globalCriteria: [] };
  }

  const globalCriteria = Array.isArray(parsed.acceptance) ? parsed.acceptance : [];
  const rawDeliverables = Array.isArray(parsed.deliverables) ? parsed.deliverables : [];

  let itemIndex = 1;
  const deliverables = rawDeliverables
    .filter((d) => d && (typeof d === "string" || typeof d === "object"))
    .map((d) => {
      if (typeof d === "string" && d.trim()) {
        const id = `d${itemIndex++}`;
        return {
          scope_item_id: id,
          name: d.trim(),
          description: d.trim(),
          required: true,
          critical: false,
          acceptance_criteria: [],
        };
      }
      if (typeof d === "object" && d !== null) {
        const id = d.scope_item_id || d.id || `d${itemIndex++}`;
        return {
          scope_item_id: id,
          name: d.name || d.title || d.deliverable || `Deliverable ${itemIndex}`,
          description: d.description || d.details || "",
          required: d.required !== false, // default true
          critical: !!d.critical,
          acceptance_criteria: Array.isArray(d.acceptance_criteria)
            ? d.acceptance_criteria
            : [],
        };
      }
      return null;
    })
    .filter(Boolean);

  return { deliverables, globalCriteria };
}

// ---------------------------------------------------------------------------
// hydrateScope
// ---------------------------------------------------------------------------

/**
 * Syncs scope_json into the relational tables for a transaction.
 *
 * - Upserts rows in transaction_scope_items (by scope_item_id).
 * - Replaces acceptance_criteria rows for this transaction.
 * - Safe to call multiple times before locking (pre-work scope edits).
 * - Will NOT overwrite rows whose locked_at is already set.
 *
 * @param {number} transactionId
 * @param {object|string} scopeJson  - The scope_json value (object or JSON string)
 * @param {object} [conn]            - Optional mysql2 connection (for transactions)
 */
export async function hydrateScope(transactionId, scopeJson, conn) {
  const q = conn || db;
  const { deliverables, globalCriteria } = parseScopeJson(scopeJson);

  if (deliverables.length === 0) return;

  // Check if any items are already locked — if so, skip silently
  const lockedRows = await q.query(
    "SELECT id FROM transaction_scope_items WHERE transaction_id = ? AND locked_at IS NOT NULL LIMIT 1",
    [transactionId],
  );
  const isLocked = Array.isArray(lockedRows)
    ? lockedRows.length > 0
    : (lockedRows[0]?.length ?? 0) > 0;

  if (isLocked) {
    console.warn(
      `[scopeService] hydrateScope skipped: scope is already locked for transaction ${transactionId}`,
    );
    return;
  }

  // Upsert each deliverable into transaction_scope_items
  for (const d of deliverables) {
    await q.query(
      `INSERT INTO transaction_scope_items
         (transaction_id, scope_item_id, name, description, required, critical)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name        = VALUES(name),
         description = VALUES(description),
         required    = VALUES(required),
         critical    = VALUES(critical),
         updated_at  = CURRENT_TIMESTAMP`,
      [
        transactionId,
        d.scope_item_id,
        d.name.substring(0, 255),
        d.description || null,
        d.required ? 1 : 0,
        d.critical ? 1 : 0,
      ],
    );
  }

  // Fetch the inserted/updated scope item rows so we have their PKs
  const scopeItemRows = await q.query(
    "SELECT id, scope_item_id FROM transaction_scope_items WHERE transaction_id = ?",
    [transactionId],
  );
  const rows = Array.isArray(scopeItemRows) ? scopeItemRows : [];
  const scopeItemMap = {}; // scope_item_id (string) → PK id
  rows.forEach((r) => {
    scopeItemMap[r.scope_item_id] = r.id;
  });

  // Delete all existing acceptance criteria for this transaction then re-insert
  await q.query(
    "DELETE FROM acceptance_criteria WHERE transaction_id = ?",
    [transactionId],
  );

  let criterionIndex = 1;

  // Per-deliverable criteria first
  for (const d of deliverables) {
    const scopeItemPk = scopeItemMap[d.scope_item_id];
    if (!scopeItemPk) continue;

    for (const criterion of d.acceptance_criteria) {
      const desc =
        typeof criterion === "string" ? criterion.trim() : (criterion?.description || "").trim();
      if (!desc) continue;

      const criterionId =
        typeof criterion === "object" && criterion?.criterion_id
          ? criterion.criterion_id
          : `ac${criterionIndex}`;

      criterionIndex++;

      await q.query(
        `INSERT INTO acceptance_criteria
           (scope_item_id, transaction_id, criterion_id, description, required, critical)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           description = VALUES(description),
           required    = VALUES(required),
           critical    = VALUES(critical)`,
        [
          scopeItemPk,
          transactionId,
          criterionId,
          desc,
          typeof criterion === "object" ? (criterion.required !== false ? 1 : 0) : 1,
          typeof criterion === "object" ? (criterion.critical ? 1 : 0) : 0,
        ],
      );
    }
  }

  // Global criteria: associate to the first deliverable's scope item (or skip if none)
  if (globalCriteria.length > 0 && deliverables.length > 0) {
    const firstScopeItemPk = scopeItemMap[deliverables[0].scope_item_id];
    if (firstScopeItemPk) {
      for (const criterion of globalCriteria) {
        const desc = typeof criterion === "string" ? criterion.trim() : "";
        if (!desc) continue;

        const criterionId = `ac${criterionIndex++}`;

        await q.query(
          `INSERT INTO acceptance_criteria
             (scope_item_id, transaction_id, criterion_id, description, required, critical)
           VALUES (?, ?, ?, ?, 1, 0)
           ON DUPLICATE KEY UPDATE description = VALUES(description)`,
          [firstScopeItemPk, transactionId, criterionId, desc],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// lockScope
// ---------------------------------------------------------------------------

/**
 * Locks all scope items for a transaction by stamping locked_at = NOW().
 * Once locked the AI audit will refuse to re-hydrate them, preserving the
 * agreed contractual requirements.
 *
 * @param {number} transactionId
 * @param {object} [conn]  - Optional mysql2 connection
 */
export async function lockScope(transactionId, conn) {
  const q = conn || db;
  await q.query(
    "UPDATE transaction_scope_items SET locked_at = NOW() WHERE transaction_id = ? AND locked_at IS NULL",
    [transactionId],
  );
}

// ---------------------------------------------------------------------------
// getScopeItems
// ---------------------------------------------------------------------------

/**
 * Returns all relational scope items and their acceptance criteria for a
 * given transaction, ordered by scope_item_id.
 *
 * Returns [] when no relational scope has been hydrated yet (fallback to
 * normalizeScope(scope_json) in the caller).
 *
 * @param {number} transactionId
 * @returns {Promise<Array<{
 *   id: number,
 *   scope_item_id: string,
 *   name: string,
 *   description: string|null,
 *   required: boolean,
 *   critical: boolean,
 *   locked: boolean,
 *   acceptance_criteria: Array<{ criterion_id, description, required, critical }>
 * }>>}
 */
export async function getScopeItems(transactionId) {
  const rows = await db.query(
    `SELECT tsi.id, tsi.scope_item_id, tsi.name, tsi.description,
            tsi.required, tsi.critical, tsi.locked_at
     FROM transaction_scope_items tsi
     WHERE tsi.transaction_id = ?
     ORDER BY tsi.id ASC`,
    [transactionId],
  );

  // db.query returns a flat array of rows
  const scopeRows = Array.isArray(rows) ? rows : [];

  if (!scopeRows || scopeRows.length === 0) return [];

  // Fetch criteria for all scope items in one query
  const scopeItemPks = scopeRows.map((r) => r.id);
  const criteriaRows = await db.query(
    `SELECT scope_item_id, criterion_id, description, required, critical
     FROM acceptance_criteria
     WHERE scope_item_id IN (?)
     ORDER BY id ASC`,
    [scopeItemPks],
  );
  const criteria = Array.isArray(criteriaRows) ? criteriaRows : [];

  // Group criteria by scope_item PK
  const criteriaByPk = {};
  (criteria || []).forEach((c) => {
    if (!criteriaByPk[c.scope_item_id]) criteriaByPk[c.scope_item_id] = [];
    criteriaByPk[c.scope_item_id].push({
      criterion_id: c.criterion_id,
      description: c.description,
      required: !!c.required,
      critical: !!c.critical,
    });
  });

  return scopeRows.map((r) => ({
    id: r.id,
    scope_item_id: r.scope_item_id,
    name: r.name,
    description: r.description || null,
    required: !!r.required,
    critical: !!r.critical,
    locked: !!r.locked_at,
    acceptance_criteria: criteriaByPk[r.id] || [],
  }));
}

// ---------------------------------------------------------------------------
// isScopeLocked
// ---------------------------------------------------------------------------

/**
 * Returns true if at least one scope item for this transaction has been locked.
 *
 * @param {number} transactionId
 * @returns {Promise<boolean>}
 */
export async function isScopeLocked(transactionId) {
  const rows = await db.query(
    "SELECT id FROM transaction_scope_items WHERE transaction_id = ? AND locked_at IS NOT NULL LIMIT 1",
    [transactionId],
  );
  const r = Array.isArray(rows) ? rows : [];
  return r.length > 0;
}
