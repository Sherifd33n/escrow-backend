/**
 * verdictPolicyEngine.js
 * Stage 3 — Deterministic Final Verdict & Release Eligibility Policy Engine
 *
 * Enforces business rules for calculating final audit score, risk level,
 * overall verdict status, release blockers, and binary release eligibility.
 *
 * DO NOT allow the LLM alone to make release decisions!
 */

/**
 * Calculates final audit verdict, score, risk, blockers, and release eligibility.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements          - Flattened requirement list
 * @param {Array<object>} params.auditedRequirementResults - Requirement audit results
 * @param {Record<string, object>} params.deterministicChecks - Deterministic checks per requirement
 * @param {Array<object>} [params.limitations]         - Processing limitations
 * @returns {{
 *   score: number,
 *   risk: "low" | "medium" | "high",
 *   riskScore: number,
 *   status: "passed" | "passed_with_notes" | "revision_required" | "failed" | "manual_review_required" | "audit_incomplete",
 *   releaseEligible: boolean,
 *   releaseDecision: "eligible" | "blocked" | "manual_approval_required",
 *   releaseBlockers: Array<string>,
 *   coverage: { totalRequirements: number, auditedRequirements: number, coveragePercent: number },
 *   summary: string,
 *   recommendation: string
 * }}
 */
