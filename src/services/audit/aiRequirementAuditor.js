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
});

const GROQ_MODEL = process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "groq/compound-mini") : "dummy";

const VALID_REQUIREMENT_STATUSES = Object.freeze([
  "passed",
  "passed_with_notes",
  "revision_required",
  "failed",
  "insufficient_evidence",
  "not_applicable",
]);

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
 * Smart deterministic fallback audit used when no Groq API key is configured.
 *
 * Uses the pre-computed deterministicChecks facts per requirement to assign
 * a meaningful status and score — giving fair partial credit for submitted evidence.
 *
 * Scoring tiers:
 *   evidenceProcessed + submissionExists + urlReachable → passed_with_notes (score: 78)
 *   evidenceProcessed + submissionExists                → passed_with_notes (score: 72)
 *   evidenceExists + submissionExists (not processed)   → revision_required (score: 52)
 *   submissionExists only (no evidence)                 → revision_required (score: 38)
 *   nothing submitted, contradiction detected           → revision_required (score: 28)
 *   nothing at all                                      → insufficient_evidence (score: 18)
 */
export function deterministicFallbackAudit(requirements, deterministicChecks = {}) {
  return requirements.map((req) => {
    const checks = deterministicChecks[req.criterion_id] || {};
    const facts = checks.facts || [];

    const submissionExists   = !!checks.submissionExists;
    const evidenceExists     = !!checks.evidenceExists;
    const evidenceProcessed  = !!checks.evidenceProcessed;
    const urlReachable       = !!checks.urlReachable;
    const contradictionDetected = !!checks.contradictionDetected;

    let status, score, reason, verified = [], notVerified = [];

    if (contradictionDetected) {
      status = "revision_required";
      score  = 28;
      reason = `Contradiction detected between provider claim and submitted evidence findings. ${facts.find(f => f.includes("CONTRADICTION")) || ""}`;
      notVerified.push(req.requirement);
    } else if (evidenceProcessed && submissionExists) {
      status = "passed_with_notes";
      score  = urlReachable ? 78 : 72;
      reason = `Provider submitted deliverable and evidence was successfully verified.${urlReachable ? " Staging site confirmed reachable." : ""}`;
      verified.push("Submission received", "Evidence verified");
      if (urlReachable) verified.push("Staging site reachable");
      notVerified.push("Manual inspection recommended");
    } else if (evidenceExists && submissionExists) {
      status = "revision_required";
      score  = 52;
      reason = `Provider submitted a deliverable and evidence was found, but additional verification details are required.`;
      verified.push("Submission received", "Evidence attached");
      notVerified.push("Evidence inspection incomplete");
    } else if (submissionExists) {
      status = "revision_required";
      score  = 38;
      reason = `Provider submitted a deliverable for this requirement but did not attach supporting evidence files or URLs. Evidence is required for audit verification.`;
      verified.push("Submission received");
      notVerified.push("Supporting evidence (files/URLs) missing");
    } else {
      status = "insufficient_evidence";
      score  = 18;
      reason = `No provider submission or evidence found for this requirement. The provider must submit deliverables and attach supporting evidence.`;
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
      evidenceUsed: [],
      reason,
      limitations: ["Automated evidence verification applied."],
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
      score: 50,
      verified: [],
      notVerified: [req.requirement],
      evidenceUsed: [],
      reason: `Requirement "${req.requirement}" was not evaluated in primary LLM response. Auto-repaired for 100% coverage.`,
      limitations: ["Coverage auto-repair applied"],
    };
  });

  return finalCoverage;
}

/**
 * Runs AI requirement-by-requirement audit using Groq.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements
 * @param {object|null} params.submissionData
 * @param {Record<string, object>} params.deterministicChecks
 * @param {Array<object>} params.stage2Findings
 * @returns {Promise<Array<object>>} Requirement audit results
 */
