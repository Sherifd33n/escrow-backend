/**
 * evidencePipeline.js
 * Stage 2 — Main Evidence Processing Pipeline Orchestration Service
 *
 * Orchestrates evidence ingestion, SSRF/file validation, SHA-256 hashing,
 * type-based processing, findings extraction, chunking, and database storage.
 *
 * Provides analyzeSubmissionEvidence({ transactionId, milestoneId, submissionId })
 * for Stage 3 AI audit consumption without computing pass/fail verdicts.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import db from "../../config/db.js";
import { getScopeItems } from "../scopeService.js";
import { validateEvidenceFile } from "./fileValidator.js";
import { validateUrlForSsrf } from "./ssrfValidator.js";
import { calculateSha256 } from "./hasher.js";
import {
  saveEvidenceItem,
  saveProcessingResult,
  saveFindings,
  saveChunks,
  getEvidenceForSubmission,
  getEvidenceFindingsForSubmission,
  getEvidenceChunksForSubmission,
} from "./evidenceStore.js";

import { processPdf } from "./processors/pdfProcessor.js";
import { processText } from "./processors/textProcessor.js";
import { processImage } from "./processors/imageProcessor.js";
import { processZip } from "./processors/zipProcessor.js";
import { processRepo, parseRepoUrl } from "./processors/repoProcessor.js";
import { processWebsite } from "./processors/websiteProcessor.js";
import { processUnsupported } from "./processors/unsupportedProcessor.js";

const __dirname_pipe = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname_pipe, "../../../uploads/evidence");

/**
 * Normalizes raw evidence entries from submission_data JSON into canonical objects.
 *
 * @param {object} submissionData
 * @returns {Array<{
 *   id: string,
 *   scope_item_id: string|null,
 *   criterion_id: string|null,
 *   type: string,
 *   source_type: string,
 *   label: string,
 *   url: string|null,
 *   file_name: string|null,
 *   description: string
 * }>}
 */
export function extractSubmissionEvidenceList(submissionData) {
  if (!submissionData || typeof submissionData !== "object") return [];

  const rawList = [];
  const seenIds = new Set();

  // 1. Per-deliverable evidence & inline text/claim extraction
  if (Array.isArray(submissionData.deliverables)) {
    submissionData.deliverables.forEach((d, idx) => {
      const scopeItemId = d?.scope_item_id || d?.id || null;

      // Extract explicit evidence items attached to deliverable
      if (Array.isArray(d?.evidence)) {
        d.evidence.forEach((ev, eIdx) => {
          if (ev) {
            const baseId = ev.id || `e_deliv_${scopeItemId || idx}_${eIdx}`;
            let uniqueId = baseId;
            if (seenIds.has(uniqueId)) {
              uniqueId = `${baseId}_${scopeItemId || idx}`;
            }
            seenIds.add(uniqueId);

            rawList.push({
              id: uniqueId,
              scope_item_id: scopeItemId,
              criterion_id: ev.criterion_id || null,
              type: ev.type || "link",
              source_type: ev.source_type || (ev.url ? "url" : "file"),
              label: ev.label || ev.file_name || ev.type || "Deliverable Evidence",
              url: ev.url || null,
              file_name: ev.file_name || null,
              description: ev.description || "",
            });
          }
        });
      }

      // Also extract inline claim / notes text as a text evidence item so AI can inspect code/text submitted inline
      const inlineText = d?.claim || d?.notes || d?.code || d?.description || "";
      if (typeof inlineText === "string" && inlineText.trim().length > 3) {
        const claimId = `e_claim_${scopeItemId || idx}`;
        if (!seenIds.has(claimId)) {
          seenIds.add(claimId);
          rawList.push({
            id: claimId,
            scope_item_id: scopeItemId,
            criterion_id: null,
            type: "documentation",
            source_type: "text",
            label: `Provider Submission Text for ${scopeItemId || idx}`,
            url: null,
            file_name: `submission_claim_${scopeItemId || idx}.txt`,
            description: inlineText.trim(),
          });
        }
      }
    });
  }

  // 2. Testing evidence
  if (Array.isArray(submissionData.testing?.evidence)) {
    submissionData.testing.evidence.forEach((ev, idx) => {
      if (ev) {
        const testId = ev.id || `e_test_${idx}`;
        if (!seenIds.has(testId)) {
          seenIds.add(testId);
          rawList.push({
            id: testId,
            scope_item_id: null,
            criterion_id: null,
            type: ev.type || "test_report",
            source_type: ev.source_type || "url",
            label: ev.label || "Testing Evidence",
            url: ev.url || null,
            file_name: ev.file_name || null,
            description: ev.description || "",
          });
        }
      }
    });
  }

  // 3. Additional evidence
  if (Array.isArray(submissionData.additional_evidence)) {
    submissionData.additional_evidence.forEach((ev, idx) => {
      if (ev) {
        const addId = ev.id || `e_add_${idx}`;
        if (!seenIds.has(addId)) {
          seenIds.add(addId);
          rawList.push({
            id: addId,
            scope_item_id: null,
            criterion_id: null,
            type: ev.type || "additional",
            source_type: ev.source_type || (ev.url ? "url" : "file"),
            label: ev.label || "Additional Evidence",
            url: ev.url || null,
            file_name: ev.file_name || null,
            description: ev.description || "",
          });
        }
      }
    });
  }

  return rawList;
}

