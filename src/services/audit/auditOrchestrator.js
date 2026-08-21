/**
 * auditOrchestrator.js
 * Stage 3 — Audit Orchestrator Module
 *
 * Coordinates the full Stage 3 evidence-based audit pipeline:
 *   Audit Snapshot -> Stage 2 Evidence Analysis -> Deterministic Checks ->
 *   AI Requirement Reasoning -> 100% Coverage Repair -> Deterministic Verdict Policy ->
 *   Immutable Persistence in ai_audits.
 */

import db from "../../config/db.js";
import { createAuditSnapshot } from "./auditSnapshot.js";
import { analyzeSubmissionEvidence } from "../evidence/evidencePipeline.js";
import { runDeterministicChecks } from "./deterministicChecks.js";
import { auditRequirementsWithAi, ensureCompleteCoverage } from "./aiRequirementAuditor.js";
import { calculateFinalVerdict } from "./verdictPolicyEngine.js";

const AUDIT_VERSION = "3.0";

if (!process.env.GROQ_API_KEY) {
  console.warn("[auditOrchestrator] ⚠️  GROQ_API_KEY not set — AI audit will use smart deterministic fallback. Add GROQ_API_KEY to .env for full AI-powered analysis.");
}



/**
 * Runs the full Stage 3 evidence-based audit pipeline.
 *
 * @param {number} userId
 * @param {object} params
 * @param {number|string} params.transactionId
 * @param {number|string} [params.milestoneId]
 * @param {number|string} [params.submissionId]
 * @param {string} [params.title]
 * @param {string} [params.type]
 * @param {number} [params.amount]
 * @param {string} [params.currency]
 * @param {string} [params.counterparty]
 * @returns {Promise<object>} Complete Stage 3 audit result
 */
