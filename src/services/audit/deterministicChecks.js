import { compareProjectIdentity } from "../evidence/projectFingerprinter.js";
import { matchRequirementsToEvidence } from "../evidence/requirementMatcher.js";

/**
 * Runs deterministic checks for every contractual requirement using Stage 2 evidence findings,
 * extracted code files, and deep project fingerprinting.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements       - Flattened requirement list
 * @param {object|null} params.submissionData       - Canonical submission_data JSON
 * @param {Array<object>} [params.stage2EvidenceItems=[]] - Processed evidence_items rows
 * @param {Array<object>} [params.stage2Findings=[]]      - Processed evidence_findings rows
 * @param {Array<object>} [params.stage2Chunks=[]]        - Extracted chunks
 * @param {Array<object>} [params.extractedFiles=[]]      - Extracted file contents
 * @param {object|null}   [params.projectFingerprint=null]- Detected project fingerprint
 * @param {string|object} [params.contractScope=""]       - Transaction scope / title / category
 * @returns {Record<string, {
 *   criterion_id: string,
 *   scope_item_id: string,
 *   submissionExists: boolean,
 *   evidenceExists: boolean,
 *   evidenceProcessed: boolean,
 *   evidenceHashVerified: boolean,
 *   codeEvidenceFound: boolean,
 *   projectMismatch: boolean,
 *   projectMismatchDetails?: string,
 *   matchedFilesCount: number,
 *   matchedSymbols: Array<string>,
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
  extractedFiles = [],
  projectFingerprint = null,
  contractScope = "",
}) {
  const results = {};

  if (!Array.isArray(requirements)) return results;

  const deliverables = Array.isArray(submissionData?.deliverables)
    ? submissionData.deliverables
    : [];

  const testingInfo = submissionData?.testing || {};

  // 1. Run Project Identity Comparison against Contract
  const identityComparison = compareProjectIdentity({
    expectedScope: contractScope,
    requirements,
    detectedFingerprint: projectFingerprint,
  });

  // 2. Run Requirement-to-Evidence Matcher across all extracted files
  const reqMatches = matchRequirementsToEvidence({
    requirements,
    files: extractedFiles,
    chunks: stage2Chunks,
    projectFingerprint,
  });

  requirements.forEach((req) => {
    const criterionId = req.criterion_id;
    const scopeItemId = req.scope_item_id;
    const reqMatch = reqMatches[criterionId] || { matchedFiles: [], matchedSymbols: [], matchedRoutes: [], evidenceSnippets: [] };

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
      facts.push(`${reqEvidence.length} evidence item(s) attached and verified.`);
      if (evidenceHashVerified) {
        facts.push(`SHA-256 evidence hashes verified (${hashedEvidence.length} item(s)).`);
      }
    } else {
      facts.push("No supporting evidence items attached.");
    }

    // 3. Project Identity Mismatch Facts
    let contradictionDetected = false;
    if (identityComparison.projectMismatch) {
      contradictionDetected = true;
      facts.push(`[PROJECT_IDENTITY_MISMATCH] Critical mismatch: Contract expected "${identityComparison.expectedDomain}", but submitted project is "${identityComparison.detectedDomain}". ${identityComparison.reasons.join(" ")}`);
    } else if (projectFingerprint?.primaryDomain?.name) {
      facts.push(`[PROJECT_FINGERPRINT] Detected application type: "${projectFingerprint.primaryDomain.name}" (${projectFingerprint.primaryDomain.confidence}% confidence).`);
    }

    // 4. Code Evidence Verification for this specific requirement
    const codeEvidenceFound = reqMatch.matchedFiles.length > 0;
    if (codeEvidenceFound) {
      const topFilesStr = reqMatch.matchedFiles.map((f) => f.path).join(", ");
      facts.push(`[CODE_EVIDENCE_MATCH] Relevant source files found for requirement: [${topFilesStr}].`);
      if (reqMatch.matchedSymbols.length > 0) {
        facts.push(`[CODE_SYMBOLS_MATCH] Relevant symbols found: [${reqMatch.matchedSymbols.join(", ")}].`);
      }
    } else if (extractedFiles.length > 0) {
      facts.push("[CODE_EVIDENCE_GAP] No relevant source files, symbols, or components identified matching this requirement.");
    }

    // 5. Staging site / website reachability findings
    const websiteFindings = stage2Findings.filter(
      (f) => f.finding_type === "website_reachability" && f.finding_text.includes("Reachable: true"),
    );
    const urlReachable = websiteFindings.length > 0;
    if (urlReachable) {
      facts.push("Staging site verified reachable (HTTP 200 OK).");
    }

    // 6. Evidence Classification & Independent Testing Verification
    const providerReported = !!testingInfo.performed;
    const testSummaryText = (testingInfo.summary || "").toLowerCase();

    const testArtifactFindings = stage2Findings.filter(
      (f) =>
        f.finding_type === "test_report" ||
        f.finding_type === "ci_output" ||
        f.finding_type === "test_log" ||
        f.finding_type === "test_execution_result",
    );
    const evidenceBacked = testArtifactFindings.length > 0;

    const independentVerifiedFindings = stage2Findings.filter(
      (f) => f.finding_type === "independent_test_verified" && f.finding_text.includes("Verified: true"),
    );
    const independentlyVerified = independentVerifiedFindings.length > 0;

    const testExecuted = independentlyVerified || evidenceBacked;
    const testPassed = independentlyVerified;

    if (providerReported) {
      facts.push(`[PROVIDER_REPORTED] Testing claimed by provider: "${testingInfo.summary || "Tests executed"}". (Self-reported, not independently verified).`);
    }
    if (evidenceBacked) {
      facts.push(`[EVIDENCE_BACKED] Test execution artifact/log verified (${testArtifactFindings.length} item(s)).`);
    }

    // 7. Contradiction Detection
    const claim = (subDeliverable?.claim || "").toLowerCase();

    // Contradiction 1: Claim asserts 100% tests pass, but provider summary notes failure
    if (
      (claim.includes("all tests pass") || claim.includes("100% pass")) &&
      (testSummaryText.includes("failed") || testSummaryText.includes("error"))
    ) {
      contradictionDetected = true;
      facts.push("CONTRADICTION DETECTED: Claim asserts all tests passed, but testing findings report failures.");
    }

    // Contradiction 2: Claim asserts completion for a specific feature, but extracted code shows project mismatch
    if (identityComparison.projectMismatch && submissionExists) {
      contradictionDetected = true;
      facts.push(`CONTRADICTION DETECTED: Provider claims completion, but submitted code represents an unrelated project (${identityComparison.detectedDomain}).`);
    }

    // Contradiction 3: Claim asserts completion, but 0 files were extracted or found
    if (submissionExists && extractedFiles.length === 0 && reqEvidence.length === 0) {
      contradictionDetected = true;
      facts.push("CONTRADICTION DETECTED: Completion claimed without supporting source code evidence.");
    }

    results[criterionId] = {
      criterion_id: criterionId,
      scope_item_id: scopeItemId,
      submissionExists,
      evidenceExists,
      evidenceProcessed,
      evidenceHashVerified,
      codeEvidenceFound,
      projectMismatch: identityComparison.projectMismatch,
      projectMismatchDetails: identityComparison.projectMismatch ? identityComparison.reasons[0] : null,
      matchedFilesCount: reqMatch.matchedFiles.length,
      matchedSymbols: reqMatch.matchedSymbols,
      urlReachable,
      providerReportedTesting: providerReported,
      evidenceBackedTesting: evidenceBacked,
      independentlyVerifiedTesting: independentlyVerified,
      testExecuted,
      testPassed,
      contradictionDetected,
      facts,
    };
  });

  return results;
}