/**
 * Determines processor type from evidence item metadata or file contents.
 *
 * @param {object} item
 * @param {string} [detectedType="unknown"]
 * @returns {string} Processor type
 */
function resolveProcessorType(item, detectedType = "unknown") {
  const t = (item.type || "").toLowerCase();
  const url = (item.url || "").toLowerCase();
  const fn = (item.file_name || "").toLowerCase();
  const cleanUrl = url.split("?")[0].split("#")[0];

  // Check concrete file formats FIRST — before any URL pattern matching
  // This ensures uploaded files (e.g. /uploads/evidence/archive.zip) are never
  // misidentified as repositories just because their URL path matches a pattern.
  if (detectedType === "zip" || t === "zip" || fn.endsWith(".zip") || cleanUrl.endsWith(".zip")) return "zip";
  if (detectedType === "pdf" || t === "pdf" || t === "security_report" || fn.endsWith(".pdf") || cleanUrl.endsWith(".pdf")) return "pdf";
  if (["png", "jpeg", "gif", "webp", "svg"].includes(detectedType) || fn.endsWith(".png") || fn.endsWith(".jpg") || fn.endsWith(".jpeg") || cleanUrl.endsWith(".png") || cleanUrl.endsWith(".jpg")) return "image";
  if (detectedType === "text" || fn.endsWith(".txt") || fn.endsWith(".md") || t === "documentation") {
    return isMarkdown(fn) ? "markdown" : "text";
  }

  // Repository check: only after ruling out concrete file types
  if (t === "repository" || parseRepoUrl(url)) return "repository";

  if (t === "staging" || (url.startsWith("http") && !url.includes("github") && !url.includes("/uploads/"))) {
    return "staging_url";
  }

  return "unsupported";
}

function isMarkdown(fn) {
  return typeof fn === "string" && (fn.endsWith(".md") || fn.endsWith(".markdown"));
}

/**
 * Ingests, validates, hashes, processes, and persists a single evidence item.
 *
 * @param {object} params
 * @param {number} params.transactionId
 * @param {number|null} params.milestoneId
 * @param {number|null} params.submissionId
 * @param {object} params.rawItem
 * @returns {Promise<object>} Processing outcome summary
 */
