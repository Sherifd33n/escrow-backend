/**
 * aiRequirementAuditor.js
 * Stage 3 — AI Requirement-by-Requirement Reasoning & Coverage Engine
 *
 * Prompts Groq LLM to reason over concrete Stage 2 facts & deterministic checks
 * per requirement. Validates AI response against strict schema and enforces 100%
 * requirement coverage (detecting and auto-repairing missing criterion IDs).
 */

import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_groq_key",
  baseURL: "https://api.groq.com/openai/v1",
  timeout: 15000,
  maxRetries: 0,
});

const GROQ_MODEL = process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b") : "dummy";

const VALID_REQUIREMENT_STATUSES = Object.freeze([
  "passed",
  "passed_with_notes",
  "revision_required",
  "failed",
  "insufficient_evidence",
  "not_applicable",
]);

import { matchRequirementsToEvidence } from "../evidence/requirementMatcher.js";

/**
 * Validates a single requirement audit result object against the strict Stage 3 schema.
 *
 * @param {object} res
 * @returns {boolean} True if valid
 */
export function validateRequirementResult(res) {
  if (!res || typeof res !== "object") return false;
  if (!res.criterion_id || typeof res.criterion_id !== "string") return false;
  if (!res.status || !VALID_REQUIREMENT_STATUSES.includes(res.status)) return false;
  if (typeof res.score !== "number" || res.score < 0 || res.score > 100) return false;
  if (typeof res.confidence !== "number" || res.confidence < 0 || res.confidence > 100) return false;
  if (!res.reason || typeof res.reason !== "string") return false;
  return true;
}

/**
 * Deterministic fallback audit used when no Groq API key is configured or AI service is unavailable.
 * Strictly adheres to evidence presence and project identity rules.
 *
 * NEVER produces an automatic passing verdict without concrete matching code evidence.
 */
export function deterministicFallbackAudit(requirements, deterministicChecks = {}) {
  return requirements.map((req) => {
    const checks = deterministicChecks[req.criterion_id] || {};
    const facts = checks.facts || [];

    const submissionExists = !!checks.submissionExists;
    const evidenceProcessed = !!checks.evidenceProcessed;
    const codeEvidenceFound = !!checks.codeEvidenceFound;
    const projectMismatch = !!checks.projectMismatch;
    const contradictionDetected = !!checks.contradictionDetected;
    const urlReachable = !!checks.urlReachable;

    let status = "insufficient_evidence";
    let score = 20;
    let reason = "";
    const verified = [];
    const notVerified = [];
    const evidenceUsed = [];

    if (projectMismatch) {
      status = "failed";
      score = 15;
      reason = `Project Identity Mismatch: Submitted archive does not correspond to the contracted project requirements. ${checks.projectMismatchDetails || ""}`.trim();
      notVerified.push(req.requirement);
    } else if (contradictionDetected) {
      status = "revision_required";
      score = 25;
      reason = `Contradiction detected: ${facts.find((f) => f.includes("CONTRADICTION")) || "Provider claim contradicts submitted code evidence."}`;
      notVerified.push(req.requirement);
    } else if (codeEvidenceFound && evidenceProcessed && submissionExists) {
      status = "passed";
      score = urlReachable ? 92 : 86;
      reason = `Verified: Substantial source code implementation matching "${req.requirement}" was confirmed in submitted files.`;
      verified.push(`Code implementation verified (${checks.matchedFilesCount || 1} relevant file(s))`);
      if (urlReachable) verified.push("Staging environment reachable");
      evidenceUsed.push("submitted_source_code");
    } else if (evidenceProcessed && submissionExists) {
      status = "insufficient_evidence";
      score = 35;
      reason = `Archive was processed, but no source code components, routes, or symbols matching "${req.requirement}" were identified.`;
      notVerified.push(req.requirement);
      evidenceUsed.push("processed_archive");
    } else if (submissionExists) {
      status = "insufficient_evidence";
      score = 25;
      reason = `Provider submitted a deliverable description for "${req.requirement}" but did not provide inspectable source code evidence.`;
      notVerified.push(req.requirement);
    } else {
      status = "insufficient_evidence";
      score = 15;
      reason = `No provider submission or supporting code evidence was found for "${req.requirement}".`;
      notVerified.push(req.requirement);
    }

    return {
      criterion_id: req.criterion_id,
      scope_item_id: req.scope_item_id,
      requirement: req.requirement,
      status,
      confidence: 85,
      score,
      verified,
      notVerified,
      evidenceUsed,
      reason,
      limitations: ["Deterministic static verification applied."],
    };
  });
}

