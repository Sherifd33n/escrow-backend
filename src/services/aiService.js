import db from "../config/db.js";
import { getUserEntitlements } from "./entitlementService.js";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "",
  baseURL: "https://api.groq.com/openai/v1",
});

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
      model: "llama-3.3-70b-versatile",

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
   be checked during an AI deliverable audit.

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
    "specific deliverable 1",
    "specific deliverable 2",
    "specific deliverable 3",
    "specific deliverable 4",
    "specific deliverable 5"
  ],
  "milestones": [
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 1-2"
    },
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 3-5"
    },
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 6-8"
    }
  ],
  "acceptance": [
    "measurable acceptance criterion 1",
    "measurable acceptance criterion 2",
    "measurable acceptance criterion 3",
    "measurable acceptance criterion 4"
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

    // Validate the AI response before returning it.
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

    // Re-throw structured errors (entitlement, API key missing) unchanged.
    if (err.statusCode) throw err;

    // Surface Groq auth / rate-limit errors clearly.
    const groqMsg = err?.error?.message || err?.message || "";
    if (groqMsg.toLowerCase().includes("invalid api key") || groqMsg.toLowerCase().includes("authentication")) {
      const authErr = new Error("Groq API key is invalid or expired. Please contact support.");
      authErr.statusCode = 503;
      authErr.code = "GROQ_AUTH_FAILED";
      throw authErr;
    }
    if (groqMsg.toLowerCase().includes("rate limit")) {
      const rateErr = new Error("AI Scope Generator is rate-limited. Please try again in a moment.");
      rateErr.statusCode = 503;
      rateErr.code = "GROQ_RATE_LIMIT";
      throw rateErr;
    }

    const error = new Error(
      groqMsg || "AI Scope Generator is temporarily unavailable. Please try again.",
    );
    error.statusCode = 503;
    error.code = "AI_SCOPE_GENERATION_FAILED";
    throw error;
  }

  // Record AI usage only after a successful AI generation.
  await db.query(
    "INSERT INTO ai_usage (user_id, feature, metadata) VALUES (?, 'scope', ?)",
    [
      userId,
      JSON.stringify({
        categoryLabel,
        provider: "groq",
        model: "llama-3.3-70b-versatile",
      }),
    ],
  );

  return scopeResult;
}

/**
 * Run AI Deliverable Audit server-side with monthly quota check & usage record.
 */
/**
 * Run AI Deliverable Audit server-side with monthly quota check, persistence in ai_audits, & usage record.
 */
