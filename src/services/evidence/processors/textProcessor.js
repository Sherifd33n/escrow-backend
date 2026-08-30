/**
 * textProcessor.js
 * Stage 2 — TXT / Markdown Evidence Processor Module
 *
 * Validates text encoding, normalizes content, extracts markdown headings & sections,
 * generates content chunks with location tags, and structures text evidence findings.
 */

import { chunkContent } from "../chunker.js";

/**
 * Parses markdown headings to extract structured document sections.
 *
 * @param {string} text
 * @returns {Array<{ heading: string, level: number, line: number }>}
 */
function parseMarkdownHeadings(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const headings = [];

  lines.forEach((line, idx) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        heading: match[2].trim(),
        level: match[1].length,
        line: idx + 1,
      });
    }
  });

  return headings;
}

/**
 * Process a TXT or Markdown evidence file.
 *
 * @param {object} params
 * @param {Buffer|string} params.content
 * @param {string} params.evidenceId
 * @param {string} [params.fileName="document.txt"]
 * @param {string} [params.type="text"] - 'text' or 'markdown'
 * @returns {Promise<{
 *   type: "text" | "markdown",
 *   status: "processed" | "failed",
 *   contentLength: number,
 *   lineCount: number,
 *   sections: Array<object>,
 *   content: string,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processText({ content, evidenceId, fileName = "document.txt", type = "text" }) {
  if (!content) {
    return {
      type,
      status: "failed",
      contentLength: 0,
      lineCount: 0,
      sections: [],
      content: "",
      findings: [],
      chunks: [],
      error: "Text content is empty.",
    };
  }

  const rawText = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  const normalized = rawText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const lineCount = lines.length;
  const contentLength = normalized.length;

  const isMarkdown = type === "markdown" || fileName.toLowerCase().endsWith(".md");
  const processorType = isMarkdown ? "markdown" : "text";

  const sections = isMarkdown ? parseMarkdownHeadings(normalized) : [];

  const findings = [];
  findings.push({
    type: `${processorType}_document`,
    location: `file: ${fileName}`,
    finding: `${processorType.toUpperCase()} document verified (${lineCount} lines, ${contentLength} bytes, ${sections.length} headings).`,
  });

  if (sections.length > 0) {
    sections.slice(0, 5).forEach((sec) => {
      findings.push({
        type: "markdown_section",
        location: `line ${sec.line}`,
        finding: `Heading (H${sec.level}): "${sec.heading}"`,
      });
    });
  }

  const chunks = chunkContent({
    content: normalized,
    evidenceId,
    sourceType: processorType,
    sourceLocation: fileName,
  });

  return {
    type: processorType,
    status: "processed",
    contentLength,
    lineCount,
    sections,
    content: normalized,
    findings,
    chunks,
  };
}
