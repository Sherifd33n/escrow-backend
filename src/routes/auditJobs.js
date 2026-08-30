/**
 * auditJobs.js
 * Stage 4 — Backend Async Audit Job API Routes
 *
 * Provides REST API endpoints for:
 *   - POST /api/audit-jobs         (enqueue background audit job)
 *   - GET  /api/audit-jobs/:jobId   (poll job status & progress)
 *   - POST /api/audit-jobs/:jobId/cancel (cancel audit job)
 *
 * Does NOT modify any frontend files.
 */

import express from "express";
import authMiddleware from "../middleware/auth.js";
import { createAuditJob, getJobStatus, cancelAuditJob } from "../services/jobs/auditQueue.js";
import { processNextWorkerJob } from "../services/jobs/auditWorker.js";

const router = express.Router();

router.use(authMiddleware);

// POST /api/audit-jobs - Enqueue background audit job
router.post("/", async (req, res, next) => {
  try {
    const { transactionId, milestoneId, submissionId, idempotencyKey } = req.body;
    if (!transactionId) {
      return res.status(400).json({ error: "transactionId is required." });
    }

    const job = await createAuditJob({
      transactionId,
      milestoneId: milestoneId ? Number(milestoneId) : null,
      submissionId: submissionId ? Number(submissionId) : null,
      userId: req.user.id,
      idempotencyKey,
    });

    // Trigger immediate background worker tick
    processNextWorkerJob().catch((err) =>
      console.warn("[auditJobs] Background worker tick note:", err.message),
    );

    res.json({
      success: true,
      job,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/audit-jobs/:jobId - Poll job status, progress (0-100%), and completed audit result
router.get("/:jobId", async (req, res, next) => {
  try {
    const jobStatus = await getJobStatus(req.params.jobId);
    if (!jobStatus) {
      return res.status(404).json({ error: "Audit job not found." });
    }

    res.json({
      success: true,
      job: jobStatus,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/audit-jobs/:jobId/cancel - Cancel audit job
router.post("/:jobId/cancel", async (req, res, next) => {
  try {
    const result = await cancelAuditJob(req.params.jobId, req.user.id);
    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
