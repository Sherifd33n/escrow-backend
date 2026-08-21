/**
 * deterministicChecks.js
 * Stage 3 — Deterministic Objective Checks Layer
 *
 * Performs objective backend checks per requirement before calling the AI:
 *   - submissionExists
 *   - evidenceExists
 *   - evidenceProcessed
 *   - evidenceHashVerified
 *   - urlReachable
 *   - testExecuted & testPassed
 *   - contradictionDetected (mismatch between claims vs Stage 2 facts)
 *
 * Produces deterministic facts to feed the AI prompt & final policy engine.
 */

/**
 * Runs deterministic checks for every contractual requirement using Stage 2 evidence findings.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements       - Flattened requirement list
 * @param {object|null} params.submissionData       - Phase 1 canonical submission_data JSON
 * @param {Array<object>} params.stage2EvidenceItems - Processed evidence_items rows
 * @param {Array<object>} params.stage2Findings      - Processed evidence_findings rows
 * @returns {Record<string, {
 *   criterion_id: string,
 *   scope_item_id: string,
 *   submissionExists: boolean,
 *   evidenceExists: boolean,
 *   evidenceProcessed: boolean,
 *   evidenceHashVerified: boolean,
 *   urlReachable: boolean,
 *   testExecuted: boolean,
 *   testPassed: boolean,
 *   contradictionDetected: boolean,
 *   facts: Array<string>
 * }>} Map of criterion_id -> deterministic checks result
 */
export function runDeterministicChecks({
  requirements,
  submissionData,
  stage2EvidenceItems = [],
  stage2Findings = [],
  stage2Chunks = [],
}) {
  const results = {};

  if (!Array.isArray(requirements)) return results;

  const deliverables = Array.isArray(submissionData?.deliverables)
    ? submissionData.deliverables
    : [];

  const testingInfo = submissionData?.testing || {};

  requirements.forEach((req) => {
    const criterionId = req.criterion_id;
    const scopeItemId = req.scope_item_id;

    const facts = [];

    // 1. Check if provider submitted a deliverable matching scope_item_id
    const subDeliverable = deliverables.find(
      (d) => d && (d.scope_item_id === scopeItemId || d.id === scopeItemId),
    );
    const submissionExists = !!subDeliverable;

    if (submissionExists) {
      facts.push(`Provider submitted deliverable for ${scopeItemId} (${subDeliverable.status || "completed"}).`);
    } else {
      facts.push(`No direct provider submission found for scope item ${scopeItemId}.`);
    }

    // 2. Check evidence linked to this scope item or submission
    // Project-wide evidence (ZIP archives, repositories, documentation) applies to ALL requirements
    const reqEvidence = stage2EvidenceItems.filter(
      (e) =>
        !e.scope_item_id ||
        e.scope_item_id === scopeItemId ||
        e.criterion_id === criterionId ||
        e.evidence_type === "zip" ||
        e.evidence_type === "repository" ||
        e.evidence_type === "documentation" ||
        (e.original_url && e.original_url.toLowerCase().endsWith(".zip")),
    );
    const evidenceExists = reqEvidence.length > 0;

    const processedEvidence = reqEvidence.filter((e) => e.processing_status === "processed");
    const evidenceProcessed = processedEvidence.length > 0;

    const hashedEvidence = reqEvidence.filter((e) => !!e.sha256_hash);
    const evidenceHashVerified = hashedEvidence.length > 0;

    if (evidenceExists) {
      facts.push(`${reqEvidence.length} evidence item(s) attached (${processedEvidence.length} successfully processed by Stage 2).`);
      if (evidenceHashVerified) {
        facts.push(`SHA-256 evidence hashes verified (${hashedEvidence.length} item(s)).`);
      }
    } else {
      facts.push("No supporting evidence items attached.");
    }

    // 3. Extract ZIP file tree and content facts from Stage 2 findings
    const zipSummaryFindings = stage2Findings.filter(
      (f) => f.finding_type === "zip_archive_summary" || f.finding_type === "zip_file_list" || f.finding_type === "zip_categorization",
    );
    if (zipSummaryFindings.length > 0) {
      zipSummaryFindings.forEach((f) => {
        facts.push(`[ZIP_VERIFIED] ${f.finding_text}`);
      });
    }

    // Add extracted text/code content from ZIP entries as facts (truncated for prompt safety)
    const zipChunks = stage2Chunks.filter(
      (c) => (c.source_location || "").includes(".zip") ||
             (c.source_type || "") === "zip_entry",
    );
    if (zipChunks.length > 0) {
      const snippetFacts = zipChunks.slice(0, 10).map(
        (c) => `[ZIP_CONTENT from ${c.source_location || "file"}]: ${(c.content || c.chunk_text || "").slice(0, 400)}`,
      );
      facts.push(...snippetFacts);
    }

    // 4. Check staging site / website reachability findings
    const websiteFindings = stage2Findings.filter(
      (f) => f.finding_type === "website_reachability" && f.finding_text.includes("Reachable: true"),
    );
    const urlReachable = websiteFindings.length > 0;
    if (urlReachable) {
      facts.push("Staging site verified reachable (HTTP 200 OK).");
    }

    // 5. Check test execution & test results
    const testExecuted = !!testingInfo.performed;
    const testSummaryText = (testingInfo.summary || "").toLowerCase();
    const testPassed =
      testExecuted &&
      !testSummaryText.includes("fail") &&
      !testSummaryText.includes("error") &&
      !testSummaryText.includes("0 test");

    if (testExecuted) {
      facts.push(`Testing performed by provider: "${testingInfo.summary || "Tests executed"}".`);
    }

    // 6. Contradiction Detection
    let contradictionDetected = false;
    const claim = (subDeliverable?.claim || "").toLowerCase();

    // Contradiction 1: Claim says 100% tests pass, but testing summary notes failure
    if (
      (claim.includes("all tests pass") || claim.includes("100% pass")) &&
      (testSummaryText.includes("failed") || testSummaryText.includes("error"))
    ) {
      contradictionDetected = true;
      facts.push("CONTRADICTION DETECTED: Claim asserts all tests passed, but testing findings report failures.");
    }

    // Contradiction 2: Claim asserts completion, but Stage 2 found security block or missing endpoint
    const blockedFindings = stage2Findings.filter(
      (f) => f.finding_type.includes("block") || f.finding_type.includes("error"),
    );
    if (submissionExists && blockedFindings.length > 0 && reqEvidence.length === 0) {
      contradictionDetected = true;
      facts.push("CONTRADICTION DETECTED: Completion claimed without supporting evidence.");
    }

    results[criterionId] = {
      criterion_id: criterionId,
      scope_item_id: scopeItemId,
      submissionExists,
      evidenceExists,
      evidenceProcessed,
      evidenceHashVerified,
      urlReachable,
      testExecuted,
      testPassed,
      contradictionDetected,
      facts,
    };
  });

  return results;
}