export async function runAiAudit(
  userId,
  { transactionId, milestoneId, submissionId, title, type, amount, currency, counterparty },
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

  // Fetch full context if transactionId is provided
  let txContext = "";
  let realTxId = null;
  let realMilestoneId = milestoneId || null;
  let realSubmissionId = submissionId || null;

  if (transactionId) {
    try {
      let numericTxId = Number(transactionId);
      if (isNaN(numericTxId)) {
        const txRows = await db.query("SELECT id FROM transactions WHERE txn_code = ?", [transactionId]);
        if (txRows.length) numericTxId = txRows[0].id;
      }
      if (!isNaN(numericTxId)) {
        realTxId = numericTxId;
        const [txs] = await db.getPool().query("SELECT * FROM transactions WHERE id = ?", [realTxId]);
        if (txs.length) {
          const tx = txs[0];
          title = title || tx.title;
          type = type || tx.category;
          amount = amount ?? tx.amount;
          currency = currency || tx.currency;

          txContext += `\nConfirmed Scope: ${tx.scope_json ? JSON.stringify(tx.scope_json) : "N/A"}`;
          txContext += `\nAgreed Revision Policy: ${tx.revision_policy || "2 rounds of minor revisions"}`;

          // Fetch milestones, submissions, and revision requests
          const milestones = await db.query(
            "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
            [realTxId]
          );

          if (milestones.length) {
            const mIds = milestones.map(m => m.id);
            const [subs, revs] = await Promise.all([
              db.query("SELECT * FROM milestone_submissions WHERE milestone_id IN (?) ORDER BY version ASC", [mIds]),
              db.query("SELECT * FROM revision_requests WHERE milestone_id IN (?) ORDER BY created_at ASC", [mIds]),
            ]);

            txContext += `\nMilestones & Deliverables:`;
            milestones.forEach(m => {
              const mSubs = subs.filter(s => s.milestone_id === m.id);
              const mRevs = revs.filter(r => r.milestone_id === m.id);
              txContext += `\n- Milestone: "${m.title}" (Status: ${m.status}, Amount: ${m.amount})`;
              if (m.deliverable_note) txContext += `\n  Latest Deliverable Note: ${m.deliverable_note}`;
              if (mSubs.length) {
                txContext += `\n  Submission History: ${mSubs.map(s => `[v${s.version}: "${s.deliverable_note}"]`).join(", ")}`;
                if (!realSubmissionId && mSubs.length) {
                  realSubmissionId = mSubs[mSubs.length - 1].id;
                }
              }
              if (mRevs.length) {
                txContext += `\n  Revision Requests: ${mRevs.map(r => `[Reason: "${r.reason}", Details: "${r.details}"]`).join(", ")}`;
              }
              if (!realMilestoneId && m.status === 'submitted') {
                realMilestoneId = m.id;
              }
            });
          }
        }
      }
    } catch (e) {
      console.warn("Could not fetch detailed transaction context for AI audit:", e.message);
    }
  }

  let auditResult = null;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
You are Escrow's AI Deliverable Auditor.

Your job is to evaluate a technology or digital service project
against the information available about the escrow transaction.

Analyze the project fairly and conservatively.

Do NOT automatically assume that a provider completed the work.

Do NOT invent evidence.

If there is not enough information to verify something, clearly state
that the information is insufficient.

Return ONLY valid JSON. Do not use markdown or code fences.

Return exactly this structure:

{
  "score": 0,
  "status": "passed",
  "summary": "2-sentence executive summary",
  "risk": "low",
  "riskScore": 0,
  "checks": [
    {
      "name": "Scope Compliance",
      "status": "passed",
      "note": "explanation"
    },
    {
      "name": "Code Quality & Security",
      "status": "passed",
      "note": "explanation"
    },
    {
      "name": "Testing",
      "status": "warning",
      "note": "explanation"
    },
    {
      "name": "Documentation",
      "status": "passed",
      "note": "explanation"
    },
    {
      "name": "Deadline Compliance",
      "status": "passed",
      "note": "explanation"
    }
  ],
  "recommendation": "one clear recommendation"
}

Allowed status values:

Overall status:
- passed
- passed_with_notes
- revision_required

Risk:
- low
- medium
- high

Check status:
- passed
- warning
- failed

Score:
0-100, where 100 means the available evidence strongly indicates
that the agreed work was completed.

Risk score:
0-100, where higher means greater project/deliverable risk.
          `,
        },
        {
          role: "user",
          content: `
Transaction ID:
${transactionId || "N/A"}

Project:
${title || "N/A"}

Category:
${type || "N/A"}

Transaction Value:
${amount ?? "N/A"} ${currency || "USD"}

Provider:
${counterparty || "N/A"}
${txContext}

IMPORTANT:
The information above is the currently available transaction data.
Do not claim that technical work has been verified unless evidence
actually exists in the supplied information.
          `,
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
      !Array.isArray(auditResult.checks) ||
      !auditResult.recommendation
    ) {
      throw new Error("Groq returned an invalid audit structure.");
    }
  } catch (err) {
    console.error("Groq AI Audit error:", err);

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
        model: "llama-3.3-70b-versatile",
      }),
    ],
  );

  // Persist audit record in ai_audits table (Audit History & Versioning)
  if (realTxId) {
    try {
      const [insertRes] = await db.query(
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
          JSON.stringify(auditResult.checks),
        ]
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
    const txRows = await db.query("SELECT id FROM transactions WHERE txn_code = ?", [transactionId]);
    if (txRows.length) numericTxId = txRows[0].id;
  }
  if (isNaN(numericTxId)) return [];

  const rows = await db.query(
    `SELECT a.*, u.name as audited_by_name
     FROM ai_audits a
     JOIN users u ON a.audited_by = u.id
     WHERE a.transaction_id = ?
     ORDER BY a.created_at DESC`,
    [numericTxId]
  );
  return rows;
}