/**
 * Guarantees 100% requirement coverage by auto-repairing any missing criteria.
 *
 * @param {Array<object>} requirements - Original Flattened requirement list
 * @param {Array<object>} auditedResults - AI output requirement results
 * @returns {Array<object>} Complete requirement audit list (100% coverage)
 */
export function ensureCompleteCoverage(requirements, auditedResults = []) {
  if (!Array.isArray(requirements)) return [];

  const auditedMap = {};
  auditedResults.forEach((res) => {
    if (res && res.criterion_id && validateRequirementResult(res)) {
      auditedMap[res.criterion_id] = res;
    }
  });

  const finalCoverage = requirements.map((req) => {
    const existing = auditedMap[req.criterion_id];
    if (existing) return existing;

    // Auto-repair missing criterion ID with fallback insufficient_evidence
    return {
      criterion_id: req.criterion_id,
      scope_item_id: req.scope_item_id,
      requirement: req.requirement,
      status: "insufficient_evidence",
      confidence: 70,
      score: 30,
      verified: [],
      notVerified: [req.requirement],
      evidenceUsed: [],
      reason: `Requirement "${req.requirement}" was not evaluated in primary LLM response. Auto-repaired as insufficient evidence.`,
      limitations: ["Coverage auto-repair applied"],
    };
  });

  return finalCoverage;
}

/**
 * Runs AI requirement-by-requirement audit using Groq with deep evidence provenance.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements
 * @param {object|null} params.submissionData
 * @param {Record<string, object>} params.deterministicChecks
 * @param {Array<object>} [params.stage2Findings=[]]
 * @param {Array<object>} [params.stage2Chunks=[]]
 * @param {Array<object>} [params.extractedFiles=[]]
 * @param {object|null}   [params.projectFingerprint=null]
 * @param {string|object} [params.contractScope=""]
 * @returns {Promise<Array<object>>} Requirement audit results
 */