export async function runAuditPipeline(
  userId,
  {
    transactionId,
    milestoneId,
    submissionId,
    title = "Project",
    type = "Software Dev",
    amount = 0,
    currency = "USD",
    counterparty = "Vendor",
  },
) {
  let numTxId = Number(transactionId);
  if (isNaN(numTxId)) {
    const txRows = await db.query("SELECT id FROM transactions WHERE txn_code = ?", [transactionId]);
    if (txRows.length) numTxId = txRows[0].id;
  }

  const auditType = milestoneId ? "milestone" : "final";

  // Step 1: Create immutable point-in-time audit snapshot
  const snapshot = await createAuditSnapshot({
    transactionId: numTxId,
    milestoneId: milestoneId ? Number(milestoneId) : null,
    submissionId: submissionId ? Number(submissionId) : null,
    auditType,
  });

  // Step 2: Load & process Stage 2 evidence findings
  const stage2Analysis = await analyzeSubmissionEvidence({
    transactionId: numTxId,
    milestoneId: snapshot.milestoneId,
    submissionId: snapshot.submissionId,
  });

  // Step 3: Run deterministic objective checks per requirement
  const deterministicChecksMap = runDeterministicChecks({
    requirements: snapshot.requirements,
    submissionData: snapshot.submissionData,
    stage2EvidenceItems: stage2Analysis.processedEvidence,
    stage2Findings: stage2Analysis.findings,
    stage2Chunks: stage2Analysis.chunks,
  });

  // Step 4: AI Requirement-by-Requirement reasoning
  const rawAiResults = await auditRequirementsWithAi({
    requirements: snapshot.requirements,
    submissionData: snapshot.submissionData,
    deterministicChecks: deterministicChecksMap,
    stage2Findings: stage2Analysis.findings,
    stage2Chunks: stage2Analysis.chunks,
  });

  // Step 5: Enforce 100% requirement coverage
  const auditedRequirements = ensureCompleteCoverage(snapshot.requirements, rawAiResults);

  // Step 6: Calculate deterministic final verdict & release decision
  const verdict = calculateFinalVerdict({
    requirements: snapshot.requirements,
    auditedRequirementResults: auditedRequirements,
    deterministicChecks: deterministicChecksMap,
    limitations: stage2Analysis.limitations,
  });

  // Construct backward-compatible checks array for traditional UI consumers
  const legacyChecks = snapshot.requirements.map((req) => {
    const res = auditedRequirements.find((r) => r.criterion_id === req.criterion_id);
    const dCheck = deterministicChecksMap[req.criterion_id];

    let checkStatus = "passed";
    if (res?.status === "failed" || res?.status === "revision_required") checkStatus = "failed";
    else if (res?.status === "insufficient_evidence" || res?.status === "passed_with_notes") checkStatus = "warning";

    return {
      name: req.scope_name || req.criterion_id,
      status: checkStatus,
      note: res?.reason || dCheck?.facts?.[0] || "Requirement checked against submitted evidence.",
    };
  });

  // Step 7: Persist immutable audit record in ai_audits table
  const auditRecord = {
    transaction_id: numTxId,
    milestone_id: snapshot.milestoneId,
    submission_id: snapshot.submissionId,
    audited_by: userId,
    score: verdict.score,
    status: verdict.status,
    risk: verdict.risk,
    risk_score: verdict.riskScore,
    summary: verdict.summary,
    recommendation: verdict.recommendation,
    checks_json: JSON.stringify({
      checks: legacyChecks,
      requirements: auditedRequirements,
      missing_requirements: auditedRequirements.filter((r) => r.status === "failed" || r.status === "insufficient_evidence"),
      deterministic_checks: deterministicChecksMap,
    }),
    release_eligible: verdict.releaseEligible ? 1 : 0,
    release_decision: verdict.releaseDecision,
    release_blockers_json: JSON.stringify(verdict.releaseBlockers),
    audit_version: AUDIT_VERSION,
    snapshot_json: JSON.stringify({
      snapshotId: snapshot.snapshotId,
      evidenceHashes: snapshot.evidenceHashes,
      evidenceCount: snapshot.evidenceItems.length,
    }),
  };

  let auditId = null;
  try {
    const insertRes = await db.query(
      `INSERT INTO ai_audits
         (transaction_id, milestone_id, submission_id, audited_by, score, status, risk, risk_score, summary, recommendation, checks_json, release_eligible, release_decision, release_blockers_json, audit_version, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditRecord.transaction_id,
        auditRecord.milestone_id,
        auditRecord.submission_id,
        auditRecord.audited_by,
        auditRecord.score,
        auditRecord.status,
        auditRecord.risk,
        auditRecord.risk_score,
        auditRecord.summary,
        auditRecord.recommendation,
        auditRecord.checks_json,
        auditRecord.release_eligible,
        auditRecord.release_decision,
        auditRecord.release_blockers_json,
        auditRecord.audit_version,
        auditRecord.snapshot_json,
      ],
    );
    auditId = insertRes.insertId;
  } catch (dbErr) {
    console.error("[auditOrchestrator] Failed to persist audit in ai_audits:", dbErr.message);
  }

  // Construct complete Stage 3 audit report object
  return {
    auditId,
    auditVersion: AUDIT_VERSION,
    snapshotId: snapshot.snapshotId,
    transactionId: numTxId,
    milestoneId: snapshot.milestoneId,
    submissionId: snapshot.submissionId,
    score: verdict.score,
    status: verdict.status,
    risk: verdict.risk,
    riskScore: verdict.riskScore,
    releaseEligible: verdict.releaseEligible,
    releaseDecision: verdict.releaseDecision,
    releaseBlockers: verdict.releaseBlockers,
    summary: verdict.summary,
    recommendation: verdict.recommendation,
    coverage: verdict.coverage,
    requirements: auditedRequirements,
    checks: legacyChecks,
    deterministicChecks: deterministicChecksMap,
    limitations: stage2Analysis.limitations,
    processingSummary: stage2Analysis.processingSummary,
    created_at: new Date().toISOString(),
  };
}
