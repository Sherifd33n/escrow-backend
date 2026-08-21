/**
 * auditSnapshot.js
 * Stage 2 & 3 — Immutable Audit Snapshot Layer
 *
 * Captures point-in-time immutable snapshots of contractual scope items,
 * acceptance criteria, provider claims, Stage 2 evidence metadata & SHA-256 hashes.
 *
 * Differentiates milestone-level audits from complete final project audits.
 */

import db from "../../config/db.js";
import { getScopeItems, isScopeLocked } from "../scopeService.js";
import { getEvidenceForSubmission } from "../evidence/evidenceStore.js";

/**
 * Normalizes scope items into flat criterion-level requirement definitions.
 *
 * @param {Array<object>} scopeItems
 * @returns {Array<{
 *   criterion_id: string,
 *   scope_item_id: string,
 *   scope_name: string,
 *   requirement: string,
 *   required: boolean,
 *   critical: boolean,
 *   locked: boolean
 * }>}
 */
export function flattenScopeRequirements(scopeItems) {
  if (!Array.isArray(scopeItems) || scopeItems.length === 0) return [];

  const flattened = [];

  scopeItems.forEach((item) => {
    const scopeItemId = item.scope_item_id || item.id || "d1";
    const scopeName = item.name || item.title || "Scope Item";

    if (Array.isArray(item.acceptance_criteria) && item.acceptance_criteria.length > 0) {
      item.acceptance_criteria.forEach((ac, acIdx) => {
        const criterionId = ac.criterion_id || `${scopeItemId}_ac${acIdx + 1}`;
        const desc = typeof ac === "string" ? ac : ac.description || ac.text || scopeName;

        flattened.push({
          criterion_id: criterionId,
          scope_item_id: scopeItemId,
          scope_name: scopeName,
          requirement: desc,
          required: typeof ac === "object" ? ac.required !== false : item.required !== false,
          critical: typeof ac === "object" ? !!ac.critical : !!item.critical,
          locked: !!item.locked,
        });
      });
    } else {
      // Fallback: 1 requirement per deliverable if no acceptance_criteria array
      flattened.push({
        criterion_id: `${scopeItemId}_ac1`,
        scope_item_id: scopeItemId,
        scope_name: scopeName,
        requirement: item.description || item.name || "Deliverable completion",
        required: item.required !== false,
        critical: !!item.critical,
        locked: !!item.locked,
      });
    }
  });

  return flattened;
}

/**
 * Captures an immutable audit snapshot for a transaction & submission.
 *
 * @param {object} params
 * @param {number} params.transactionId
 * @param {number|null} [params.milestoneId]
 * @param {number|null} [params.submissionId]
 * @param {string} [params.auditType="milestone"] - 'milestone' or 'final'
 * @param {object} [params.conn]
 * @returns {Promise<{
 *   snapshotId: string,
 *   transactionId: number,
 *   milestoneId: number|null,
 *   submissionId: number|null,
 *   auditType: "milestone"|"final",
 *   scopeLocked: boolean,
 *   requirements: Array<object>,
 *   submissionData: object|null,
 *   evidenceHashes: object,
 *   evidenceItems: Array<object>,
 *   createdAt: string
 * }>}
 */
export async function createAuditSnapshot({
  transactionId,
  milestoneId = null,
  submissionId = null,
  auditType = "milestone",
  conn,
}) {
  const q = conn || db;
  const numTxId = Number(transactionId);

  // 1. Load relational scope items
  let scopeItems = await getScopeItems(numTxId);
  const scopeLocked = await isScopeLocked(numTxId);

  // Fallback to transactions.scope_json if no relational rows exist
  if (!scopeItems || scopeItems.length === 0) {
    const txRows = await q.query("SELECT scope_json FROM transactions WHERE id = ?", [numTxId]);
    if (txRows.length && txRows[0].scope_json) {
      let parsed = txRows[0].scope_json;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch (_) {}
      }
      if (parsed && Array.isArray(parsed.deliverables)) {
        scopeItems = parsed.deliverables.map((d, idx) => ({
          scope_item_id: d.scope_item_id || d.id || `d${idx + 1}`,
          name: d.name || d.title || `Deliverable ${idx + 1}`,
          description: d.description || "",
          required: true,
          critical: false,
          acceptance_criteria: Array.isArray(d.acceptance_criteria) ? d.acceptance_criteria : [],
        }));
      }
    }
  }

  // Flatten scope items into criterion-level requirements
  let requirements = flattenScopeRequirements(scopeItems);

  // If milestone audit & milestones exist, scope items can be filtered per milestone if specified
  if (auditType === "milestone" && milestoneId && requirements.length > 1) {
    // If milestones have deliverable mappings, keep relevant requirements
    // For single milestone projects or general deliverables, all deliverables apply
  }

  // 2. Load target submission record
  let subRecord = null;
  let parsedSubData = null;

  if (submissionId) {
    const subRows = await q.query("SELECT * FROM milestone_submissions WHERE id = ?", [submissionId]);
    if (subRows.length) subRecord = subRows[0];
  } else if (numTxId) {
    const subRows = await q.query(
      "SELECT * FROM milestone_submissions WHERE transaction_id = ? ORDER BY id DESC LIMIT 1",
      [numTxId],
    );
    if (subRows.length) subRecord = subRows[0];
  }

  if (subRecord && subRecord.submission_data) {
    parsedSubData = typeof subRecord.submission_data === "string"
      ? JSON.parse(subRecord.submission_data)
      : subRecord.submission_data;
  }

  // 3. Load Stage 2 evidence items & SHA-256 hashes
  const realSubId = subRecord ? subRecord.id : null;
  const evidenceItems = realSubId ? await getEvidenceForSubmission(realSubId) : [];

  const evidenceHashes = {};
  evidenceItems.forEach((item) => {
    if (item.sha256_hash) {
      evidenceHashes[item.evidence_id] = {
        hash: item.sha256_hash,
        fileName: item.file_name,
        size: item.file_size,
        status: item.processing_status,
      };
    }
  });

  const snapshotId = `snap_${numTxId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = new Date().toISOString();

  // 4. Persist snapshot in audit_snapshots table
  await q.query(
    `INSERT INTO audit_snapshots
       (snapshot_id, transaction_id, milestone_id, submission_id, audit_type, scope_locked, requirements_json, submission_json, evidence_hashes_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshotId,
      numTxId,
      milestoneId || (subRecord ? subRecord.milestone_id : null),
      realSubId,
      auditType,
      scopeLocked ? 1 : 0,
      JSON.stringify(requirements),
      parsedSubData ? JSON.stringify(parsedSubData) : null,
      JSON.stringify(evidenceHashes),
    ],
  );

  return {
    snapshotId,
    transactionId: numTxId,
    milestoneId: milestoneId || (subRecord ? subRecord.milestone_id : null),
    submissionId: realSubId,
    auditType,
    scopeLocked,
    requirements,
    submissionData: parsedSubData,
    evidenceHashes,
    evidenceItems,
    createdAt,
  };
}
