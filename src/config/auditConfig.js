/**
 * auditConfig.js
 * Stage 4 — Centralized Resource Limits & Timeouts Configuration
 *
 * Centralizes all security, file, network, worker, retry, and AI limits.
 */

export const AUDIT_CONFIG = Object.freeze({
  MAX_EVIDENCE_SIZE: parseInt(process.env.MAX_EVIDENCE_SIZE || "20971520", 10), // 20 MB
  MAX_SUBMISSION_EVIDENCE_SIZE: parseInt(process.env.MAX_SUBMISSION_EVIDENCE_SIZE || "104857600", 10), // 100 MB
  MAX_ZIP_EXTRACTED_SIZE: parseInt(process.env.MAX_ZIP_EXTRACTED_SIZE || "52428800", 10), // 50 MB
  MAX_ZIP_FILES: parseInt(process.env.MAX_ZIP_FILES || "500", 10),
  MAX_COMPRESSION_RATIO: parseInt(process.env.MAX_COMPRESSION_RATIO || "100", 10),
  MAX_HTTP_RESPONSE_SIZE: parseInt(process.env.MAX_HTTP_RESPONSE_SIZE || "5242880", 10), // 5 MB
  HTTP_TIMEOUT_MS: parseInt(process.env.HTTP_TIMEOUT_MS || "6000", 10),
  BROWSER_TIMEOUT_MS: parseInt(process.env.BROWSER_TIMEOUT_MS || "8000", 10),
  MAX_REDIRECTS: parseInt(process.env.MAX_REDIRECTS || "3", 10),
  MAX_AI_RETRIES: parseInt(process.env.MAX_AI_RETRIES || "2", 10),
  MAX_AI_CALLS_PER_AUDIT: parseInt(process.env.MAX_AI_CALLS_PER_AUDIT || "5", 10),
  JOB_RETRY_LIMIT: parseInt(process.env.JOB_RETRY_LIMIT || "3", 10),
  JOB_TIMEOUT_MS: parseInt(process.env.JOB_TIMEOUT_MS || "120000", 10), // 2 minutes
  JOB_POLL_INTERVAL_MS: parseInt(process.env.JOB_POLL_INTERVAL_MS || "2000", 10),
});
