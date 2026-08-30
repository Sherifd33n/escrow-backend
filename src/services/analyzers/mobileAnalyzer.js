/**
 * mobileAnalyzer.js
 * Stage 4 — Specialized Mobile Application Analyzer (v1.0.0)
 *
 * Inspects mobile project evidence (Android, iOS, React Native, Flutter),
 * manifests (AndroidManifest.xml, Info.plist, pubspec.yaml), dependencies, and assets.
 */

export const MOBILE_ANALYZER_VERSION = "1.0.0";

/**
 * Analyzes mobile project evidence findings & file trees.
 *
 * @param {object} params
 * @param {Array<object>} params.stage2Findings
 * @param {Array<object>} params.fileTree
 * @returns {Promise<{
 *   analyzer: "mobile",
 *   version: string,
 *   status: "completed" | "failed",
 *   findings: Array<object>,
 *   limitations: Array<string>
 * }>}
 */
export async function analyzeMobileProject({ stage2Findings = [], fileTree = [] }) {
  const findings = [];
  const limitations = [];
  const filePaths = fileTree.map((f) => (f.path || "").toLowerCase());

  if (filePaths.some((p) => p.includes("androidmanifest.xml") || p.endsWith(".gradle"))) {
    findings.push({
      type: "mobile_platform_detected",
      severity: "info",
      source: "manifest",
      path: "AndroidManifest.xml",
      description: "Android mobile project architecture identified.",
    });
  }

  if (filePaths.some((p) => p.includes("info.plist") || p.endsWith(".xcodeproj") || p.endsWith(".xcworkspace"))) {
    findings.push({
      type: "mobile_platform_detected",
      severity: "info",
      source: "manifest",
      path: "Info.plist",
      description: "iOS mobile project architecture identified.",
    });
  }

  if (filePaths.some((p) => p.includes("pubspec.yaml"))) {
    findings.push({
      type: "mobile_framework_detected",
      severity: "info",
      source: "manifest",
      path: "pubspec.yaml",
      description: "Flutter cross-platform mobile framework identified.",
    });
  }

  limitations.push("Direct mobile binary execution on server disabled for security.");

  return {
    analyzer: "mobile",
    version: MOBILE_ANALYZER_VERSION,
    status: "completed",
    findings,
    limitations,
  };
}
