/**
 * auditQueue.js
 * Stage 4 — Background Audit Job Queue & Idempotency Service
 *
 * Manages background audit job creation, status polling, idempotency enforcement,
 * progress tracking, and job cancellation.
 */

import db from "../../config/db.js";
import { AUDIT_CONFIG } from "../../config/auditConfig.js";

/**
 * Creates or retrieves an existing audit job with idempotency protection.
 *
 * @param {object} params
 * @param {number} params.transactionId
 * @param {number|null} [params.milestoneId]
 * @param {number|null} [params.submissionId]
 * @param {number} params.userId
 * @param {string} [params.idempotencyKey]
 * @returns {Promise<{ jobId: string, status: string, phase: string, progress: number }>}
 */
export async function createAuditJob({
  transactionId,
  milestoneId = null,
  submissionId = null,
  userId,
  idempotencyKey = null,
}) {
  const numTxId = Number(transactionId);
  const idempKey = idempotencyKey || `idemp_tx${numTxId}_m${milestoneId || 0}_s${submissionId || 0}`;

  // 1. Check for existing active job with same idempotency key
  const existingRows = await db.query(
    "SELECT * FROM audit_jobs WHERE idempotency_key = ? AND status IN ('queued', 'processing', 'completed') LIMIT 1",
    [idempKey],
  );

  if (existingRows.length > 0) {
    const job = existingRows[0];
    return {
      jobId: job.job_id,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      currentTask: job.current_task,
      auditId: job.audit_id,
    };
  }

  // 2. Insert new queued job
  const jobId = `job_${numTxId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  await db.query(
    `INSERT INTO audit_jobs
       (job_id, transaction_id, milestone_id, submission_id, user_id, status, phase, progress, current_task, max_retries, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 0, 'Job enqueued for worker execution', ?, ?)`,
    [
      jobId,
      numTxId,
      milestoneId || null,
      submissionId || null,
      userId,
      AUDIT_CONFIG.JOB_RETRY_LIMIT,
      idempKey,
    ],
  );

  return {
    jobId,
    status: "queued",
    phase: "queued",
    progress: 0,
    currentTask: "Job enqueued for worker execution",
  };
}

/**
 * Fetches status, phase, progress, and completed result for an audit job.
 *
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
export async function getJobStatus(jobId) {
  const rows = await db.query("SELECT * FROM audit_jobs WHERE job_id = ?", [jobId]);
  if (!rows.length) return null;

  const job = rows[0];
  let auditResult = null;

  if (job.status === "completed" && job.audit_id) {
    const auditRows = await db.query("SELECT * FROM ai_audits WHERE id = ?", [job.audit_id]);
    if (auditRows.length) {
      const a = auditRows[0];
      let checksJson = null;
      try { checksJson = JSON.parse(a.checks_json); } catch (_) {}

      auditResult = {
        auditId: a.id,
        score: a.score,
        status: a.status,
        risk: a.risk,
        riskScore: a.risk_score,
        summary: a.summary,
        recommendation: a.recommendation,
        releaseEligible: !!a.release_eligible,
        releaseDecision: a.release_decision,
        checks: checksJson?.checks || [],
        requirements: checksJson?.requirements || [],
        auditVersion: a.audit_version,
      };
    }
  }

  return {
    jobId: job.job_id,
    transactionId: job.transaction_id,
    milestoneId: job.milestone_id,
    submissionId: job.submission_id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    currentTask: job.current_task,
    retryCount: job.retry_count,
    lastError: job.last_error,
    auditId: job.audit_id,
    auditResult,
    createdAt: job.created_at,
    completedAt: job.completed_at,
  };
}

/**
 * Cancels an active audit job if authorized.
 *
 * @param {string} jobId
 * @param {number} userId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function cancelAuditJob(jobId, userId) {
  const rows = await db.query("SELECT * FROM audit_jobs WHERE job_id = ?", [jobId]);
  if (!rows.length) return { success: false, message: "Job not found." };

  const job = rows[0];
  if (job.user_id !== userId) return { success: false, message: "Unauthorized." };

  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return { success: false, message: `Cannot cancel job with status "${job.status}".` };
  }

  await db.query(
    "UPDATE audit_jobs SET status = 'cancelled', phase = 'cancelled', current_task = 'Job cancelled by user' WHERE job_id = ?",
    [jobId],
  );

  return { success: true, message: "Audit job cancelled successfully." };
}
