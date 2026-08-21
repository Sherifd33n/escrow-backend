/**
 * imageProcessor.js
 * Stage 2 — Image / Screenshot Evidence Processor Module
 *
 * Inspects image formats (PNG, JPEG, GIF, WebP, SVG), verifies headers, extracts
 * image dimensions where available, and safely sets visionStatus = "unavailable"
 * when vision analysis is not active.
 */

import { detectMagicBytes } from "../fileValidator.js";

/**
 * Attempts to parse width and height from PNG, JPEG, GIF image headers.
 *
 * @param {Buffer} buffer
 * @param {string} format
 * @returns {{ width: number|null, height: number|null }}
 */
function parseImageDimensions(buffer, format) {
  if (!buffer || buffer.length < 24) return { width: null, height: null };

  try {
    if (format === "png" && buffer.length >= 24) {
      // PNG IHDR chunk width & height at offset 16 and 20
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    if (format === "gif" && buffer.length >= 10) {
      // GIF logical screen width & height at offset 6 and 8
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }

    if (format === "jpeg") {
      // Search for SOF0 marker (0xFF, 0xC0) in JPEG stream
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] === 0xff && (buffer[offset + 1] === 0xc0 || buffer[offset + 1] === 0xc2)) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        offset++;
      }
    }
  } catch (_) {
    // If header parsing fails, return null dimensions gracefully
  }

  return { width: null, height: null };
}

/**
 * Process an image evidence file.
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.evidenceId
 * @param {string} [params.fileName="image.png"]
 * @returns {Promise<{
 *   type: "image",
 *   status: "processed" | "failed",
 *   format: string,
 *   width: number|null,
 *   height: number|null,
 *   visionStatus: "unavailable" | "processed",
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processImage({ buffer, evidenceId, fileName = "image.png" }) {
  if (!buffer) {
    return {
      type: "image",
      status: "failed",
      format: "unknown",
      width: null,
      height: null,
      visionStatus: "unavailable",
      findings: [],
      chunks: [],
      error: "Image buffer is empty.",
    };
  }

  let format = detectMagicBytes(buffer);
  if (format === "unknown") {
    const ext = fileName.toLowerCase();
    if (ext.endsWith(".svg")) format = "svg";
  }

  const validImageFormats = ["png", "jpeg", "gif", "webp", "svg"];
  if (!validImageFormats.includes(format)) {
    return {
      type: "image",
      status: "failed",
      format,
      width: null,
      height: null,
      visionStatus: "unavailable",
      findings: [],
      chunks: [],
      error: `Unsupported image format "${format}". Allowed: PNG, JPEG, GIF, WebP, SVG.`,
    };
  }

  const { width, height } = parseImageDimensions(buffer, format);

  const findings = [];
  findings.push({
    type: "image_metadata",
    location: `file: ${fileName}`,
    finding: `Image evidence verified (${format.toUpperCase()}${width && height ? `, ${width}x${height}px` : ""}, ${buffer.length} bytes).`,
  });

  findings.push({
    type: "image_vision_status",
    location: `file: ${fileName}`,
    finding: "Vision analysis status: unavailable in current processing environment. Image metadata stored.",
  });

  return {
    type: "image",
    status: "processed",
    format,
    width,
    height,
    visionStatus: "unavailable",
    findings,
    chunks: [],
  };
}
