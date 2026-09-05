/**
 * disputeAnalysisService.js
 * AI-Assisted Dispute Resolution Engine for Escrow Platform Admin Panel.
 *
 * Gathers complete transaction & dispute context (contract scope, deliverables,
 * Stage 3/4 AI audits, transaction history, user evidence) and runs structured
 * evaluation via Groq to recommend fair financial resolutions.
 */

import OpenAI from "openai";
import db from "../config/db.js";
import { logTransactionEvent } from "./transactionEventService.js";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_groq_key",
  baseURL: "https://api.groq.com/openai/v1",
});

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/**
 * Safely parse JSON from AI response text.
 */
function parseJsonResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn("[disputeAnalysisService] Failed to parse AI JSON response:", e.message);
    return null;
  }
}

/**
 * Collect all relevant context for a dispute.
 */
export async function collectDisputeContext(disputeId) {
  const [disputeRows] = await db.getPool().query(
    "SELECT * FROM disputes WHERE id = ?",
    [disputeId]
  );
  if (!disputeRows.length) {
    throw new Error(`Dispute #${disputeId} not found.`);
  }
  const dispute = disputeRows[0];
  const txId = dispute.transaction_id;

  // Transaction details + buyer / seller
  const [txRows] = await db.getPool().query(
    `SELECT t.*,
            b.name AS buyer_name, b.email AS buyer_email,
            s.name AS seller_name, s.email AS seller_email
     FROM transactions t
     LEFT JOIN users b ON t.buyer_id = b.id
     LEFT JOIN users s ON t.seller_id = s.id
     WHERE t.id = ?`,
    [txId]
  );
  const transaction = txRows[0] || null;

  // Scope items & Acceptance criteria
  const [scopeRows] = await db.getPool().query(
    "SELECT * FROM transaction_scope_items WHERE transaction_id = ? ORDER BY id ASC",
    [txId]
  );
  const [criteriaRows] = await db.getPool().query(
    "SELECT * FROM acceptance_criteria WHERE transaction_id = ? ORDER BY id ASC",
    [txId]
  );

  // Milestones & Submissions
  const [milestoneRows] = await db.getPool().query(
    "SELECT * FROM milestones WHERE transaction_id = ? ORDER BY id ASC",
    [txId]
  );
  const [submissionRows] = await db.getPool().query(
    `SELECT ms.*, m.title AS milestone_title
     FROM milestone_submissions ms
     JOIN milestones m ON ms.milestone_id = m.id
     WHERE m.transaction_id = ?
     ORDER BY ms.created_at DESC`,
    [txId]
  );

  // AI Audits and Analyzer Results
  const [auditRows] = await db.getPool().query(
    "SELECT * FROM ai_audits WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 5",
    [txId]
  );

  let analyzerRows = [];
  if (auditRows.length) {
    const [aRes] = await db.getPool().query(
      `SELECT ar.*
       FROM analyzer_results ar
       JOIN audit_jobs aj ON ar.audit_job_id = aj.id
       WHERE aj.transaction_id = ?
       ORDER BY ar.created_at DESC LIMIT 10`,
      [txId]
    );
    analyzerRows = aRes || [];
  }

  // Transaction events
  const [eventRows] = await db.getPool().query(
    "SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY created_at ASC",
    [txId]
  );

  return {
    dispute,
    transaction,
    scope: scopeRows || [],
    acceptanceCriteria: criteriaRows || [],
    milestones: milestoneRows || [],
    submissions: submissionRows || [],
    audits: auditRows || [],
    analyzerResults: analyzerRows || [],
    events: eventRows || [],
  };
}

/**
 * Fallback deterministic analysis if AI fails or key is missing.
 */
