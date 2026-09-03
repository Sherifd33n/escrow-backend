/**
 * auditWorker.js
 * Stage 4 — Background Worker Process & Job Execution Engine
 *
 * Atomically claims queued jobs, executes Stages 1-3 audit pipeline + Stage 4 specialized
 * analyzers with complete evidence context, updates progress & phase metrics, handles
 * exponential backoff retries, and recovers crashed/stuck worker jobs continuously.
 */

import db from "../../config/db.js";
import { AUDIT_CONFIG } from "../../config/auditConfig.js";
import { runAuditPipeline } from "../audit/auditOrchestrator.js";
import { analyzerRegistry } from "../analyzers/analyzerRegistry.js";
import { processSubscriptionLifecycle } from "../subscriptionService.js";

const WORKER_ID = `worker_${process.pid}_${Math.random().toString(36).substring(2, 6)}`;
let workerLoopInterval = null;
let lastSubLifecycleRun = 0;

/**
 * Recovers stuck jobs that were left in 'processing' status due to a process crash or worker failure.
 */
export async function recoverStuckWorkerJobs() {
  try {
    const timeoutCutoff = new Date(Date.now() - AUDIT_CONFIG.JOB_TIMEOUT_MS);
    const result = await db.query(
      `UPDATE audit_jobs
       SET status = 'queued',
           phase = 'queued',
           progress = 0,
           current_task = 'Recovered from worker timeout/crash',
           worker_id = NULL,
           claimed_at = NULL
       WHERE status = 'processing' AND claimed_at < ?`,
      [timeoutCutoff]
    );

    if (result.affectedRows > 0) {
      console.log(`[auditWorker] Recovered ${result.affectedRows} stuck/crashed audit job(s).`);
    }
  } catch (err) {
    console.error("[auditWorker] Error recovering stuck worker jobs:", err.message);
  }
}

/**
 * Atomically claims the next queued or timed-out stuck audit job.
 *
 * @param {string} workerId
 * @returns {Promise<object|null>} Claimed job object or null
 */
export async function claimNextJob(workerId = WORKER_ID) {
  const timeoutCutoff = new Date(Date.now() - AUDIT_CONFIG.JOB_TIMEOUT_MS);

  // 1. Locate next eligible job
  const candidateRows = await db.query(
    `SELECT id, job_id FROM audit_jobs
     WHERE (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
        OR (status = 'processing' AND claimed_at < ?)
     ORDER BY id ASC LIMIT 1`,
    [timeoutCutoff],
  );

  if (!candidateRows.length) return null;

  const candidateId = candidateRows[0].id;

  // 2. Atomic claim update
  const claimRes = await db.query(
    `UPDATE audit_jobs
     SET status = 'processing',
         phase = 'validating',
         progress = 10,
         current_task = 'Worker claimed job for execution',
         worker_id = ?,
         claimed_at = CURRENT_TIMESTAMP,
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND (status = 'queued' OR claimed_at < ?)`,
    [workerId, candidateId, timeoutCutoff],
  );

  if (claimRes.affectedRows === 0) return null;

  // 3. Return full job details
  const jobRows = await db.query("SELECT * FROM audit_jobs WHERE id = ?", [candidateId]);
  return jobRows[0] || null;
}

/**
 * Updates progress percentage, phase name, and current task description for a job.
 *
 * @param {string} jobId
 * @param {number} progress (0-100)
 * @param {string} phase
 * @param {string} currentTask
 */
export async function updateJobProgress(jobId, progress, phase, currentTask) {
  await db.query(
    "UPDATE audit_jobs SET progress = ?, phase = ?, current_task = ? WHERE job_id = ?",
    [progress, phase, currentTask, jobId],
  );
}

/**
 * Executes a claimed audit job.
 *
 * @param {object} job
 * @returns {Promise<object>} Audit execution result
 */
