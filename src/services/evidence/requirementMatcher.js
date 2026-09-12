/**
 * requirementMatcher.js
 * Intelligent Requirement-to-Evidence Matcher & Indexer
 *
 * Maps each contractual requirement / acceptance criterion to the most relevant
 * files, code chunks, symbols, and routes in the submitted evidence.
 * Eliminates arbitrary truncation (like .slice(0,12)) by scoring relevance.
 */

/**
 * Extracts search tokens from a requirement text.
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function extractRequirementKeywords(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "this", "that", "from", "should", "must", "all", "each", "have", "been"].includes(w));
}

/**
 * Scores a file's relevance to a specific requirement.
 *
 * @param {object} file - { path, category, content, symbols, imports }
 * @returns {number} Score
 */
function scoreFileRelevance(file, reqKeywords, reqFullText) {
  let keywordScore = 0;
  const p = (file.path || "").toLowerCase();
  const content = (file.content || "").toLowerCase();

  // 1. Path match (e.g. Cart.jsx for Shopping Cart requirement)
  reqKeywords.forEach((kw) => {
    if (p.includes(kw)) keywordScore += 10;
  });

  // 2. Exact phrase match in content
  if (reqKeywords.length >= 2) {
    const bigram = reqKeywords.slice(0, 2).join(" ");
    if (content.includes(bigram)) keywordScore += 15;
  }

  // 3. Keyword count in content
  reqKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "g");
    const matches = content.match(regex);
    if (matches) {
      keywordScore += Math.min(matches.length, 10) * 2;
    }
  });

  // Only assign total score if there is an actual keyword / path match
  if (keywordScore === 0) return 0;

  let score = keywordScore;
  // Boost actual source files over lockfiles or configs
  if (file.category === "source") score += 5;
  if (file.category === "tests" && reqFullText.includes("test")) score += 15;
  if (file.category === "manifests") score += 2;

  return score;
}


/**
 * Matches requirements against submitted files and chunks to find targeted evidence.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements        - Contractual requirements list
 * @param {Array<object>} params.files               - Extracted file list with content
 * @param {Array<object>} [params.chunks=[]]         - Pre-chunked evidence snippets
 * @param {object} [params.projectFingerprint=null]  - Extracted project fingerprint
 * @returns {Record<string, {
 *   criterion_id: string,
 *   requirement: string,
 *   relevanceScore: number,
 *   matchedFiles: Array<{ path: string, score: number, snippet: string }>,
 *   matchedSymbols: Array<string>,
 *   matchedRoutes: Array<string>,
 *   evidenceSnippets: Array<{ source: string, code: string }>
 * }>}
 */
export function matchRequirementsToEvidence({
  requirements = [],
  files = [],
  chunks = [],
  projectFingerprint = null,
}) {
  const matchesMap = {};

  if (!Array.isArray(requirements)) return matchesMap;

  requirements.forEach((req) => {
    const criterionId = req.criterion_id || req.scope_item_id || "criterion";
    const reqText = `${req.requirement || ""} ${req.scope_name || ""}`;
    const reqKeywords = extractRequirementKeywords(reqText);
    const reqLower = reqText.toLowerCase();

    // 1. Score each file
    const scoredFiles = files.map((file) => {
      const score = scoreFileRelevance(file, reqKeywords, reqLower);
      return {
        path: file.path,
        category: file.category,
        content: file.content || "",
        score,
      };
    }).filter((f) => f.score > 0).sort((a, b) => b.score - a.score);

    // 2. Select top matched files (up to 5 most relevant)
    const topFiles = scoredFiles.slice(0, 5);

    // 3. Extract relevant snippets from top files
    const evidenceSnippets = [];
    topFiles.forEach((tf) => {
      const lines = tf.content.split("\n");
      // Find line with highest keyword hit
      let bestLineIdx = 0;
      let maxHits = 0;
      lines.forEach((line, idx) => {
        const lineLower = line.toLowerCase();
        let hits = 0;
        reqKeywords.forEach((kw) => {
          if (lineLower.includes(kw)) hits++;
        });
        if (hits > maxHits) {
          maxHits = hits;
          bestLineIdx = idx;
        }
      });

      // Window of 20 lines around the best match
      const start = Math.max(0, bestLineIdx - 5);
      const end = Math.min(lines.length, bestLineIdx + 20);
      const snippet = lines.slice(start, end).join("\n").trim();

      if (snippet) {
        evidenceSnippets.push({
          source: `${tf.path}:${start + 1}-${end}`,
          code: snippet.slice(0, 800),
        });
      }
    });

    // 4. Matched symbols & routes from fingerprint
    const matchedSymbols = (projectFingerprint?.symbols || []).filter((sym) => {
      const sLower = sym.toLowerCase();
      return reqKeywords.some((kw) => sLower.includes(kw));
    });

    const matchedRoutes = (projectFingerprint?.routes || []).filter((r) => {
      const rLower = r.toLowerCase();
      return reqKeywords.some((kw) => rLower.includes(kw));
    });

    const totalRelevanceScore = topFiles.reduce((acc, f) => acc + f.score, 0);

    matchesMap[criterionId] = {
      criterion_id: criterionId,
      requirement: req.requirement,
      relevanceScore: totalRelevanceScore,
      matchedFiles: topFiles.map((f) => ({
        path: f.path,
        score: f.score,
        snippet: (f.content || "").slice(0, 300),
      })),
      matchedSymbols: matchedSymbols.slice(0, 10),
      matchedRoutes: matchedRoutes.slice(0, 10),
      evidenceSnippets: evidenceSnippets.slice(0, 4),
    };
  });

  return matchesMap;
}
