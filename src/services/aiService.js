import db from "../config/db.js";
import { getUserEntitlements } from "./entitlementService.js";
import OpenAI from "openai";
import { getScopeItems } from "./scopeService.js";
import { runAuditPipeline } from "./audit/auditOrchestrator.js";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_groq_key",
  baseURL: "https://api.groq.com/openai/v1",
  timeout: 15000,
  maxRetries: 0,
});

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

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
 * Calculate dynamic, strictly ascending milestone progress checkpoints for any milestone count N.
 * Never hardcodes counts; ensures 100% at the final milestone.
 */
export function calculateDynamicMilestoneProgress(count) {
  const n = parseInt(count);
  if (isNaN(n) || n <= 0) return [100];
  if (n === 1) return [100];
  if (n === 2) return [50, 100];
  if (n === 3) return [30, 65, 100];
  if (n === 4) return [25, 50, 75, 100];

  const progress = [];
  for (let i = 1; i <= n; i++) {
    if (i === n) {
      progress.push(100);
    } else {
      const raw = Math.round((i / n) * 100);
      const prev = progress.length > 0 ? progress[progress.length - 1] : 0;
      const val = Math.max(prev + 1, Math.min(raw, 100 - (n - i)));
      progress.push(val);
    }
  }
  return progress;
}

/**
 * Normalizes milestone checkpoints ensuring expected_project_progress is numeric,
 * strictly ascending, within [1, 100], and ends at 100%.
 */
export function normalizeMilestoneCheckpoints(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) return [];
  const n = milestones.length;
  const fallbackProgress = calculateDynamicMilestoneProgress(n);

  let prevProgress = 0;
  return milestones.map((m, idx) => {
    let prog =
      m.expected_project_progress !== undefined &&
      m.expected_project_progress !== null
        ? parseInt(m.expected_project_progress)
        : null;

    if (
      prog === null ||
      isNaN(prog) ||
      prog <= prevProgress ||
      (idx === n - 1 && prog !== 100) ||
      prog > 100 ||
      prog <= 0
    ) {
      prog = fallbackProgress[idx];
    }
    prevProgress = prog;

    const deliverables = Array.isArray(m.deliverables)
      ? m.deliverables
      : typeof m.deliverables === "string" && m.deliverables.trim()
        ? [m.deliverables.trim()]
        : [];

    const acceptance_criteria = Array.isArray(m.acceptance_criteria)
      ? m.acceptance_criteria
      : typeof m.acceptance_criteria === "string" && m.acceptance_criteria.trim()
        ? [m.acceptance_criteria.trim()]
        : [];

    return {
      ...m,
      name: m.name || m.title || `Milestone ${idx + 1}`,
      expected_project_progress: prog,
      deliverables,
      acceptance_criteria,
    };
  });
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
You are Escrow's AI Scope Generator for technology, digital, and professional services.

Your job is to convert a client's project description into a clear, professional, specific, measurable and verifiable project scope where each milestone represents a scheduled PROJECT CHECKPOINT.

A milestone represents:
"By this specific date/checkpoint, this is the agreed state/progress of the overall project, these are the deliverables expected to exist, these are the acceptance criteria, and this is what the provider must submit for client review."

DELIVERABLE & MILESTONE CHECKPOINT STANDARDS:
1. Generate specific, customizable deliverables reflecting the user's project requirements.
2. Deliverable "d1" scope_item_id MUST be "d1" (e.g. Complete Project Implementation Archive / ZIP).
3. Deliverable "d2" scope_item_id MUST be "d2" (e.g. Documentation, Summary & Verification Notes).
4. Acceptance criteria MUST contain verifiable criteria for deliverable inspection.
5. MILESTONE PROJECT CHECKPOINTS:
   - Generate dynamic project checkpoints in the "milestones" array.
   - For each milestone, provide:
     * "name": Milestone title (e.g. "Phase 1: Foundation & Setup")
     * "description": Brief overview of project state at this checkpoint
     * "expected_project_progress": Integer percentage between 1 and 100 representing cumulative project completion expected at this checkpoint. Must be strictly ascending across milestones, with the final milestone representing 100%. (e.g. for 2 milestones: 50, 100; for 3 milestones: 30, 65, 100; for 4 milestones: 25, 50, 75, 100; or dynamic custom intervals based on work distribution).
     * "deliverables": Array of specific deliverable titles/descriptions expected to exist at this checkpoint.
     * "acceptance_criteria": Array of specific criteria required to accept this checkpoint.
     * "timeline": Expected duration/timeline for this phase (e.g. "Day 2", "Phase 1").
