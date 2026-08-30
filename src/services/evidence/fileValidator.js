/**
 * fileValidator.js
 * Stage 2 — File Inspection & Magic Byte Validation Module
 *
 * Validates files by inspecting magic byte signatures, MIME types, extensions,
 * size caps, filename safety, and preventing path traversal attacks.
 */

import path from "path";
import fs from "fs";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".bash", ".php", ".phtml",
  ".asp", ".aspx", ".jsp", ".dll", ".so", ".dylib", ".vbs",
  ".scr", ".jar", ".sys", ".drv",
]);

/**
 * Inspects a Buffer's leading magic bytes to identify its actual format.
 *
 * @param {Buffer} buffer
 * @returns {string} Detected file type: 'pdf', 'png', 'jpeg', 'gif', 'webp', 'zip', 'text', 'unknown'
 */
export function detectMagicBytes(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return "unknown";
  }

  // 1. PDF: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "pdf";
  }

  // 2. PNG: \x89PNG (0x89 0x50 0x4E 0x47)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  // 3. JPEG: 0xFF 0xD8 0xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // 4. GIF: GIF8 (0x47 0x49 0x46 0x38)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "gif";
  }

  // 5. WebP: RIFF....WEBP (0x52 0x49 0x46 0x46 ... 0x57 0x45 0x42 0x50 at offset 8)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  // 6. ZIP: PK\x03\x04 (0x50 0x4B 0x03 0x04)
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return "zip";
  }

  // 7. Plain text check (all printable ASCII / UTF-8)
  let isText = true;
  const sampleLen = Math.min(buffer.length, 512);
  for (let i = 0; i < sampleLen; i++) {
    const byte = buffer[i];
    // Allow printable ASCII, tabs, newlines, carriage returns, and valid UTF-8 high bytes
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) {
      isText = false;
      break;
    }
  }

  if (isText) return "text";

  return "unknown";
}

/**
 * Validates a filename string against path traversal and dangerous extensions.
 *
 * @param {string} fileName
 * @returns {{ valid: boolean, reason?: string, sanitizedName?: string }}
 */
export function validateFileName(fileName) {
  if (!fileName || typeof fileName !== "string") {
    return { valid: false, reason: "Filename must be a non-empty string." };
  }

  // Check for null bytes or control characters
  if (/[\x00-\x1f\x7f]/.test(fileName)) {
    return { valid: false, reason: "Filename contains invalid control characters." };
  }

  // Path traversal checks
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.startsWith("~")
  ) {
    return { valid: false, reason: `Path traversal detected in filename "${fileName}".` };
  }

  const ext = path.extname(fileName).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    return { valid: false, reason: `Dangerous file extension "${ext}" is blocked.` };
  }

  const sanitizedName = fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return { valid: true, sanitizedName };
}

/**
 * Validates an uploaded or stored evidence file (buffer or file on disk).
 *
 * @param {object} params
 * @param {Buffer} [params.buffer]
 * @param {string} [params.filePath]
 * @param {string} [params.fileName]
 * @param {string} [params.mimeType]
 * @param {number} [params.maxSize]
 * @returns {Promise<{
 *   valid: boolean,
 *   detectedType: string,
 *   reason?: string,
 *   size: number,
 *   buffer?: Buffer
 * }>}
 */
export async function validateEvidenceFile({ buffer, filePath, fileName, mimeType, maxSize }) {
  const fileCap = maxSize || MAX_FILE_SIZE;

  // 1. Filename validation
  if (fileName) {
    const fnCheck = validateFileName(fileName);
    if (!fnCheck.valid) {
      return { valid: false, detectedType: "unknown", reason: fnCheck.reason, size: 0 };
    }
  }

  let dataBuffer = buffer;

  // 2. Read from disk if filePath provided
  if (!dataBuffer && filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return { valid: false, detectedType: "unknown", reason: `File not found on disk: "${filePath}".`, size: 0 };
      }

      const stats = fs.statSync(filePath);
      if (stats.size > fileCap) {
        return {
          valid: false,
          detectedType: "unknown",
          reason: `File size (${stats.size} bytes) exceeds maximum limit (${fileCap} bytes).`,
          size: stats.size,
        };
      }

      dataBuffer = fs.readFileSync(filePath);
    } catch (err) {
      return { valid: false, detectedType: "unknown", reason: `Failed reading file: ${err.message}`, size: 0 };
    }
  }

  if (!dataBuffer) {
    return { valid: false, detectedType: "unknown", reason: "No file content or buffer provided.", size: 0 };
  }

  if (dataBuffer.length > fileCap) {
    return {
      valid: false,
      detectedType: "unknown",
      reason: `File size (${dataBuffer.length} bytes) exceeds maximum limit (${fileCap} bytes).`,
      size: dataBuffer.length,
    };
  }

  // 3. Inspect magic bytes signature
  const detectedType = detectMagicBytes(dataBuffer);

  // Cross check detected type with claimed MIME type if available
  if (mimeType) {
    const normMime = mimeType.toLowerCase();
    if (detectedType === "pdf" && !normMime.includes("pdf")) {
      console.warn(`[fileValidator] MIME mismatch: claimed "${mimeType}", detected "pdf".`);
    }
    if (detectedType === "zip" && !normMime.includes("zip") && !normMime.includes("octet-stream")) {
      console.warn(`[fileValidator] MIME mismatch: claimed "${mimeType}", detected "zip".`);
    }
  }

  return {
    valid: true,
    detectedType,
    size: dataBuffer.length,
    buffer: dataBuffer,
  };
}
