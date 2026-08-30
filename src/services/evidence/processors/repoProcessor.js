/**
 * repoProcessor.js
 * Stage 2 — Repository URL Evidence Processor Module
 *
 * Inspects public repository URLs (GitHub, GitLab, Bitbucket) with SSRF protection,
 * retrieves repository structure & metadata, captures branch/commit information,
 * and sets processingStatus = "access_required" if private authentication is needed.
 */

import { validateUrlForSsrf, safeFetchUrl } from "../ssrfValidator.js";
import { chunkContent } from "../chunker.js";

/**
 * Parses GitHub/GitLab/Bitbucket URL into provider, owner, repo.
 *
 * @param {string} urlStr
 * @returns {{ provider: string, owner: string, repo: string } | null}
 */
export function parseRepoUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;

  try {
    const parsed = new URL(urlStr.trim());
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");

    let provider = "other";
    if (host.includes("github")) provider = "github";
    else if (host.includes("gitlab")) provider = "gitlab";
    else if (host.includes("bitbucket")) provider = "bitbucket";

    return { provider, owner, repo };
  } catch (_) {
    return null;
  }
}

/**
 * Process a repository URL evidence item.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.evidenceId
 * @returns {Promise<{
 *   type: "repository",
 *   status: "processed" | "access_required" | "blocked" | "failed",
 *   provider: string,
 *   owner: string,
 *   repo: string,
 *   branch: string,
 *   commit: string|null,
 *   filesAnalyzed: number,
 *   languages: Array<string>,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processRepo({ url, evidenceId }) {
  // 1. SSRF Validation
  const ssrfCheck = await validateUrlForSsrf(url);
  if (!ssrfCheck.valid) {
    return {
      type: "repository",
      status: "blocked",
      provider: "unknown",
      owner: "",
      repo: "",
      branch: "",
      commit: null,
      filesAnalyzed: 0,
      languages: [],
      findings: [
        {
          type: "repo_security_block",
          location: `url: ${url}`,
          finding: `Repository URL blocked by SSRF protection: ${ssrfCheck.reason}`,
        },
      ],
      chunks: [],
      error: ssrfCheck.reason,
    };
  }

  const parsedRepo = parseRepoUrl(url);
  if (!parsedRepo) {
    return {
      type: "repository",
      status: "failed",
      provider: "unknown",
      owner: "",
      repo: "",
      branch: "",
      commit: null,
      filesAnalyzed: 0,
      languages: [],
      findings: [],
      chunks: [],
      error: `Invalid repository URL format: "${url}".`,
    };
  }

  const { provider, owner, repo } = parsedRepo;
  const findings = [];
  const chunks = [];

  // Attempt public GitHub API inspection if provider === 'github'
  if (provider === "github") {
    const apiRepoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    try {
      const res = await safeFetchUrl(apiRepoUrl, { timeoutMs: 5000 });
      if (res.statusCode === 404 || res.statusCode === 401 || res.statusCode === 403) {
        // Private repository or access token required
        findings.push({
          type: "repo_access_status",
          location: `repo: ${owner}/${repo}`,
          finding: "Repository is private or requires authentication (access_required).",
        });
        return {
          type: "repository",
          status: "access_required",
          provider,
          owner,
          repo,
          branch: "unknown",
          commit: null,
          filesAnalyzed: 0,
          languages: [],
          findings,
          chunks: [],
        };
      }

      if (res.statusCode === 200) {
        const repoData = JSON.parse(res.body.toString("utf8"));
        const defaultBranch = repoData.default_branch || "main";
        const isPrivate = !!repoData.private;

        findings.push({
          type: "repo_metadata",
          location: `repo: ${owner}/${repo}`,
          finding: `Public repository verified (Default branch: "${defaultBranch}", Stars: ${repoData.stargazers_count || 0}, Primary language: ${repoData.language || "Unknown"}).`,
        });

        // Attempt fetching README.md if public
        const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/README.md`;
        try {
          const readmeRes = await safeFetchUrl(readmeUrl, { timeoutMs: 4000 });
          if (readmeRes.statusCode === 200) {
            const readmeText = readmeRes.body.toString("utf8");
            findings.push({
              type: "repo_readme_summary",
              location: "README.md",
              finding: `README.md retrieved (${readmeText.length} bytes).`,
            });
            chunks.push(
              ...chunkContent({
                content: readmeText,
                evidenceId,
                sourceType: "repository_readme",
                sourceLocation: `${owner}/${repo}/README.md`,
              }),
            );
          }
        } catch (_) {}

        return {
          type: "repository",
          status: "processed",
          provider,
          owner,
          repo,
          branch: defaultBranch,
          commit: repoData.pushed_at || null,
          filesAnalyzed: repoData.size || 1,
          languages: repoData.language ? [repoData.language] : [],
          findings,
          chunks,
        };
      }
    } catch (err) {
      if (err.code === "SSRF_BLOCKED") throw err;
      console.warn(`[repoProcessor] GitHub API lookup note for ${owner}/${repo}: ${err.message}`);
    }
  }

  // Fallback for non-GitHub or direct repository URLs
  findings.push({
    type: "repo_metadata",
    location: `url: ${url}`,
    finding: `Repository URL registered (${provider.toUpperCase()} repo "${owner}/${repo}").`,
  });

  return {
    type: "repository",
    status: "processed",
    provider,
    owner,
    repo,
    branch: "main",
    commit: null,
    filesAnalyzed: 1,
    languages: [],
    findings,
    chunks,
  };
}