export function calculateFinalVerdict({
  requirements = [],
  auditedRequirementResults = [],
  deterministicChecks = {},
  limitations = [],
}) {
  const total = requirements.length || 1;
  const auditedCount = auditedRequirementResults.length;
  const coveragePercent = Math.min(100, Math.round((auditedCount / total) * 100));

  let totalScoreSum = 0;
  let failedCount = 0;
  let revisionCount = 0;
  let insufficientCount = 0;
  let passedCount = 0;
  let passedWithNotesCount = 0;

  // criticalFailureCount = hard failures on critical/required items (caps score at 40)
  let criticalFailureCount = 0;
  // criticalInsufficientCount = missing evidence on critical/required items (triggers manual review)
  let criticalInsufficientCount = 0;
  // requiredRevisionCount = revisions needed on required (but not hard-failed) items
  let requiredRevisionCount = 0;

  const releaseBlockers = [];

  auditedRequirementResults.forEach((res) => {
    const req = requirements.find((r) => r.criterion_id === res.criterion_id);
    const isCritical = req ? !!req.critical : false;
    const isRequired = req ? req.required !== false : true;

    const reqScore = typeof res.score === "number" ? res.score : 0;
    totalScoreSum += reqScore;

    switch (res.status) {
      case "passed":
        passedCount++;
        break;

      case "passed_with_notes":
        passedWithNotesCount++;
        break;

      case "insufficient_evidence":
        insufficientCount++;
        if (isCritical) {
          // Only hard-critical items trigger score cap
          criticalInsufficientCount++;
          releaseBlockers.push(`Critical requirement "${req?.requirement || res.criterion_id}" has insufficient evidence.`);
        } else if (isRequired) {
          criticalInsufficientCount++;
          releaseBlockers.push(`Required requirement "${req?.requirement || res.criterion_id}" has insufficient evidence.`);
        }
        break;

      case "revision_required":
        revisionCount++;
        if (isCritical) {
          // Critical item needing revision = hard failure → caps score
          criticalFailureCount++;
          releaseBlockers.push(`Critical requirement "${req?.requirement || res.criterion_id}" requires revision.`);
        } else if (isRequired) {
          // Required but not critical → revision needed but does NOT cap score at 40
          requiredRevisionCount++;
          releaseBlockers.push(`Requirement "${req?.requirement || res.criterion_id}" requires revision.`);
        } else {
          // Optional item → just note it
          revisionCount++;
        }
        break;

      case "failed":
        failedCount++;
        if (isCritical || isRequired) {
          criticalFailureCount++;
          releaseBlockers.push(`Critical requirement "${req?.requirement || res.criterion_id}" failed.`);
        }
        break;

      default:
        break;
    }

    // Check contradiction flag from deterministic checks
    const dCheck = deterministicChecks[res.criterion_id];
    if (dCheck && dCheck.contradictionDetected) {
      releaseBlockers.push(`Contradiction detected for requirement "${req?.requirement || res.criterion_id}".`);
    }
  });

  // Check if any deterministic check flagged a Project Identity Mismatch
  const hasProjectMismatch = Object.values(deterministicChecks).some((dc) => dc && dc.projectMismatch);
  if (hasProjectMismatch) {
    releaseBlockers.unshift("Major project identity mismatch: Submitted deliverables do not correspond to the contracted project scope.");
  }

  // Calculate weighted overall score
  let rawScore = Math.round(totalScoreSum / Math.max(1, auditedCount));

  // Project Mismatch Guard: Caps score to max 20
  if (hasProjectMismatch) {
    rawScore = Math.min(20, rawScore);
  } else if (criticalFailureCount > 0) {
    // Critical Failure Guard: Only HARD failures on critical/required items cap the score at 40
    rawScore = Math.min(40, rawScore);
  }

  const score = Math.max(0, Math.min(100, rawScore));
  const riskScore = 100 - score;

  // Calculate Risk Level
  let risk = "low";
  if (hasProjectMismatch || criticalFailureCount > 0 || failedCount >= 2 || riskScore >= 70) {
    risk = "high";
  } else if (criticalInsufficientCount > 0 || failedCount === 1 || requiredRevisionCount > 0 || riskScore >= 40) {
    risk = "medium";
  }

  // Calculate Verdict Status
  let status = "passed";
  if (hasProjectMismatch || criticalFailureCount > 0 || failedCount >= 2) {
    status = "failed";
  } else if (revisionCount > 0 || requiredRevisionCount > 0 || failedCount === 1 || score < 65) {
    status = "revision_required";
  } else if (criticalInsufficientCount > 0) {
    status = "manual_review_required";
  } else if (passedWithNotesCount > 0 || insufficientCount > 0) {
    status = "passed_with_notes";
  }

  // Calculate Binary Release Eligibility & Decision
  let releaseEligible = false;
  let releaseDecision = "blocked";

  if (!hasProjectMismatch && status === "passed") {
    releaseEligible = true;
    releaseDecision = "eligible";
  } else if (!hasProjectMismatch && status === "passed_with_notes" && criticalFailureCount === 0 && criticalInsufficientCount === 0) {
    releaseEligible = true;
    releaseDecision = "eligible";
  } else if (status === "manual_review_required") {
    releaseEligible = false;
    releaseDecision = "manual_approval_required";
  } else {
    releaseEligible = false;
    releaseDecision = "blocked";
  }

  // Generate Executive Summary
  const summary =
    status === "passed" || status === "passed_with_notes"
      ? `Audit passed with score ${score}/100 (${passedCount + passedWithNotesCount}/${total} requirements verified). Release eligible.`
      : `Audit status: ${status.toUpperCase()} (score ${score}/100). ${releaseBlockers.length} blocker(s) identified. Release ${releaseDecision.toUpperCase()}.`;

  // Generate Actionable Recommendation
  const recommendation =
    releaseEligible
      ? "Deliverables meet contractual requirements. Escrow funds may be released."
      : hasProjectMismatch
        ? "Provider must submit the actual contracted project deliverables. Escrow release is blocked."
        : releaseBlockers.length > 0
          ? `Provider should address blockers: ${releaseBlockers.slice(0, 2).join("; ")}.`
          : "Manual review required by client/admin before releasing funds.";

  return {
    score,
    risk,
    riskScore,
    status,
    releaseEligible,
    releaseDecision,
    releaseBlockers,
    coverage: {
      totalRequirements: total,
      auditedRequirements: auditedCount,
      coveragePercent,
    },
    summary,
    recommendation,
  };
}