6. EXPLICIT CLIENT PARAMETER DETECTION:
   - If user specified milestone count in description (e.g. "4 milestones", "3 milestones"), generate EXACTLY that number of milestones in the "milestones" array and set "milestones_count" to that integer.
   - If user specified duration/timeline in description (e.g. "ready in 2 days", "5 days"), set "timeline" to that duration (e.g. "2 days").
   - If user specified review window or short timeframe, set "review_days" to appropriate integer (e.g. 1, 2, or 3 days; default 3 if unspecified).
7. Timeline MUST be dynamic based on user description or project complexity (e.g. "2 days", "10 days", "2 weeks").
8. Revision policy should be flexible (e.g. "2 revisions included per milestone").
9. STRICT FINANCIAL & LEGAL CONSTRAINT: Do NOT invent financial rates, fees, or penalties.
10. Return ONLY valid JSON. Do not use markdown or code fences.

Return exactly this structure:

{
  "title": "short project title",
  "overview": "2-3 sentence project overview",
  "deliverables": [
    {
      "scope_item_id": "d1",
      "name": "Complete Project Implementation Archive (ZIP)",
      "description": "Compressed ZIP archive containing all source code, implementation files, assets, scripts, and runnable project artifacts."
    },
    {
      "scope_item_id": "d2",
      "name": "Project Summary & Implementation Notes (Text Explanation)",
      "description": "Comprehensive text explanation detailing what was built, feature overview, setup/installation notes, and verification summary."
    }
  ],
  "milestones": [
    {
      "name": "Foundation & Core Architecture",
      "description": "Project setup, authentication, and core database integration.",
      "expected_project_progress": 30,
      "deliverables": [
        "Project setup & structure",
        "Authentication module",
        "Database integration"
      ],
      "acceptance_criteria": [
        "User registration and login functional",
        "Database schemas initialized"
      ],
      "timeline": "Day 2"
    }
  ],
  "milestones_count": 3,
  "review_days": 3,
  "timeline": "10 days",
  "revisions": "2 revisions included per milestone",
  "acceptance": [
    "Project deliverable assets are submitted, verified, and match project scope specifications."
  ]
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
      !scopeResult.timeline
    ) {
      throw new Error("Groq returned an invalid project scope structure.");
    }

    // Deterministic parameter extraction fallback from user description
    const descLower = description.toLowerCase();
    const milestoneMatch = descLower.match(/(\d+)\s*milestones?/);
    if (milestoneMatch) {
      const reqCount = parseInt(milestoneMatch[1]);
      if (reqCount > 0 && reqCount <= 100) {
        scopeResult.milestones_count = reqCount;
        if (Array.isArray(scopeResult.milestones) && scopeResult.milestones.length !== reqCount) {
          const currentM = scopeResult.milestones;
          const newM = [];
          for (let i = 0; i < reqCount; i++) {
            if (currentM[i]) {
              newM.push(currentM[i]);
            } else {
              newM.push({
                name: `Milestone ${i + 1}`,
                description: `Phase ${i + 1} deliverable inspection and verification`,
                timeline: `Phase ${i + 1}`,
                deliverables: [`Phase ${i + 1} deliverables`],
                acceptance_criteria: [`Phase ${i + 1} criteria verified`],
              });
            }
          }
          scopeResult.milestones = newM;
        }
      }
    } else if (Array.isArray(scopeResult.milestones)) {
      scopeResult.milestones_count = scopeResult.milestones.length;
    }

    // Normalize milestone checkpoints to guarantee numeric strictly ascending progress with final 100%
    scopeResult.milestones = normalizeMilestoneCheckpoints(scopeResult.milestones);

    const durationMatch = descLower.match(/(?:ready|done|complete|completed|due|finish|duration|timeline|in|within)\s*(?:in|within)?\s*(\d+\s*(?:days?|weeks?|months?|hours?))/);
    if (durationMatch && durationMatch[1]) {
      scopeResult.timeline = durationMatch[1].trim();
    }

    const reviewMatch = descLower.match(/(\d+)\s*days?\s*review/);
    if (reviewMatch) {
      scopeResult.review_days = parseInt(reviewMatch[1]);
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
    console.warn("Groq API key is not configured on the server; proceeding with deterministic Stage 3 audit engine.");
  }

  // Delegate to Stage 3 Audit Orchestration Pipeline
  const auditResult = await runAuditPipeline(userId, {
    transactionId,
    milestoneId,
    submissionId,
    title,
    type,
    amount,
    currency,
    counterparty,
  });

  // Record AI usage in ai_usage table
  await db.query(
    "INSERT INTO ai_usage (user_id, feature, transaction_id, metadata) VALUES (?, 'audit', ?, ?)",
    [
      userId,
      auditResult.transactionId || null,
      JSON.stringify({
        title,
        score: auditResult.score,
        provider: "groq",
        model: GROQ_MODEL,
        auditVersion: auditResult.auditVersion,
      }),
    ],
  );

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