export async function processSingleEvidence({ transactionId, milestoneId, submissionId, rawItem }) {
  // Make evidence_id unique per submission to prevent ON DUPLICATE KEY collisions
  // that would keep old submission_id on the evidence_items row, breaking chunk/finding retrieval
  const baseId = rawItem.id || `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const evidenceId = submissionId ? `${baseId}_s${submissionId}` : baseId;
  let storagePath = null;
  let fileBuffer = null;
  let sha256Hash = null;
  let fileSize = 0;
  let mimeType = null;
  let detectedFileType = "unknown";

  // 1. Check if evidence refers to a local file on disk or upload path
  if (rawItem.url) {
    const normUrl = String(rawItem.url).replace(/\\/g, "/");
    let candidatePath = null;

    if (normUrl.includes("/uploads/evidence/")) {
      const rel = normUrl.split("/uploads/evidence/")[1].split("?")[0].split("#")[0];
      candidatePath = path.join(UPLOADS_DIR, decodeURIComponent(rel));
    } else if (fs.existsSync(rawItem.url)) {
      candidatePath = rawItem.url;
    }

    if (candidatePath && fs.existsSync(candidatePath)) {
      storagePath = candidatePath;
      const valRes = await validateEvidenceFile({
        filePath: storagePath,
        fileName: rawItem.file_name || path.basename(storagePath),
      });

      if (valRes.valid) {
        fileBuffer = valRes.buffer;
        fileSize = valRes.size;
        detectedFileType = valRes.detectedType;
        sha256Hash = calculateSha256(fileBuffer);
      }
    }
  }

  let processorType = resolveProcessorType(rawItem, detectedFileType);

  // 2. If fileBuffer is null but URL points to a file or link, download it safely
  if (!fileBuffer && rawItem.url && (rawItem.url.startsWith("http") || rawItem.url.startsWith("https"))) {
    try {
      const { safeFetchUrl } = await import("./ssrfValidator.js");
      const resp = await safeFetchUrl(rawItem.url, { timeoutMs: 15000, maxSize: 50 * 1024 * 1024 });
      if (resp.body && resp.body.length > 0) {
        fileBuffer = resp.body;
        fileSize = fileBuffer.length;
        sha256Hash = calculateSha256(fileBuffer);

        const valRes = await validateEvidenceFile({
          filePath: null,
          fileName: rawItem.file_name || rawItem.url,
          buffer: fileBuffer,
        });
        if (valRes.valid) {
          detectedFileType = valRes.detectedType;
          processorType = resolveProcessorType(rawItem, detectedFileType);
        }
      }
    } catch (fetchErr) {
      console.warn(`[evidencePipeline] Could not download remote file URL (${rawItem.url}):`, fetchErr.message);
    }
  }

  // Initial evidence_item state
  const itemData = {
    evidence_id: evidenceId,
    transaction_id: transactionId,
    milestone_id: milestoneId,
    submission_id: submissionId,
    scope_item_id: rawItem.scope_item_id,
    criterion_id: rawItem.criterion_id,
    evidence_type: processorType,
    original_url: rawItem.url,
    storage_path: storagePath,
    file_name: rawItem.file_name || rawItem.label || null,
    mime_type: mimeType,
    file_size: fileSize,
    sha256_hash: sha256Hash,
    processing_status: "processing",
    processor_used: processorType,
    processing_error: null,
    processed_at: new Date(),
  };

  const evidencePk = await saveEvidenceItem(itemData);

  let processResult = null;

  try {
    switch (processorType) {
      case "pdf":
        processResult = await processPdf({
          buffer: fileBuffer,
          evidenceId,
          fileName: itemData.file_name || "document.pdf",
        });
        break;

      case "text":
      case "markdown":
        processResult = await processText({
          content: fileBuffer || rawItem.description || rawItem.label,
          evidenceId,
          fileName: itemData.file_name || "document.txt",
          type: processorType,
        });
        break;

      case "image":
        processResult = await processImage({
          buffer: fileBuffer,
          evidenceId,
          fileName: itemData.file_name || "image.png",
        });
        break;

      case "zip":
        console.log(`[evidencePipeline] Processing ZIP: evidenceId=${evidenceId}, hasBuffer=${!!fileBuffer}, bufferSize=${fileBuffer?.length || 0}, url=${rawItem.url}`);
        processResult = await processZip({
          buffer: fileBuffer,
          evidenceId,
          fileName: itemData.file_name || path.basename(rawItem.url || "archive.zip"),
        });
        console.log(`[evidencePipeline] ZIP result: status=${processResult?.status}, files=${processResult?.totalFiles}, chunks=${processResult?.chunks?.length}, findings=${processResult?.findings?.length}`);
        break;

      case "repository":
        processResult = await processRepo({
          url: rawItem.url || "",
          evidenceId,
        });
        break;

      case "staging_url":
        processResult = await processWebsite({
          url: rawItem.url || "",
          evidenceId,
        });
        break;

      default:
        processResult = await processUnsupported({
          evidenceId,
          evidenceType: rawItem.type || "unknown",
          label: rawItem.label,
        });
        break;
    }
  } catch (procErr) {
    console.error(`[evidencePipeline] Processor failure (${processorType}):`, procErr.message);
    processResult = {
      type: processorType,
      status: "failed",
      findings: [
        {
          type: "processing_error",
          location: rawItem.label,
          finding: `Evidence processing failed: ${procErr.message}`,
        },
      ],
      chunks: [],
      error: procErr.message,
    };
  }

  // Finalize evidence_item status & persist output
  const finalStatus = processResult.status || "processed";
  itemData.processing_status = finalStatus;
  itemData.processing_error = processResult.error || null;
  itemData.processed_at = new Date();

  await saveEvidenceItem(itemData);

  // Save execution log
  await saveProcessingResult({
    evidence_item_id: evidencePk,
    processor_name: processorType,
    processor_version: "1.0.0",
    status: finalStatus,
    result_json: processResult,
    error_message: processResult.error || null,
  });

  // Save findings
  if (processResult.findings && processResult.findings.length > 0) {
    await saveFindings(
      evidencePk,
      transactionId,
      submissionId,
      rawItem.scope_item_id,
      rawItem.criterion_id,
      processResult.findings,
    );
  }

  // Save chunks
  if (processResult.chunks && processResult.chunks.length > 0) {
    await saveChunks(evidencePk, transactionId, processResult.chunks);
  }

  return {
    evidencePk,
    evidenceId,
    type: processorType,
    status: finalStatus,
    findingsCount: processResult.findings?.length || 0,
    chunksCount: processResult.chunks?.length || 0,
  };
}

/**
 * Prepares complete Stage 3 evidence analysis package for a given submission.
 * Ingests and processes any unprocessed evidence items, retrieves findings,
 * content chunks, and processing summary.
 *
 * DOES NOT compute audit scores, pass/fail verdicts, or AI release judgments.
 *
 * @param {object} params
 * @param {number|string} params.transactionId
 * @param {number|string} [params.milestoneId]
 * @param {number|string} [params.submissionId]
 * @returns {Promise<{
 *   transactionId: number,
 *   milestoneId: number|null,
 *   submissionId: number|null,
 *   processedEvidence: Array<object>,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   limitations: Array<object>,
 *   processingSummary: {
 *     total: number,
 *     processed: number,
 *     failed: number,
 *     unsupported: number,
 *     blocked: number,
 *     access_required: number
 *   }
 * }>}
 */
export async function analyzeSubmissionEvidence({ transactionId, milestoneId, submissionId }) {
  let numTxId = Number(transactionId);
  if (isNaN(numTxId)) {
    const rows = await db.query("SELECT id FROM transactions WHERE txn_code = ?", [transactionId]);
    if (rows.length) numTxId = rows[0].id;
  }

  let targetSubId = submissionId ? Number(submissionId) : null;
  let targetMId = milestoneId ? Number(milestoneId) : null;
  let subRecord = null;

  // Resolve active submission record if subId not provided directly
  if (!targetSubId && numTxId) {
    const subRows = await db.query(
      `SELECT * FROM milestone_submissions
       WHERE transaction_id = ?
       ORDER BY id DESC LIMIT 1`,
      [numTxId],
    );
    if (subRows.length) {
      subRecord = subRows[0];
      targetSubId = subRecord.id;
      targetMId = subRecord.milestone_id;
    }
  } else if (targetSubId) {
    const subRows = await db.query(
      "SELECT * FROM milestone_submissions WHERE id = ?",
      [targetSubId],
    );
    if (subRows.length) subRecord = subRows[0];
  }

  if (subRecord && subRecord.submission_data) {
    const parsedSubData =
      typeof subRecord.submission_data === "string"
        ? JSON.parse(subRecord.submission_data)
        : subRecord.submission_data;

    const rawEvidenceList = extractSubmissionEvidenceList(parsedSubData);

    // Process all evidence items for this submission
    for (const rawItem of rawEvidenceList) {
      await processSingleEvidence({
        transactionId: numTxId,
        milestoneId: targetMId,
        submissionId: targetSubId,
        rawItem,
      });
    }
  }

  // Load persisted results
  const items = targetSubId ? await getEvidenceForSubmission(targetSubId) : [];
  const findings = targetSubId ? await getEvidenceFindingsForSubmission(targetSubId) : [];
  const chunks = targetSubId ? await getEvidenceChunksForSubmission(targetSubId) : [];

  const summary = {
    total: items.length,
    processed: items.filter((i) => i.processing_status === "processed").length,
    failed: items.filter((i) => i.processing_status === "failed").length,
    unsupported: items.filter((i) => i.processing_status === "unsupported").length,
    blocked: items.filter((i) => i.processing_status === "blocked").length,
    access_required: items.filter((i) => i.processing_status === "access_required").length,
  };

  const limitations = findings.filter(
    (f) =>
      f.finding_type.includes("limitation") ||
      f.finding_type.includes("block") ||
      f.finding_type.includes("unsupported") ||
      f.finding_type.includes("error") ||
      f.finding_type.includes("access_status"),
  );

  return {
    transactionId: numTxId,
    milestoneId: targetMId,
    submissionId: targetSubId,
    processedEvidence: items,
    findings,
    chunks,
    limitations,
    processingSummary: summary,
  };
}