function generateFallbackAnalysis(context) {
  const { dispute, transaction, milestones, submissions, audits } = context;
  const escrowBal = parseFloat(transaction?.escrow_balance || transaction?.amount || 0);
  const isBuyerFiler = Number(dispute.filed_by) === Number(transaction?.buyer_id);
  const filerRole = isBuyerFiler ? "Buyer" : "Seller";

  // Check if any audits failed or passed
  const latestAudit = audits[0];
  let recommendation = "split";
  let buyerPct = 50;
  let sellerPct = 50;
  let confidence = 70;

  if (latestAudit && latestAudit.score >= 80) {
    recommendation = "seller";
    buyerPct = 0;
    sellerPct = 100;
    confidence = 82;
  } else if (latestAudit && latestAudit.score < 40) {
    recommendation = "buyer";
    buyerPct = 100;
    sellerPct = 0;
    confidence = 85;
  } else if (submissions.length === 0 && isBuyerFiler) {
    recommendation = "buyer";
    buyerPct = 100;
    sellerPct = 0;
    confidence = 90;
  }

  const buyerAmount = Number(((escrowBal * buyerPct) / 100).toFixed(2));
  const sellerAmount = Number(((escrowBal * sellerPct) / 100).toFixed(2));

  return {
    recommendation,
    confidence_score: confidence,
    summary: `Dispute filed by ${filerRole} regarding: "${dispute.reason}". Analysis based on ${milestones.length} milestone(s), ${submissions.length} deliverable submission(s), and ${audits.length} automated audit record(s).`,
    contract_analysis: {
      scope_compliance: latestAudit ? `Audit score: ${latestAudit.score}/100.` : "Scope compliance undetermined.",
      milestone_deliverables_status: `${submissions.length} deliverable(s) submitted across ${milestones.length} milestone(s).`,
      acceptance_criteria_met: latestAudit?.status === "passed" ? "Criteria largely satisfied" : "Discrepancies identified in acceptance criteria",
      notes: "Contract obligations assessed against available milestone deliverables and audit benchmarks.",
    },
    evidence_evaluation: {
      filer_evidence_strength: dispute.evidence ? "moderate" : "weak",
      counterparty_position: isBuyerFiler ? "Seller has submitted work under contract milestones." : "Buyer raised contestation on deliverables.",
      key_evidence_points: [
        `Filer statement: ${dispute.reason}`,
        dispute.evidence ? "Supporting evidence provided by filer." : "No separate evidence attachments submitted with dispute.",
      ],
    },
    findings: [
      {
        title: "Dispute Claim Evaluation",
        severity: "medium",
        description: dispute.reason || "Dispute claim raised without specific details.",
        impact: `Contests $${escrowBal.toLocaleString()} in escrow.`,
      },
      {
        title: "Deliverables Status",
        severity: submissions.length > 0 ? "low" : "high",
        description: submissions.length > 0 ? `${submissions.length} submission(s) logged on platform.` : "No milestone submissions found.",
        impact: submissions.length > 0 ? "Verification data available." : "Lack of submitted proof.",
      },
    ],
    fault_attribution: {
      buyer_fault_percentage: 100 - buyerPct,
      seller_fault_percentage: 100 - sellerPct,
      notes: `Evaluation assigns primary responsibility based on deliverable audit score and submission completeness.`,
    },
    recommended_split: {
      buyer_percentage: buyerPct,
      seller_percentage: sellerPct,
      buyer_amount: buyerAmount,
      seller_amount: sellerAmount,
    },
    reasoning: `Based on automated audit scores and contractual submission state, the platform recommends a resolution favoring ${recommendation.toUpperCase()} (${buyerPct}% Buyer / ${sellerPct}% Seller) for the $${escrowBal.toLocaleString()} in dispute.`,
    risk_factors: [
      "Officer should verify any direct communication logs between parties.",
      "Check if any custom milestone adjustments were agreed off-platform.",
    ],
    suggested_action: `Review the technical deliverables and execute resolution favoring ${recommendation.toUpperCase()}.`,
  };
}

/**
 * Execute AI Dispute Analysis using Groq LLM.
 */
