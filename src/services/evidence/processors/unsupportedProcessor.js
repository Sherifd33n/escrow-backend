/**
 * unsupportedProcessor.js
 * Stage 2 — Unsupported Evidence Processor Fallback
 *
 * Handles unknown or unsupported evidence types gracefully without pretending
 * the evidence was inspected or turning it into a provider failure.
 */

/**
 * Process unsupported evidence types.
 *
 * @param {object} params
 * @param {string} params.evidenceId
 * @param {string} params.evidenceType
 * @param {string} [params.label="Evidence"]
 * @returns {Promise<{
 *   type: string,
 *   status: "unsupported",
 *   findings: Array<object>,
 *   chunks: Array<object>
 * }>}
 */
export async function processUnsupported({ evidenceId, evidenceType = "unknown", label = "Evidence" }) {
  return {
    type: evidenceType,
    status: "unsupported",
    findings: [
      {
        type: "evidence_unsupported",
        location: label,
        finding: `Evidence type "${evidenceType}" is not currently supported for automated content extraction. Metadata recorded.`,
      },
    ],
    chunks: [],
  };
}
