/**
 * evidenceStore.js
 * Stage 2 — Database Access Layer for Evidence Items, Results, Findings & Chunks
 *
 * Provides transactional persistence and retrieval for:
 *   - evidence_items
 *   - evidence_processing_results
 *   - evidence_findings
 *   - evidence_chunks
 */

import db from "../../config/db.js";

/**
 * Saves or updates an evidence item row in evidence_items table.
 *
 * @param {object} data
 * @param {object} [conn]  - Optional mysql2 pool connection
 * @returns {Promise<number>} Inserted/Updated primary key (id)
 */
export async function saveEvidenceItem(data, conn) {
  // Use pool directly for INSERT to get ResultSetHeader with insertId
  const pool = db.getPool();
  const [res] = await pool.query(
    `INSERT INTO evidence_items
       (evidence_id, transaction_id, milestone_id, submission_id, scope_item_id, criterion_id,
        evidence_type, original_url, storage_path, file_name, mime_type, file_size, sha256_hash,
        processing_status, processor_used, processing_error, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       submission_id     = VALUES(submission_id),
       storage_path      = VALUES(storage_path),
       processing_status = VALUES(processing_status),
       processor_used    = VALUES(processor_used),
       processing_error  = VALUES(processing_error),
       sha256_hash       = VALUES(sha256_hash),
       processed_at      = VALUES(processed_at)`,
    [
      data.evidence_id,
      data.transaction_id,
      data.milestone_id || null,
      data.submission_id || null,
      data.scope_item_id || null,
      data.criterion_id || null,
      data.evidence_type,
      data.original_url || null,
      data.storage_path || null,
      data.file_name || null,
      data.mime_type || null,
      data.file_size || 0,
      data.sha256_hash || null,
      data.processing_status || "pending",
      data.processor_used || null,
      data.processing_error || null,
      data.processed_at ? new Date(data.processed_at) : new Date(),
    ],
  );

  if (res.insertId) return res.insertId;

  // Retrieve PK if row was updated (ON DUPLICATE KEY hit, insertId = 0)
  const rows = await db.query("SELECT id FROM evidence_items WHERE evidence_id = ?", [
    data.evidence_id,
  ]);
  return rows[0]?.id;
}

/**
 * Saves a processing execution log row in evidence_processing_results table.
 *
 * @param {object} data
 * @param {object} [conn]
 */
export async function saveProcessingResult(data, conn) {
  const q = conn || db;

  await q.query(
    `INSERT INTO evidence_processing_results
       (evidence_item_id, processor_name, processor_version, status, result_json, error_message, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      data.evidence_item_id,
      data.processor_name,
      data.processor_version || "1.0.0",
      data.status,
      data.result_json ? JSON.stringify(data.result_json) : null,
      data.error_message || null,
    ],
  );
}

/**
 * Saves a batch of structured findings into evidence_findings table.
 *
 * @param {number} evidencePk       - FK id to evidence_items.id
 * @param {number} transactionId
 * @param {number|null} submissionId
 * @param {string|null} scopeItemId
 * @param {string|null} criterionId
 * @param {Array<object>} findings
 * @param {object} [conn]
 */
export async function saveFindings(
  evidencePk,
  transactionId,
  submissionId,
  scopeItemId,
  criterionId,
  findings,
  conn,
) {
  if (!findings || findings.length === 0) return;
  const q = conn || db;

  for (const f of findings) {
    await q.query(
      `INSERT INTO evidence_findings
         (evidence_item_id, transaction_id, submission_id, scope_item_id, criterion_id, finding_type, location, finding_text, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evidencePk,
        transactionId,
        submissionId || null,
        scopeItemId || null,
        criterionId || null,
        f.type || "observation",
        f.location || null,
        f.finding || f.text || "",
        f.metadata ? JSON.stringify(f.metadata) : null,
      ],
    );
  }
}

/**
 * Saves a batch of content chunks into evidence_chunks table.
 *
 * @param {number} evidencePk
 * @param {number} transactionId
 * @param {Array<object>} chunks
 * @param {object} [conn]
 */
export async function saveChunks(evidencePk, transactionId, chunks, conn) {
  if (!chunks || chunks.length === 0) return;
  const q = conn || db;

  for (const c of chunks) {
    await q.query(
      `INSERT INTO evidence_chunks
         (chunk_id, evidence_item_id, transaction_id, source_type, source_location, chunk_index, content, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [
        c.chunk_id,
        evidencePk,
        transactionId,
        c.source_type,
        c.source_location || null,
        c.chunk_index || 0,
        c.content,
        c.metadata ? JSON.stringify(c.metadata) : null,
      ],
    );
  }
}

/**
 * Retrieves all evidence items for a given submission.
 *
 * @param {number} submissionId
 * @returns {Promise<Array<object>>}
 */
export async function getEvidenceForSubmission(submissionId) {
  const rows = await db.query(
    "SELECT * FROM evidence_items WHERE submission_id = ? ORDER BY id ASC",
    [submissionId],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Retrieves all findings for a given submission.
 *
 * @param {number} submissionId
 * @returns {Promise<Array<object>>}
 */
export async function getEvidenceFindingsForSubmission(submissionId) {
  const rows = await db.query(
    `SELECT ef.*, ei.evidence_id, ei.evidence_type, ei.file_name, ei.sha256_hash
     FROM evidence_findings ef
     JOIN evidence_items ei ON ef.evidence_item_id = ei.id
     WHERE ef.submission_id = ?
     ORDER BY ef.id ASC`,
    [submissionId],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Retrieves all content chunks for a given submission.
 *
 * @param {number} submissionId
 * @returns {Promise<Array<object>>}
 */
export async function getEvidenceChunksForSubmission(submissionId) {
  const rows = await db.query(
    `SELECT ec.*, ei.evidence_id, ei.evidence_type
     FROM evidence_chunks ec
     JOIN evidence_items ei ON ec.evidence_item_id = ei.id
     WHERE ei.submission_id = ?
     ORDER BY ec.id ASC`,
    [submissionId],
  );
  return Array.isArray(rows) ? rows : [];
}