export async function analyzeDisputeWithAi(context) {
  const { dispute, transaction, scope, acceptanceCriteria, milestones, submissions, audits, analyzerResults, events } = context;
  const escrowBal = parseFloat(transaction?.escrow_balance || transaction?.amount || 0);
  const isBuyerFiler = Number(dispute.filed_by) === Number(transaction?.buyer_id);
  const filerRole = isBuyerFiler ? "Buyer" : "Seller";

  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === "dummy_groq_key") {
    console.log("[disputeAnalysisService] GROQ_API_KEY not configured. Using deterministic fallback.");
    return {
      analysis: generateFallbackAnalysis(context),
      model: "fallback_deterministic",
      tokensUsed: 0,
    };
  }

  const systemPrompt = `You are an expert impartial escrow dispute arbitrator and legal auditor for an online escrow platform.
Your job is to analyze contract terms, milestone requirements, deliverable submissions, technical AI audit results, transaction events, and user evidence to produce a fair, balanced, and evidence-grounded dispute resolution recommendation.

IMPORTANT SAFETY CONSTRAINTS:
1. Your output is advisory to human platform officers who retain sole final decision-making power.
2. You must never invent facts not present in the provided context.
3. Be impartial, objective, and specific.
4. Output MUST be valid, well-structured JSON only (no markdown, no extra commentary outside JSON).

Required JSON structure:
{
  "recommendation": "buyer" | "seller" | "split" | "manual_investigation",
  "confidence_score": <number between 0 and 100>,
  "summary": "<2-3 sentence executive summary of dispute and facts>",
  "contract_analysis": {
    "scope_compliance": "<assessment of whether scope requirements were fulfilled>",
    "milestone_deliverables_status": "<status of deliverables across milestones>",
    "acceptance_criteria_met": "<whether acceptance criteria were met>",
    "notes": "<contractual notes>"
  },
  "evidence_evaluation": {
    "filer_evidence_strength": "strong" | "moderate" | "weak" | "inconclusive",
    "counterparty_position": "<analysis of counterparty position>",
    "key_evidence_points": ["<point 1>", "<point 2>"]
  },
  "findings": [
    {
      "title": "<finding title>",
      "severity": "high" | "medium" | "low" | "info",
      "description": "<detailed description>",
      "impact": "<impact on resolution>"
    }
  ],
  "fault_attribution": {
    "buyer_fault_percentage": <number 0-100>,
    "seller_fault_percentage": <number 0-100>,
    "notes": "<explanation of fault distribution>"
  },
  "recommended_split": {
    "buyer_percentage": <number 0-100>,
    "seller_percentage": <number 0-100>,
    "buyer_amount": <number dollar/currency amount>,
    "seller_amount": <number dollar/currency amount>
  },
  "reasoning": "<thorough justification of the recommended verdict and financial split>",
  "risk_factors": ["<risk/consideration 1>", "<risk/consideration 2>"],
  "suggested_action": "<actionable directive for the admin officer>"
}`;

  const userPrompt = `DISPUTE CASE CONTEXT:
Transaction Code: ${transaction?.txn_code}
Title: ${transaction?.title}
Category: ${transaction?.category}
Total Amount: $${parseFloat(transaction?.amount || 0).toLocaleString()}
Escrow Balance in Dispute: $${escrowBal.toLocaleString()}
Buyer: ${transaction?.buyer_name} (${transaction?.buyer_email})
Seller: ${transaction?.seller_name} (${transaction?.seller_email})

Dispute Filed By: ${filerRole} (${dispute.filed_by === transaction?.buyer_id ? transaction?.buyer_name : transaction?.seller_name})
Dispute Reason: ${dispute.reason}
Dispute Evidence/Description: ${dispute.evidence || "None provided"}
Dispute Status: ${dispute.status}

Contract Scope Items:
${scope.length ? JSON.stringify(scope.map(s => ({ id: s.scope_item_id || s.id, description: s.description || s.title, deliverable_type: s.deliverable_type }))) : "No explicit scope items defined."}

Acceptance Criteria:
${acceptanceCriteria.length ? JSON.stringify(acceptanceCriteria.map(c => ({ title: c.title, criteria: c.criteria, is_mandatory: c.is_mandatory }))) : "No explicit acceptance criteria defined."}

Milestones:
${milestones.length ? JSON.stringify(milestones.map(m => ({ id: m.id, title: m.title, amount: m.amount, status: m.status }))) : "No milestones."}

Deliverable Submissions:
${submissions.length ? JSON.stringify(submissions.map(s => ({ milestone_id: s.milestone_id, version: s.version, category: s.category, notes: s.notes, data: s.submission_data }))) : "No submissions logged."}

Technical AI Audits:
${audits.length ? JSON.stringify(audits.map(a => ({ score: a.score, status: a.status, risk: a.risk, summary: a.summary, recommendation: a.recommendation }))) : "No audits recorded."}

Specialized Analyzer Results:
${analyzerResults.length ? JSON.stringify(analyzerResults.map(ar => ({ analyzer: ar.analyzer_name, status: ar.status, findings: ar.findings_json }))) : "No specialized analyzer results."}

Recent Timeline Events:
${events.slice(-10).map(e => `[${e.created_at}] ${e.action}: ${e.note || ""}`).join("\n")}

Please provide your rigorous, impartial AI Dispute Resolution Analysis in valid JSON.`;

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content || "";
    const parsed = parseJsonResponse(content);

    if (!parsed || !parsed.recommendation) {
      console.warn("[disputeAnalysisService] Invalid JSON from Groq, falling back.");
      return {
        analysis: generateFallbackAnalysis(context),
        model: GROQ_MODEL + "_fallback",
        tokensUsed: response.usage?.total_tokens || 0,
      };
    }

    // Ensure recommended_split amounts match escrow balance
    if (parsed.recommended_split) {
      const bPct = Number(parsed.recommended_split.buyer_percentage || 0);
      const sPct = Number(parsed.recommended_split.seller_percentage || 0);
      parsed.recommended_split.buyer_amount = Number(((escrowBal * bPct) / 100).toFixed(2));
      parsed.recommended_split.seller_amount = Number(((escrowBal * sPct) / 100).toFixed(2));
    }

    return {
      analysis: parsed,
      model: GROQ_MODEL,
      tokensUsed: response.usage?.total_tokens || 0,
    };
  } catch (err) {
    console.error("[disputeAnalysisService] Groq API call error:", err.message);
    return {
      analysis: generateFallbackAnalysis(context),
      model: "fallback_error",
      tokensUsed: 0,
    };
  }
}

