/**
 * aimlAnalyzer.js
 * Stage 4 — Specialized AI / Machine Learning Project Analyzer (v1.0.0)
 *
 * Inspects AI/ML project evidence (Jupyter notebooks `.ipynb`, Python scripts `.py`,
 * ML frameworks PyTorch/TensorFlow, model artifacts `.onnx`/`.pt`, evaluation metrics).
 */

export const AIML_ANALYZER_VERSION = "1.0.0";

/**
 * Analyzes AI/ML project evidence findings & file trees.
 *
 * @param {object} params
 * @param {Array<object>} params.fileTree
 * @param {Array<object>} params.chunks
 * @returns {Promise<{
 *   analyzer: "ai_ml",
 *   version: string,
 *   status: "completed" | "failed",
 *   findings: Array<object>,
 *   limitations: Array<string>
 * }>}
 */
export async function analyzeAiMlProject({ fileTree = [], chunks = [] }) {
  const findings = [];
  const limitations = [];
  const filePaths = fileTree.map((f) => (f.path || "").toLowerCase());

  const notebooks = filePaths.filter((p) => p.endsWith(".ipynb"));
  if (notebooks.length > 0) {
    findings.push({
      type: "aiml_notebook_detected",
      severity: "info",
      source: "code",
      path: notebooks[0],
      description: `Jupyter Notebook detected (${notebooks.length} file(s)).`,
    });
  }

  const modelFiles = filePaths.filter((p) => p.endsWith(".onnx") || p.endsWith(".pt") || p.endsWith(".h5") || p.endsWith(".safetensors"));
  if (modelFiles.length > 0) {
    findings.push({
      type: "aiml_model_artifact_detected",
      severity: "info",
      source: "model",
      path: modelFiles[0],
      description: `Model weights / artifact detected: "${modelFiles[0]}"`,
    });
  }

  limitations.push("Direct execution of Python/ML models disabled on main application server.");

  return {
    analyzer: "ai_ml",
    version: AIML_ANALYZER_VERSION,
    status: "completed",
    findings,
    limitations,
  };
}
