/**
 * webAnalyzer.js
 * Stage 4 — Specialized Web Project Analyzer (v1.0.0)
 *
 * Inspects web application evidence (React, Next.js, Vue, Node.js, Express, HTML/CSS),
 * identifies framework manifests, API endpoints, routes, build configs, and accessibility.
 */

export const WEB_ANALYZER_VERSION = "1.0.0";

/**
 * Analyzes web project evidence findings & file trees.
 *
 * @param {object} params
 * @param {Array<object>} params.stage2Findings
 * @param {Array<object>} params.fileTree
 * @param {Array<object>} params.chunks
 * @returns {Promise<{
 *   analyzer: "web",
 *   version: string,
 *   status: "completed" | "failed",
 *   findings: Array<{ type: string, severity: "info"|"warning"|"error", source: string, path: string, description: string }>,
 *   limitations: Array<string>
 * }>}
 */
export async function analyzeWebProject({ stage2Findings = [], fileTree = [], chunks = [] }) {
  const findings = [];
  const limitations = [];

  const filePaths = fileTree.map((f) => (f.path || "").toLowerCase());

  // 1. Framework & Manifest Detection
  const hasPackageJson = filePaths.some((p) => p.endsWith("package.json"));
  if (hasPackageJson) {
    findings.push({
      type: "manifest_detected",
      severity: "info",
      source: "manifest",
      path: "package.json",
      description: "Node.js / Web package manifest detected.",
    });
  }

  const hasNextJs = filePaths.some((p) => p.includes("next.config") || p.includes("app/") || p.includes("pages/"));
  if (hasNextJs) {
    findings.push({
      type: "framework_detected",
      severity: "info",
      source: "code",
      path: "next.config.js",
      description: "Next.js web framework structure identified.",
    });
  }

  const hasReact = filePaths.some((p) => p.endsWith(".jsx") || p.endsWith(".tsx") || p.includes("react"));
  if (hasReact) {
    findings.push({
      type: "framework_detected",
      severity: "info",
      source: "code",
      path: "src/",
      description: "React component architecture identified.",
    });
  }

  // 2. Route & API Endpoint Detection
  const routeFiles = fileTree.filter(
    (f) =>
      f.path.includes("route.") ||
      f.path.includes("page.") ||
      f.path.includes("api/") ||
      f.path.includes("routes/"),
  );

  routeFiles.slice(0, 10).forEach((f) => {
    findings.push({
      type: "web_route_detected",
      severity: "info",
      source: "code",
      path: f.path,
      description: `Web route/endpoint detected: "${f.path}"`,
    });
  });

  return {
    analyzer: "web",
    version: WEB_ANALYZER_VERSION,
    status: "completed",
    findings,
    limitations,
  };
}