export async function auditRequirementsWithAi({
  requirements,
  submissionData,
  deterministicChecks,
  stage2Findings = [],
  stage2Chunks = [],
  extractedFiles = [],
  projectFingerprint = null,
  contractScope = "",
}) {
  if (!requirements || requirements.length === 0) return [];

  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === "dummy_groq_key") {
    console.warn("[aiRequirementAuditor] GROQ_API_KEY missing; using deterministic fallback audit.");
    return deterministicFallbackAudit(requirements, deterministicChecks);
  }

  // Map each requirement to its most relevant extracted code snippets
  const reqMatches = matchRequirementsToEvidence({
    requirements,
    files: extractedFiles,
    chunks: stage2Chunks,
    projectFingerprint,
  });

  const deliverables = Array.isArray(submissionData?.deliverables)
    ? submissionData.deliverables
    : [];

  const overallNotes =
    submissionData?.provider_notes ||
    submissionData?.summary ||
    submissionData?.deliverable_note ||
    "";

  const auditItems = requirements.map((req) => {
    const sub = deliverables.find(
      (d) => d && (d.scope_item_id === req.scope_item_id || d.id === req.scope_item_id),
    );
    const checks = deterministicChecks[req.criterion_id] || {};
    const matchData = reqMatches[req.criterion_id] || { matchedFiles: [], matchedSymbols: [], evidenceSnippets: [] };

    const claim =
      sub?.claim ||
      overallNotes ||
      "Milestone source code and deliverable archive submitted.";

    return {
      criterion_id: req.criterion_id,
      scope_item_id: req.scope_item_id,
      scope_name: req.scope_name,
      requirement: req.requirement,
      required: req.required,
      critical: req.critical,
      provider_claim: claim.slice(0, 300),
      deterministic_facts: checks.facts || [],
      relevant_source_files: matchData.matchedFiles.map((f) => f.path),
      relevant_symbols: matchData.matchedSymbols,
      relevant_code_snippets: matchData.evidenceSnippets,
    };
  });

  const payloadForModel = {
    contract_scope_summary: typeof contractScope === "string" ? contractScope : JSON.stringify(contractScope),
    project_fingerprint: projectFingerprint
      ? {
          detected_application: projectFingerprint.primaryDomain.name,
          confidence: projectFingerprint.primaryDomain.confidence,
          technologies: projectFingerprint.technologies,
          routes_sample: (projectFingerprint.routes || []).slice(0, 15),
          has_auth: projectFingerprint.hasAuthentication,
          has_tests: projectFingerprint.hasTests,
        }
      : "No fingerprint available",
    requirements_to_audit: auditItems,
  };

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 2200,
      messages: [
        {
          role: "system",
          content: `You are Escrow's Production Deep AI Evidence Auditor.
Your duty is to conduct a rigorous, evidence-proven audit of submitted deliverables against contractual requirements.

## CORE AUDIT PRINCIPLES:
1. **NEVER equate file existence with functionality**. A file named \`Cart.jsx\` or \`Login.js\` is NOT proof that cart or auth works. You must inspect the actual code snippet.
2. **NEVER equate successful ZIP extraction with contract delivery**. Processing a ZIP merely means it was uncompressed; it does not mean the contracted work was delivered.
3. **NEVER trust provider claims over code evidence**. If the provider claims "E-commerce store completed" but the project fingerprint and code show a Calculator or Todo app, detect PROJECT IDENTITY MISMATCH and mark requirements as \`failed\` / \`not_verified\`.
4. **DO NOT INVENT OR HALLUCINATE EVIDENCE**. Only cite files and functionality that appear in \`relevant_source_files\` or \`relevant_code_snippets\`.
5. **EVIDENCE PROVENANCE IS MANDATORY**. For every requirement, populate \`evidenceUsed\` with the exact file path(s) used to reach your conclusion.
6. **VALID STATUS VOCABULARY**:
   - \`passed\`: Requirement is clearly implemented and evidenced in the source code.
   - \`passed_with_notes\`: Substantially implemented with minor non-critical caveats.
   - \`revision_required\`: Partially implemented or major feature missing / needs fixes.
   - \`failed\`: Contradicted, major project mismatch, or false submission.
   - \`insufficient_evidence\`: No readable source code or evidence found for this requirement.
   - \`not_applicable\`: Requirement does not apply to this milestone.

## OUTPUT FORMAT (JSON ONLY):
{
  "requirements": [
    {
      "criterion_id": "string",
      "scope_item_id": "string",
      "status": "passed | passed_with_notes | revision_required | failed | insufficient_evidence | not_applicable",
      "confidence": 0-100,
      "score": 0-100,
      "verified": ["specific capabilities verified in code"],
      "notVerified": ["specific capabilities missing or unverified"],
      "evidenceUsed": ["src/components/Cart.jsx", "src/pages/Checkout.jsx"],
      "reason": "Clear explanation citing the concrete code evidence or specific missing capabilities."
    }
  ]
}`,
        },
        {
          role: "user",
          content: `AUDIT THESE REQUIREMENTS AGAINST THE SUBMITTED EVIDENCE, PROJECT FINGERPRINT, AND EXTRACTED CODE:

${JSON.stringify(payloadForModel, null, 2)}`,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content || "";
    if (!text.trim()) {
      console.warn("[aiRequirementAuditor] Empty response from Groq; using deterministic fallback.");
      return deterministicFallbackAudit(requirements, deterministicChecks);
    }

    // Strip reasoning blocks and markdown code blocks
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const parsed = JSON.parse(cleaned);
    const auditedList = Array.isArray(parsed.requirements) ? parsed.requirements : [];

    return ensureCompleteCoverage(requirements, auditedList);
  } catch (err) {
    console.warn("[aiRequirementAuditor] Groq requirement audit warning:", err.message);
    return deterministicFallbackAudit(requirements, deterministicChecks);
  }
}

