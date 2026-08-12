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

7. Return ONLY valid JSON. Do not use markdown or code fences.

Return exactly this structure:

{
  "title": "short project title",
  "overview": "2-3 sentence project overview",
  "deliverables": [
    "specific deliverable",
    "specific deliverable",
    "specific deliverable",
    "specific deliverable",
    "specific deliverable"
  ],
  "milestones": [
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 1"
    },
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 2-3"
    },
    {
      "name": "milestone name",
      "description": "what should be delivered in this milestone",
      "timeline": "Week 4"
    }
  ],
  "acceptance": [
    "measurable acceptance criterion",
    "measurable acceptance criterion",
    "measurable acceptance criterion",
    "measurable acceptance criterion"
  ],
  "timeline": "estimated total project timeline",
  "revisions": "reasonable revision policy"
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
    console.error("Groq Scope Generator error:", err);

    const error = new Error(
      "AI Scope Generator is temporarily unavailable. Please try again.",
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
export async function runAiAudit(
  userId,
  { transactionId, title, type, amount, currency, counterparty },
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

  // Record usage only after successful AI audit.
  await db.query(
    "INSERT INTO ai_usage (user_id, feature, transaction_id, metadata) VALUES (?, 'audit', ?, ?)",
    [
      userId,
      transactionId || null,
      JSON.stringify({
        title,
        score: auditResult.score,
        provider: "groq",
        model: "llama-3.3-70b-versatile",
      }),
    ],
  );

  return auditResult;
}
