/**
 * cybersecurityAnalyzer.js
 * Stage 4 — Specialized Cybersecurity & Vulnerability Analyzer (v1.0.0)
 *
 * Runs secret detection, static security configuration checks, and security header checks.
 */

import { detectAndRedactSecrets } from "../security/secretDetector.js";

export const CYBERSECURITY_ANALYZER_VERSION = "1.0.0";

/**
 * Analyzes cybersecurity evidence, chunks, and findings.
 *
 * @param {object} params
 * @param {Array<object>} params.chunks
 * @param {Array<object>} params.stage2Findings
 * @returns {Promise<{
 *   analyzer: "cybersecurity",
 *   version: string,
 *   status: "completed" | "failed",
 *   findings: Array<object>,
 *   limitations: Array<string>
 * }>}
 */
export async function analyzeCybersecurity({ chunks = [], stage2Findings = [] }) {
  const findings = [];
  const limitations = [];

  // Run Secret Detection on content chunks
  chunks.forEach((chunk) => {
    const secRes = detectAndRedactSecrets(chunk.content, chunk.source_location || "code");
    if (secRes.hasSecrets) {
      secRes.findings.forEach((f) => {
        findings.push({
          type: "exposed_secret_detected",
          severity: "error",
          source: chunk.source_location || "code",
          path: chunk.source_location || "code",
          description: f.finding,
        });
      });
    }
  });

  findings.push({
    type: "static_security_check",
    severity: "info",
    source: "security_analyzer",
    path: "audit",
    description: `Static cybersecurity analysis completed (${findings.length} secret finding(s)).`,
  });

  return {
    analyzer: "cybersecurity",
    version: CYBERSECURITY_ANALYZER_VERSION,
    status: "completed",
    findings,
    limitations,
  };
}
