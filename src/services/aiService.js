import db from "../config/db.js";
import { getUserEntitlements } from "./entitlementService.js";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "",
  baseURL: "https://api.groq.com/openai/v1",
});

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

console.log("Groq API key loaded:", process.env.GROQ_API_KEY ? "YES" : "NO");

/**
 * Safely extract JSON from an AI response.
 */
function parseJsonResponse(text) {
  if (!text) return null;

  let cleaned = text.trim();

  // Remove markdown code fences if the model adds them.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn("Failed to parse AI JSON response:", e.message);
    console.warn("Raw AI response:", text);
    return null;
  }
}

/**
 * Normalize scope_json into internal deliverable items with deterministic IDs.
 */
export function normalizeScope(scopeJson) {
  if (!scopeJson) return { deliverables: [] };

  let parsed = scopeJson;
  if (typeof scopeJson === "string") {
    try {
      parsed = JSON.parse(scopeJson);
    } catch (e) {
      return { deliverables: [] };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { deliverables: [] };
  }

  const deliverables = [];
  let itemIndex = 1;

  if (Array.isArray(parsed.deliverables) && parsed.deliverables.length > 0) {
    parsed.deliverables.forEach((item) => {
      if (typeof item === "string" && item.trim()) {
        deliverables.push({
          id: `d${itemIndex++}`,
          name: item.trim(),
          description: item.trim(),
          acceptance_criteria: Array.isArray(parsed.acceptance)
            ? parsed.acceptance
            : [],
        });
      } else if (typeof item === "object" && item !== null) {
        deliverables.push({
          id: item.scope_item_id || item.id || `d${itemIndex++}`,
          name:
            item.name ||
            item.title ||
            item.deliverable ||
            `Deliverable ${itemIndex}`,
          description: item.description || item.details || "",
          acceptance_criteria: Array.isArray(item.acceptance_criteria)
            ? item.acceptance_criteria
            : Array.isArray(parsed.acceptance)
              ? parsed.acceptance
              : [],
        });
      }
    });
  }

  if (
    deliverables.length === 0 &&
    Array.isArray(parsed.milestones) &&
    parsed.milestones.length > 0
  ) {
    parsed.milestones.forEach((m, mIdx) => {
      if (typeof m === "object" && m !== null) {
        const mDeliverables = Array.isArray(m.deliverables)
          ? m.deliverables
          : [];
        if (mDeliverables.length > 0) {
          mDeliverables.forEach((item) => {
            const nameStr =
              typeof item === "string" ? item : item.name || item.title || "";
            if (nameStr) {
              deliverables.push({
                id:
                  typeof item === "object" && (item.scope_item_id || item.id)
                    ? item.scope_item_id || item.id
                    : `d${itemIndex++}`,
                name: nameStr,
                description:
                  typeof item === "object" && item.description
                    ? item.description
                    : `Milestone: ${m.name || `Milestone ${mIdx + 1}`}`,
                acceptance_criteria: Array.isArray(parsed.acceptance)
                  ? parsed.acceptance
                  : [],
              });
            }
          });
        } else if (m.name || m.description) {
          deliverables.push({
            id: `d${itemIndex++}`,
            name: m.name || `Milestone ${mIdx + 1}`,
            description: m.description || "",
            acceptance_criteria: Array.isArray(parsed.acceptance)
              ? parsed.acceptance
              : [],
          });
        }
      }
    });
  }

  return { deliverables };
}

/**
 * Perform programmatic analysis of submission against scope before calling LLM.
 */
export function preAnalyzeSubmission(normalizedScope, submissionData) {
  const scopeItems = normalizedScope?.deliverables || [];
  const subDeliverables = Array.isArray(submissionData?.deliverables)
    ? submissionData.deliverables
    : [];

  let matchedCount = 0;
  let completedCount = 0;
  let partialCount = 0;
  let noEvidenceCount = 0;
  const itemAnalysis = [];

  scopeItems.forEach((scopeItem) => {
    // Primary match: scope_item_id
    let subItem = subDeliverables.find(
      (sd) => sd && sd.scope_item_id === scopeItem.id,
    );
    if (!subItem && scopeItem.name) {
      const lowerName = scopeItem.name.toLowerCase();
      subItem = subDeliverables.find(
        (sd) => sd && sd.claim && sd.claim.toLowerCase().includes(lowerName),
      );
    }

    const evidenceList = Array.isArray(subItem?.evidence)
      ? subItem.evidence
      : [];
    const hasEvidence = evidenceList.length > 0;
    const status = subItem?.status || (subItem ? "completed" : "missing");

    if (subItem) matchedCount++;
    if (status === "completed") completedCount++;
    if (status === "partial") partialCount++;
    if (!hasEvidence) noEvidenceCount++;

    itemAnalysis.push({
      scope_item_id: scopeItem.id,
      name: scopeItem.name,
      description: scopeItem.description,
      matched: !!subItem,
      status,
      claim: subItem?.claim || "No claim provided by provider.",
      has_evidence: hasEvidence,
      evidence_count: evidenceList.length,
      evidence_types: evidenceList.map(
        (e) => e.type || e.source_type || "other",
      ),
      evidence_items: evidenceList.map((e) => ({
        id: e.id,
        type: e.type,
        source_type: e.source_type,
        label: e.label,
        url: e.url,
        file_name: e.file_name,
        description: e.description,
      })),
    });
  });

  const additionalEvidence = Array.isArray(submissionData?.additional_evidence)
    ? submissionData.additional_evidence
    : [];

  const testingInfo = {
    performed: !!submissionData?.testing?.performed,
    summary: submissionData?.testing?.summary || "No testing summary provided.",
    evidence_count: Array.isArray(submissionData?.testing?.evidence)
      ? submissionData.testing.evidence.length
      : 0,
  };

  return {
    total_scope_items: scopeItems.length,
    matched_count: matchedCount,
    missing_count: scopeItems.length - matchedCount,
    completed_count: completedCount,
    partial_count: partialCount,
    no_evidence_count: noEvidenceCount,
    has_structured_data: !!submissionData,
    testing: testingInfo,
    additional_evidence_count: additionalEvidence.length,
    item_analysis: itemAnalysis,
  };
}

/**
 * Generate AI Project Scope server-side and record usage.
 */
export async function generateAiScope(userId, { categoryLabel, description }) {
  const entitlements = await getUserEntitlements(userId);

  // Scope generator entitlement check
  if (
    entitlements.effectiveLevel < 2 &&
    entitlements.subscription.status !== "active"
  ) {
    const error = new Error(
      "KYC Level 2 verification or active subscription required to use AI Scope Generator.",
    );

    error.statusCode = 403;
    error.code = "KYC_LEVEL_REQUIRED";

    throw error;
  }

  if (!process.env.GROQ_API_KEY) {
    const error = new Error("Groq API key is not configured on the server.");

    error.statusCode = 500;
    error.code = "GROQ_API_KEY_MISSING";

    throw error;
  }

  let scopeResult = null;

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,

      temperature: 0.2,

      messages: [
        {
          role: "system",
          content: `
You are Escrow's AI Scope Generator for technology and digital services.

Your job is to convert a client's project description into a clear,
professional, specific, measurable and verifiable project scope that
can be used as the basis of an escrow agreement.

The scope must be understandable to both the client and service provider.

IMPORTANT RULES:

1. Do not invent requirements that are not reasonably implied by the
   client's description.

2. Avoid vague deliverables such as "complete the project", "make it
   professional", or "ensure everything works".

3. Deliverables must describe concrete pieces of work that can later
   be checked during an AI deliverable audit. Each deliverable must include an explicit scope_item_id (e.g. "d1", "d2", "d3").

4. Acceptance criteria must be measurable and verifiable.

5. Milestones should represent logical stages of the project.

6. Make the scope realistic for the type of project described.

7. STRICT FINANCIAL & LEGAL CONSTRAINT: You MUST NOT invent any financial
   or contractual terms that were not explicitly provided in the user's brief.
   NEVER generate hourly rates (such as "$100/hr"), extra fees, late penalties,
   cancellation fees, or unexpected payment obligations.

8. REVISION POLICY CONSTRAINT: Use neutral, standard wording such as
   "2 rounds of minor revisions are included" or "Revision terms as agreed by client and provider".
   Do NOT add financial penalties or extra hourly rates to the revision policy.

9. TIMELINE CONSTRAINT: The "timeline" output field represents an AI estimate/suggestion
   (e.g., "8 weeks" or "3-4 weeks"), not a fixed contractual deadline.

10. Return ONLY valid JSON. Do not use markdown or code fences.

Return exactly this structure:

{
  "title": "short project title",
  "overview": "2-3 sentence project overview",
  "deliverables": [
    { "scope_item_id": "d1", "name": "specific deliverable 1", "description": "details" },
    { "scope_item_id": "d2", "name": "specific deliverable 2", "description": "details" },
    { "scope_item_id": "d3", "name": "specific deliverable 3", "description": "details" }
  ],
  "milestones": [
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 1-2"
    }
  ],
  "acceptance": [
    "measurable acceptance criterion 1",
    "measurable acceptance criterion 2"
  ],
  "timeline": "8 weeks",
  "revisions": "2 rounds of minor revisions"
}
          `,
        },
        {
          role: "user",
          content: `
Project category:
${categoryLabel}

Client project description:
${description}
          `,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content;

    scopeResult = parseJsonResponse(text);

    if (
      !scopeResult ||
      typeof scopeResult !== "object" ||
      !scopeResult.title ||
      !scopeResult.overview ||
      !Array.isArray(scopeResult.deliverables) ||
      !Array.isArray(scopeResult.milestones) ||
      !Array.isArray(scopeResult.acceptance) ||
      !scopeResult.timeline ||
      !scopeResult.revisions
    ) {
      throw new Error("Groq returned an invalid project scope structure.");
    }
  } catch (err) {
    console.error("Groq Scope Generator error:", err?.message || err);

    if (err.statusCode) throw err;

    const groqMsg = err?.error?.message || err?.message || "";
    if (
      groqMsg.toLowerCase().includes("invalid api key") ||
      groqMsg.toLowerCase().includes("authentication")
    ) {
      const authErr = new Error(
        "Groq API key is invalid or expired. Please contact support.",
      );
      authErr.statusCode = 503;
      authErr.code = "GROQ_AUTH_FAILED";
      throw authErr;
    }
    if (groqMsg.toLowerCase().includes("rate limit")) {
      const rateErr = new Error(
        "AI Scope Generator is rate-limited. Please try again in a moment.",
      );
      rateErr.statusCode = 503;
      rateErr.code = "GROQ_RATE_LIMIT";
      throw rateErr;
    }

    const error = new Error(
      groqMsg ||
        "AI Scope Generator is temporarily unavailable. Please try again.",
    );
    error.statusCode = 503;
    error.code = "AI_SCOPE_GENERATION_FAILED";
    throw error;
  }

  // Record AI usage
  await db.query(
    "INSERT INTO ai_usage (user_id, feature, metadata) VALUES (?, 'scope', ?)",
    [
      userId,
      JSON.stringify({
        categoryLabel,
        provider: "groq",
        model: GROQ_MODEL,
      }),
    ],
  );

  return scopeResult;
}

/**
 * Compact string sanitizer to truncate excessively long text fields while preserving content.
 */
function sanitizeText(str, maxLen = 300) {
  if (!str || typeof str !== "string") return "";
  const cleaned = str.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + "...";
}

/**
 * Run AI Deliverable Audit server-side with monthly quota check, persistence in ai_audits, & usage record.
 */
export async function runAiAudit(
  userId,
  {
    transactionId,
    milestoneId,
    submissionId,
    title,
    type,
    amount,
    currency,
    counterparty,
  },
) {
  const entitlements = await getUserEntitlements(userId);

  if (!entitlements.capabilities.canRunAiAudit) {
    const error = new Error(
      `Monthly AI audit quota exceeded for your ${entitlements.subscription.planName} plan.`,
    );

    error.statusCode = 403;
    error.code = "AI_QUOTA_EXCEEDED";
    error.aiAuditsPerMonth = entitlements.limits.aiAuditsPerMonth;
    error.aiAuditsUsed = entitlements.usage.aiAuditsUsedThisMonth;

    throw error;
  }

  if (!process.env.GROQ_API_KEY) {
    const error = new Error("Groq API key is not configured on the server.");

    error.statusCode = 500;
    error.code = "GROQ_API_KEY_MISSING";

    throw error;
  }

  let realTxId = null;
  let realMilestoneId = milestoneId || null;
  let realSubmissionId = submissionId || null;
  let activeSubRecord = null;
  let normalizedScopeObj = { deliverables: [] };
  let submissionDataObj = null;
  let preAnalysisObj = null;
  let activeMilestoneObj = null;
  let activeRevisionNote = "";

  if (transactionId) {
    try {
      let numericTxId = Number(transactionId);
      if (isNaN(numericTxId)) {
        const txRows = await db.query(
          "SELECT id FROM transactions WHERE txn_code = ?",
          [transactionId],
        );
        if (txRows.length) numericTxId = txRows[0].id;
      }
      if (!isNaN(numericTxId)) {
        realTxId = numericTxId;
        const [txs] = await db
          .getPool()
          .query("SELECT * FROM transactions WHERE id = ?", [realTxId]);
        if (txs.length) {
          const tx = txs[0];
          title = title || tx.title;
          type = type || tx.category;
          amount = amount ?? tx.amount;
          currency = currency || tx.currency;

          normalizedScopeObj = normalizeScope(tx.scope_json);

          // Fetch milestones
          const milestones = await db.query(
            "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
            [realTxId],
          );

          if (milestones.length) {
            const mIds = milestones.map((m) => m.id);
            const [subs, revs] = await Promise.all([
              db.query(
                "SELECT * FROM milestone_submissions WHERE milestone_id IN (?) ORDER BY version ASC",
                [mIds],
              ),
              db.query(
                "SELECT * FROM revision_requests WHERE milestone_id IN (?) ORDER BY created_at ASC",
                [mIds],
              ),
            ]);

            // Determine target milestone
            if (realMilestoneId) {
              activeMilestoneObj =
                milestones.find((m) => m.id === Number(realMilestoneId)) || null;
            }
            if (!activeMilestoneObj) {
              activeMilestoneObj =
                milestones.find((m) => m.status === "submitted") || milestones[0];
              realMilestoneId = activeMilestoneObj.id;
            }

            // Locate target submission record for active milestone
            const milestoneSubs = subs.filter(
              (s) => s.milestone_id === activeMilestoneObj.id,
            );
            if (realSubmissionId) {
              activeSubRecord =
                milestoneSubs.find((s) => s.id === Number(realSubmissionId)) || null;
            }
            if (!activeSubRecord && milestoneSubs.length) {
              activeSubRecord = milestoneSubs[milestoneSubs.length - 1];
              realSubmissionId = activeSubRecord.id;
            }

            // Extract relevant revision request for target milestone only
            const milestoneRevs = revs.filter(
              (r) => r.milestone_id === activeMilestoneObj.id,
            );
            if (milestoneRevs.length) {
              const latestRev = milestoneRevs[milestoneRevs.length - 1];
              activeRevisionNote = sanitizeText(
                latestRev.reason || latestRev.details || "",
                200,
              );
            }

            if (activeSubRecord && activeSubRecord.submission_data) {
              submissionDataObj =
                typeof activeSubRecord.submission_data === "string"
                  ? JSON.parse(activeSubRecord.submission_data)
                  : activeSubRecord.submission_data;
            }

            preAnalysisObj = preAnalyzeSubmission(
              normalizedScopeObj,
              submissionDataObj,
            );
          }
        }
      }
    } catch (e) {
      console.warn(
        "Could not fetch detailed transaction context for AI audit:",
        e.message,
      );
    }
  }

  // Construct compact item comparison array for LLM input
  const scopeItems = preAnalysisObj?.item_analysis || [];
  const globalNote = sanitizeText(
    activeSubRecord?.deliverable_note ||
      activeMilestoneObj?.deliverable_note ||
      "",
    300,
  );

  const compactRequirements = scopeItems.map((item) => {
    const claimText =
      item.claim && item.claim !== "No claim provided by provider."
        ? sanitizeText(item.claim, 300)
        : globalNote
          ? `Global submission note: "${globalNote}"`
          : "No explicit claim provided.";

    const evidenceItems = (item.evidence_items || []).map((e) => ({
      type: sanitizeText(e.type || e.source_type || "link", 40),
      label: sanitizeText(e.label || e.file_name || e.url || "Evidence", 100),
      url: sanitizeText(e.url, 150),
      desc: sanitizeText(e.description, 120),
    }));

    return {
      scope_item_id: item.scope_item_id,
      name: sanitizeText(item.name, 100),
      description: sanitizeText(item.description, 200),
      matched: item.matched,
      status: item.status,
      claim: claimText,
      has_evidence: item.has_evidence,
      evidence_count: item.evidence_count,
      evidence_types: item.evidence_types || [],
      evidence_items: evidenceItems,
    };
  });

  const compactAuditContext = {
    milestone: activeMilestoneObj
      ? sanitizeText(activeMilestoneObj.title, 100)
      : "N/A",
    submission_note: globalNote || "None",
    revision_request: activeRevisionNote || "None",
    testing: {
      performed: !!preAnalysisObj?.testing?.performed,
      summary: sanitizeText(
        preAnalysisObj?.testing?.summary || "No testing evidence provided.",
        200,
      ),
    },
    requirements: compactRequirements,
  };

  let auditResult = null;

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `You are Escrow's AI Deliverable Auditor. Compare agreed scope requirements against provider submitted deliverables.

CRITICAL RULES:
1. Provider claims alone are NOT proof of completion without supporting evidence metadata.
2. Evidence metadata (URLs, repos, staging links, documentation) indicates what was submitted.
3. Do NOT claim to have inspected external URLs, repositories, files, or live systems unless exact extracted code/content was provided. State that supporting evidence was submitted.
4. Evaluate every scope requirement using scope_item_id as the primary matching key.
5. Set requirement status to one of: "passed", "passed_with_notes", "insufficient_evidence", "revision_required", "failed".
6. Return ONLY valid JSON matching this exact structure:

{
  "score": 85,
  "status": "passed",
  "summary": "2-sentence executive summary of the audit.",
  "risk": "low",
  "riskScore": 15,
  "requirements": [
    {
      "scope_item_id": "d1",
      "requirement": "User Authentication API",
      "status": "passed",
      "evidence": ["Repository URL submitted as supporting evidence"],
      "confidence": 92,
      "reason": "Concise reason based on submitted claim and evidence metadata."
    }
  ],
  "checks": [
    { "name": "Scope Compliance", "status": "passed", "note": "explanation" },
    { "name": "Technical & QA Check", "status": "passed", "note": "explanation" },
    { "name": "Testing", "status": "warning", "note": "explanation" },
    { "name": "Documentation", "status": "passed", "note": "explanation" },
    { "name": "Deadline Compliance", "status": "passed", "note": "explanation" }
  ],
  "missing_requirements": [],
  "recommendation": "One clear actionable recommendation."
}

Overall status options: passed, passed_with_notes, insufficient_evidence, revision_required, failed
Risk options: low, medium, high
Check status options: passed, warning, failed
Score / RiskScore: 0-100`,
        },
        {
          role: "user",
          content: `Project: "${sanitizeText(title, 100)}" | Category: "${sanitizeText(type, 50)}" | Value: ${amount ?? 0} ${currency || "USD"} | Vendor: "${sanitizeText(counterparty, 50)}"

AUDIT DATASET:
${JSON.stringify(compactAuditContext)}`,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content;

    auditResult = parseJsonResponse(text);

    if (
      !auditResult ||
      typeof auditResult !== "object" ||
      typeof auditResult.score !== "number" ||
      !auditResult.status ||
      !auditResult.summary ||
      !auditResult.risk ||
      typeof auditResult.riskScore !== "number" ||
      !auditResult.recommendation
    ) {
      throw new Error("Groq returned an invalid audit structure.");
    }

    // Backwards compatibility for checks array if missing from LLM response
    if (!Array.isArray(auditResult.checks) || auditResult.checks.length === 0) {
      const reqList = Array.isArray(auditResult.requirements)
        ? auditResult.requirements
        : [];
      const reqPassed = reqList.filter((r) => r.status === "passed").length;
      const reqTotal = reqList.length || 1;
      auditResult.checks = [
        {
          name: "Scope Compliance",
          status:
            reqPassed === reqTotal
              ? "passed"
              : reqPassed > 0
                ? "warning"
                : "failed",
          note: `${reqPassed} of ${reqTotal} scope requirements met supported evidence standards.`,
        },
        {
          name: "Technical & QA Check",
          status:
            auditResult.risk === "low"
              ? "passed"
              : auditResult.risk === "medium"
                ? "warning"
                : "failed",
          note: auditResult.summary || "Submission evidence checked.",
        },
        {
          name: "Testing & Documentation",
          status: preAnalysisObj?.testing?.performed ? "passed" : "warning",
          note:
            preAnalysisObj?.testing?.summary || "No testing evidence attached.",
        },
      ];
    }
  } catch (err) {
    console.error("Groq AI Audit error:", err);

    if (err.statusCode) throw err;

    const groqMsg = err?.error?.message || err?.message || "";
    const isTokenLimit =
      groqMsg.includes("413") ||
      groqMsg.toLowerCase().includes("request too large") ||
      groqMsg.toLowerCase().includes("tpm") ||
      groqMsg.toLowerCase().includes("token");

    if (isTokenLimit) {
      const tokenErr = new Error(
        "The submission content exceeds the AI audit token limit. Please shorten attachment notes or descriptions and try again.",
      );
      tokenErr.statusCode = 413;
      tokenErr.code = "AI_AUDIT_PAYLOAD_TOO_LARGE";
      throw tokenErr;
    }

    if (
      groqMsg.toLowerCase().includes("rate limit") ||
      groqMsg.includes("429")
    ) {
      const rateErr = new Error(
        "AI Deliverable Audit is rate-limited. Please wait a moment and try again.",
      );
      rateErr.statusCode = 429;
      rateErr.code = "AI_AUDIT_RATE_LIMITED";
      throw rateErr;
    }

    const error = new Error(
      "AI Deliverable Audit is temporarily unavailable. Please try again.",
    );
    error.statusCode = 503;
    error.code = "AI_AUDIT_FAILED";
    throw error;
  }

  // Record usage in ai_usage
  await db.query(
    "INSERT INTO ai_usage (user_id, feature, transaction_id, metadata) VALUES (?, 'audit', ?, ?)",
    [
      userId,
      realTxId || null,
      JSON.stringify({
        title,
        score: auditResult.score,
        provider: "groq",
        model: GROQ_MODEL,
      }),
    ],
  );

  // Persist audit record in ai_audits table
  if (realTxId) {
    try {
      const insertRes = await db.query(
        `INSERT INTO ai_audits
         (transaction_id, milestone_id, submission_id, audited_by, score, status, risk, risk_score, summary, recommendation, checks_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          realTxId,
          realMilestoneId || null,
          realSubmissionId || null,
          userId,
          auditResult.score,
          auditResult.status,
          auditResult.risk,
          auditResult.riskScore,
          auditResult.summary,
          auditResult.recommendation,
          JSON.stringify({
            checks: auditResult.checks,
            requirements: auditResult.requirements || [],
            missing_requirements: auditResult.missing_requirements || [],
          }),
        ],
      );
      auditResult.auditId = insertRes.insertId;
      auditResult.created_at = new Date().toISOString();
    } catch (dbErr) {
      console.error("Failed to persist audit in ai_audits table:", dbErr);
    }
  }

  return auditResult;
}

export async function getTransactionAudits(transactionId) {
  let numericTxId = Number(transactionId);
  if (isNaN(numericTxId)) {
    const txRows = await db.query(
      "SELECT id FROM transactions WHERE txn_code = ?",
      [transactionId],
    );
    if (txRows.length) numericTxId = txRows[0].id;
  }
  if (isNaN(numericTxId)) return [];

  const rows = await db.query(
    `SELECT a.*, u.name as audited_by_name
     FROM ai_audits a
     JOIN users u ON a.audited_by = u.id
     WHERE a.transaction_id = ?
     ORDER BY a.created_at DESC`,
    [numericTxId],
  );
  return rows;
}
