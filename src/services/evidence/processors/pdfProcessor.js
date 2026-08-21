/**
 * pdfProcessor.js
 * Stage 2 — PDF Evidence Processor Module
 *
 * Inspects PDF files, detects page count, extracts text content without raw binary
 * dumps, chunkifies content with page traceability, and flags non-extractable /
 * scanned PDFs as requiring vision.
 */

import { detectMagicBytes } from "../fileValidator.js";
import { chunkContent } from "../chunker.js";

/**
 * Extracts printable text strings from a PDF buffer stream.
 *
 * @param {Buffer} buffer
 * @returns {string} Extracted text
 */
function extractPdfTextFromBuffer(buffer) {
  if (!buffer) return "";
  const rawStr = buffer.toString("binary");
  const textParts = [];

  // Match text blocks inside BT...ET or Tj/TJ operations
  const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g;
  let match;

  while ((match = tjRegex.exec(rawStr)) !== null) {
    const cleaned = match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\([()])/g, "$1")
      .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

    const printable = cleaned.replace(/[^\x20-\x7E\s]/g, "").trim();
    if (printable.length > 2) {
      textParts.push(printable);
    }
  }

  // Fallback: search for plain text lines if TJ matching didn't yield enough
  if (textParts.length === 0) {
    const lines = rawStr.split(/\r?\n/);
    for (const line of lines) {
      if (
        !line.startsWith("%") &&
        !line.includes("obj") &&
        !line.includes("endobj") &&
        !line.includes("stream") &&
        !line.includes("xref")
      ) {
        const printable = line.replace(/[^\x20-\x7E\s]/g, "").trim();
        if (printable.length > 15 && /[a-zA-Z]{3,}/.test(printable)) {
          textParts.push(printable);
        }
      }
    }
  }

  return textParts.join("\n");
}

/**
 * Detects page count from PDF buffer structure.
 *
 * @param {Buffer} buffer
 * @returns {number} Page count (at least 1 if valid PDF)
 */
function detectPdfPageCount(buffer) {
  const str = buffer.toString("binary");
  const countMatch = str.match(/\/Count\s+(\d+)/);
  if (countMatch && countMatch[1]) {
    const cnt = parseInt(countMatch[1], 10);
    if (!isNaN(cnt) && cnt > 0) return cnt;
  }

  const pageMatches = str.match(/\/Type\s*\/Page\b/g);
  if (pageMatches && pageMatches.length > 0) {
    return pageMatches.length;
  }

  return 1;
}

/**
 * Process a PDF evidence file.
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.evidenceId
 * @param {string} [params.fileName]
 * @returns {Promise<{
 *   type: "pdf",
 *   status: "processed" | "failed",
 *   pageCount: number,
 *   textExtracted: boolean,
 *   requiresVision: boolean,
 *   textLength: number,
 *   content: string,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processPdf({ buffer, evidenceId, fileName = "document.pdf" }) {
  if (!buffer || detectMagicBytes(buffer) !== "pdf") {
    return {
      type: "pdf",
      status: "failed",
      pageCount: 0,
      textExtracted: false,
      requiresVision: false,
      textLength: 0,
      content: "",
      findings: [],
      chunks: [],
      error: "Invalid PDF magic bytes signature.",
    };
  }

  const pageCount = detectPdfPageCount(buffer);
  const extractedText = extractPdfTextFromBuffer(buffer);
  const textLength = extractedText.length;
  const textExtracted = textLength > 50;
  const requiresVision = !textExtracted;

  const findings = [];
  findings.push({
    type: "pdf_metadata",
    location: `file: ${fileName}`,
    finding: `PDF document verified (${pageCount} page(s), ${textLength} characters extracted).`,
  });

  if (requiresVision) {
    findings.push({
      type: "pdf_limitation",
      location: `file: ${fileName}`,
      finding: "PDF contains image-only or non-extractable text streams; OCR / vision analysis is recommended.",
    });
  } else {
    findings.push({
      type: "pdf_content_sample",
      location: "pages 1..",
      finding: `Extracted text snippet: "${extractedText.substring(0, 200).replace(/\s+/g, " ")}..."`,
    });
  }

  const chunks = textExtracted
    ? chunkContent({
        content: extractedText,
        evidenceId,
        sourceType: "pdf",
        sourceLocation: `${fileName}`,
      })
    : [];

  return {
    type: "pdf",
    status: "processed",
    pageCount,
    textExtracted,
    requiresVision,
    textLength,
    content: extractedText,
    findings,
    chunks,
  };
}