export async function auditRequirementsWithAi({
  requirements,
  submissionData,
  deterministicChecks,
  stage2Findings = [],
  stage2Chunks = [],
}) {
  if (!requirements || requirements.length === 0) return [];

  // Group Stage 2 findings by scope_item_id + accumulate global findings
  const globalFindings = [];
  const findingsByScope = {};

  stage2Findings.forEach((f) => {
    const findingStr = `${f.location || "finding"}: ${f.finding_text}`;
    const fType = f.finding_type || "";

    // Project-wide findings (ZIP summaries, file lists, repo summaries, website reachability) apply to all requirements
    if (
      !f.scope_item_id ||
      fType.startsWith("zip_") ||
      fType.startsWith("repo_") ||
      fType.startsWith("website_") ||
      fType.startsWith("doc_")
    ) {
      globalFindings.push(findingStr);
    } else {
      const key = f.scope_item_id;
      if (!findingsByScope[key]) findingsByScope[key] = [];
      findingsByScope[key].push(findingStr);
    }
  });

  // Separate extracted source code chunks from ZIP archives vs documentation / notes
  const zipExtractedCode = (stage2Chunks || [])
    .filter((c) => {
      const loc = (c.source_location || "").toLowerCase();
      const st = (c.source_type || "").toLowerCase();
      const isZip = loc.includes(".zip") || st === "zip_entry" || st === "repository";
      const isLock = loc.includes("lock") || loc.includes(".min.");
      return isZip && !isLock;
    })
    .slice(0, 12)
    .map((c) => ({
      file: c.source_location || "archive_file",
      content_sample: (c.content || c.chunk_text || "").slice(0, 400).replace(/\s+/g, " "),
    }));

  const documentationNotes = (stage2Chunks || [])
    .filter((c) => {
      const loc = (c.source_location || "").toLowerCase();
      const st = (c.source_type || "").toLowerCase();
      const isZip = loc.includes(".zip") || st === "zip_entry" || st === "repository";
      return !isZip;
    })
    .slice(0, 5)
    .map((c) => ({
      document_source: c.source_location || c.evidence_id || "notes",
      text_sample: (c.content || c.chunk_text || "").slice(0, 400).replace(/\s+/g, " "),
    }));

  const deliverables = Array.isArray(submissionData?.deliverables)
    ? submissionData.deliverables
    : [];

  // Construct structured audit dataset for prompt without duplicating large code blocks per item
  const auditItems = requirements.map((req) => {
    const sub = deliverables.find(
      (d) => d && (d.scope_item_id === req.scope_item_id || d.id === req.scope_item_id),
    );
    const checks = deterministicChecks[req.criterion_id] || {};

    return {
      criterion_id: req.criterion_id,
      scope_item_id: req.scope_item_id,
      scope_name: req.scope_name,
      requirement: req.requirement,
      required: req.required,
      critical: req.critical,
      provider_claim: (sub?.claim || "No claim provided").slice(0, 300),
      deterministic_facts: (checks.facts || []).slice(0, 8),
    };
  });

  const payloadForModel = {
    server_verified_zip_files_and_source_code: zipExtractedCode,
    provider_written_explanation_and_notes: documentationNotes,
    global_evidence_findings: globalFindings.slice(0, 10),
    requirements_to_audit: auditItems,
  };

  if (!process.env.GROQ_API_KEY) {
    console.warn("[aiRequirementAuditor] GROQ_API_KEY missing; using deterministic fallback audit.");
    return deterministicFallbackAudit(requirements, deterministicChecks);
  }

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 1800,
      messages: [
        {
          role: "system",
          content: `You are Escrow's AI Requirement Auditor. Your job is to compare contractual requirements against provider submissions and verified evidence. Do not include internal terms like Stage 2, deterministic mode, or API keys in reasons.

## EVIDENCE SOURCES:
1. **server_verified_zip_files_and_code**: Physical source files extracted from inside the submitted ZIP archive (React components, App.jsx, index.html, package.json, styles, etc.). Compare this code against the contractual requirements.
2. **deterministic_facts**:
   - \`[ZIP_VERIFIED]\`: Server confirmation of files inside the ZIP archive, file count, and structure.
   - \`[ZIP_CONTENT]\`: Key snippets extracted directly from files inside the ZIP archive.
3. **provider_written_explanation_and_notes**: The provider's written explanation, setup notes, and architecture overview.
4. **provider_claim**: The claim text submitted by the provider.

## AUDIT EVALUATION RULES:
1. **ZIP Implementation Archive**:
   - Inspect \`server_verified_zip_files_and_code\` and \`deterministic_facts\`.
   - If source code files (.jsx, .js, .tsx, .html, .css, package.json, README) are present, verify that runnable artifacts and source code have been delivered and award passing status (passed or passed_with_notes, score 80-95).
2. **Project Summary & Implementation Notes**:
   - Inspect \`provider_written_explanation_and_notes\`.
   - If provider provided project overview and setup explanation, evaluate completeness and mark as passed / passed_with_notes.
3. **Specific Feature Requirements (e.g. Tabs, Client-Side State, React UI)**:
   - Check the code logic inside \`server_verified_zip_files_and_code\` to verify if the requested features (e.g. All/Active/Completed filters, state hooks) are implemented in the code.
4. Return ONLY valid JSON matching the schema below:

{
  "requirements": [
    {
      "criterion_id": "d1_ac1",
      "scope_item_id": "d1",
      "status": "passed",
      "confidence": 90,
      "score": 90,
      "verified": ["ZIP archive inspected: source code and runnable artifacts verified"],
      "notVerified": [],
      "evidenceUsed": ["zip_archive"],
      "reason": "ZIP archive was server-verified and contains the complete project source code and implementation files.",
      "limitations": []
    }
  ]
}`,
        },
        {
          role: "user",
          content: `AUDIT THESE REQUIREMENTS AGAINST THE SUBMITTED EVIDENCE AND EXTRACTED ZIP CODE:

AUDIT DATASET:
${JSON.stringify(payloadForModel, null, 2)}`,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content || "";
    if (!text.trim()) {
      console.warn("[aiRequirementAuditor] Empty response from Groq; using deterministic fallback.");
      return deterministicFallbackAudit(requirements, deterministicChecks);
    }

    // Strip <think>...</think> reasoning blocks (for reasoning models like qwen)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Strip markdown code fences
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    // Extract first JSON object/array if extra text wraps it
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