/**
 * Run full dispute analysis, record in DB, and return saved record.
 */
export async function runDisputeAnalysis(disputeId) {
  const context = await collectDisputeContext(disputeId);
  const { dispute, transaction } = context;

  // Calculate next version
  const [versionRows] = await db.getPool().query(
    "SELECT MAX(analysis_version) AS max_v FROM ai_dispute_analyses WHERE dispute_id = ?",
    [disputeId]
  );
  const nextVersion = (versionRows[0]?.max_v || 0) + 1;

  // Run AI analysis
  const { analysis, model, tokensUsed } = await analyzeDisputeWithAi(context);

  // Insert into DB
  const [insertRes] = await db.getPool().query(
    `INSERT INTO ai_dispute_analyses (
      dispute_id, transaction_id, analysis_version, recommendation,
      confidence_score, summary, contract_analysis, evidence_evaluation,
      findings, fault_attribution, recommended_split, reasoning,
      risk_factors, suggested_action, model_used, tokens_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dispute.id,
      transaction.id,
      nextVersion,
      analysis.recommendation || "manual_investigation",
      analysis.confidence_score || 70,
      analysis.summary || "",
      JSON.stringify(analysis.contract_analysis || {}),
      JSON.stringify(analysis.evidence_evaluation || {}),
      JSON.stringify(analysis.findings || []),
      JSON.stringify(analysis.fault_attribution || {}),
      JSON.stringify(analysis.recommended_split || {}),
      analysis.reasoning || "",
      JSON.stringify(analysis.risk_factors || []),
      analysis.suggested_action || "",
      model,
      tokensUsed,
    ]
  );

  // Log transaction event
  await logTransactionEvent({
    transactionId: transaction.id,
    userId: dispute.filed_by || transaction.buyer_id,
    action: "ai_dispute_analysis_generated",
    note: `AI dispute analysis v${nextVersion} generated with recommendation: ${analysis.recommendation?.toUpperCase()} (${analysis.confidence_score}% confidence).`,
  });

  // Track AI usage
  try {
    await db.getPool().query(
      `INSERT INTO ai_usage (user_id, feature, transaction_id, metadata)
       VALUES (?, 'dispute_assistant', ?, ?)`,
      [
        dispute.filed_by || transaction.buyer_id,
        transaction.id,
        JSON.stringify({ disputeId, analysisVersion: nextVersion, recommendation: analysis.recommendation }),
      ]
    );
  } catch (usageErr) {
    console.warn("[disputeAnalysisService] Failed to log AI usage:", usageErr.message);
  }

  const [savedRows] = await db.getPool().query(
    "SELECT * FROM ai_dispute_analyses WHERE id = ?",
    [insertRes.insertId]
  );
  return savedRows[0];
}

/**
 * Get all analyses for a dispute.
 */
export async function getDisputeAnalyses(disputeId) {
  const [rows] = await db.getPool().query(
    "SELECT * FROM ai_dispute_analyses WHERE dispute_id = ? ORDER BY analysis_version DESC",
    [disputeId]
  );
  return rows;
}

/**
 * Get latest analysis for a dispute.
 */
export async function getLatestDisputeAnalysis(disputeId) {
  const [rows] = await db.getPool().query(
    "SELECT * FROM ai_dispute_analyses WHERE dispute_id = ? ORDER BY analysis_version DESC LIMIT 1",
    [disputeId]
  );
  return rows[0] || null;
}