export async function executeJob(job) {
  const jobId = job.job_id;

  try {
    // Step 1: Validation & Stages 1-3 AI Audit Pipeline Execution (50%)
    await updateJobProgress(jobId, 20, "validating", "Validating contractual scope & submission data");
    await updateJobProgress(jobId, 50, "running_ai_audit", "Executing Stage 3 evidence-based AI audit engine");

    const auditResult = await runAuditPipeline(job.user_id, {
      transactionId: job.transaction_id,
      milestoneId: job.milestone_id,
      submissionId: job.submission_id,
    });

    // Step 2: Specialized Stage 4 Analyzers with COMPLETE evidence context (85%)
    await updateJobProgress(jobId, 85, "running_analyzers", "Executing specialized project analyzers with complete evidence context");

    const txRows = await db.query("SELECT category FROM transactions WHERE id = ?", [job.transaction_id]);
    const category = txRows.length ? txRows[0].category : "web";
    const analyzers = analyzerRegistry.getApplicableAnalyzers(category);
    const hasSpecialized = analyzerRegistry.hasSpecializedAnalyzer(category);

    let submissionData = null;
    if (job.submission_id) {
      const subRows = await db.query("SELECT submission_data FROM milestone_submissions WHERE id = ?", [job.submission_id]);
      if (subRows.length && subRows[0].submission_data) {
        try {
          submissionData = typeof subRows[0].submission_data === "string"
            ? JSON.parse(subRows[0].submission_data)
            : subRows[0].submission_data;
        } catch (_) {}
      }
    }

    const canonicalAuditContext = {
      transactionId: job.transaction_id,
      milestoneId: job.milestone_id,
      submissionId: job.submission_id,
      category,
      scopeRequirements: auditResult.requirements || [],
      submissionData,
      stage2EvidenceItems: auditResult.processingSummary?.processedEvidence || [],
      stage2Findings: auditResult.processingSummary?.findings || [],
      deterministicChecks: auditResult.deterministicChecks || {},
      limitations: auditResult.limitations || [],
      fileTree: auditResult.processingSummary?.fileTree || [],
      chunks: auditResult.processingSummary?.chunks || [],
      evidenceHashes: auditResult.processingSummary?.evidenceHashes || {},
      executionMode: hasSpecialized ? "specialized_analyzer_executed" : "fallback_general_analyzer_executed",
    };

    for (const analyzerFn of analyzers) {
      // Deep-clone context to guarantee analyzer isolation and immutability
      const isolatedContext = JSON.parse(JSON.stringify(canonicalAuditContext));
      try {
        const analyzerRes = await analyzerFn(isolatedContext);
        if (analyzerRes) {
          await db.query(
            `INSERT INTO analyzer_results
               (audit_job_id, analyzer_name, analyzer_version, status, findings_json, limitations_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              job.id,
              analyzerRes.analyzer || "specialized",
              analyzerRes.version || "1.0.0",
              analyzerRes.status || "completed",
              JSON.stringify(analyzerRes.findings || []),
              JSON.stringify(analyzerRes.limitations || []),
            ],
          );
        }
      } catch (aErr) {
        console.error(`[auditWorker] Specialized analyzer failed for job ${jobId}:`, aErr.message);
        // Record analyzer failure explicitly without fabricating success
        await db.query(
          `INSERT INTO analyzer_results
             (audit_job_id, analyzer_name, analyzer_version, status, findings_json, limitations_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            job.id,
            "analyzer_error",
            "1.0.0",
            "failed",
            JSON.stringify([{ type: "analyzer_error", severity: "error", description: aErr.message }]),
            JSON.stringify([`Analyzer execution failed: ${aErr.message}`]),
          ],
        );
      }
    }

    // Step 3: Completion phase (100%)
    await updateJobProgress(jobId, 100, "completed", "Audit completed successfully");

    await db.query(
      `UPDATE audit_jobs
       SET status = 'completed',
           phase = 'completed',
           progress = 100,
           current_task = 'Audit complete',
           completed_at = CURRENT_TIMESTAMP,
           audit_id = ?
       WHERE job_id = ?`,
      [auditResult.auditId, jobId],
    );

    return auditResult;
  } catch (err) {
    console.error(`[auditWorker] Job execution error for ${jobId}:`, err.message);

    const retryCount = (job.retry_count || 0) + 1;
    const maxRetries = job.max_retries || AUDIT_CONFIG.JOB_RETRY_LIMIT;

    if (retryCount < maxRetries) {
      // Exponential backoff delay (5s, 10s, 20s)
      const backoffSec = Math.pow(2, retryCount) * 5;
      const nextRetryAt = new Date(Date.now() + backoffSec * 1000);

      await db.query(
        `UPDATE audit_jobs
         SET status = 'queued',
             phase = 'queued',
             progress = 0,
             current_task = ?,
             retry_count = ?,
             last_error = ?,
             next_retry_at = ?
         WHERE job_id = ?`,
        [
          `Transient failure: retrying in ${backoffSec}s (attempt ${retryCount}/${maxRetries})`,
          retryCount,
          err.message,
          nextRetryAt,
          jobId,
        ],
      );
    } else {
      // Permanent job failure
      await db.query(
        `UPDATE audit_jobs
         SET status = 'failed',
             phase = 'failed',
             current_task = 'Job failed after maximum retries',
             retry_count = ?,
             last_error = ?
         WHERE job_id = ?`,
        [retryCount, err.message, jobId],
      );
    }

    throw err;
  }
}

/**
 * Runs one worker tick: claims next job and processes it.
 *
 * @returns {Promise<boolean>} True if a job was processed
 */
export async function processNextWorkerJob() {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;

  try {
    await executeJob(job);
  } catch (_) {}

  return true;
}

/**
 * Starts continuous durable background worker loop and recovers crashed jobs on boot.
 */
export function startAuditWorkerLoop(intervalMs = 5000) {
  if (workerLoopInterval) return;

  // Run initial crash recovery check on boot
  recoverStuckWorkerJobs().catch((err) =>
    console.error("[auditWorker] Initial crash recovery error:", err.message)
  );

  workerLoopInterval = setInterval(async () => {
    try {
      await processNextWorkerJob();

      // Check subscription lifecycle every 60 seconds
      if (Date.now() - lastSubLifecycleRun > 60000) {
        lastSubLifecycleRun = Date.now();
        processSubscriptionLifecycle().catch((e) =>
          console.warn("[auditWorker] Periodic subscription lifecycle check failed:", e.message)
        );
      }
    } catch (err) {
      console.error("[auditWorker] Background worker tick error:", err.message);
    }
  }, intervalMs);

  console.log(`[auditWorker] Durable background audit worker loop started (${WORKER_ID}, interval ${intervalMs}ms).`);
}
