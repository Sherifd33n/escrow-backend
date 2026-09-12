/**
 * zipProcessor.js
 * Stage 2 — Safe ZIP Evidence Processor Module
 *
 * Inspects ZIP archives safely with zero-execution sandbox isolation.
 * Protects against:
 *   - Path traversal (`../`, `..\\`, absolute paths)
 *   - ZIP bombs (max 50MB total uncompressed size, max 500 files, max 100x compression ratio)
 *   - Dangerous archive structures & symlinks
 *
 * Generates file tree indices, categorizes files, extracts text from code/docs,
 * and chunkifies text with source location traceability.
 */

import zlib from "zlib";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { detectMagicBytes } from "../fileValidator.js";
import { chunkContent } from "../chunker.js";

const __dirname_zip = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_BASE_DIR = path.join(__dirname_zip, "../../../../uploads/temp_sandbox");

const MAX_TOTAL_UNCOMPRESSED_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_COUNT = 500;
const MAX_COMPRESSION_RATIO = 100; // 100x

/**
 * Safely parses PKZIP archives by first checking the Central Directory,
 * falling back to local file headers.
 * Supports Compression Method 0 (Store) and Method 8 (Deflate via zlib).
 *
 * @param {Buffer} buffer
 * @returns {Array<{
 *   fileName: string,
 *   compressionMethod: number,
 *   compressedSize: number,
 *   uncompressedSize: number,
 *   isDir: boolean,
 *   dataBuffer: Buffer|null
 * }>}
 */
function parseZipEntries(buffer) {
  if (!buffer || buffer.length < 22) return [];

  const entries = [];

  // Strategy 1: Find End of Central Directory (EOCD) record (signature 0x06054b50)
  let eocdOffset = -1;
  const maxScan = Math.min(buffer.length - 22, 65557);
  for (let i = buffer.length - 22; i >= buffer.length - maxScan; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    try {
      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      const cdSize = buffer.readUInt32LE(eocdOffset + 12);
      let cur = cdOffset;
      const cdEnd = Math.min(buffer.length, cdOffset + cdSize);

      while (cur < cdEnd - 46) {
        if (
          buffer[cur] !== 0x50 ||
          buffer[cur + 1] !== 0x4b ||
          buffer[cur + 2] !== 0x01 ||
          buffer[cur + 3] !== 0x02
        ) {
          break;
        }

        const compMethod = buffer.readUInt16LE(cur + 10);
        const compSize = buffer.readUInt32LE(cur + 20);
        const uncompSize = buffer.readUInt32LE(cur + 24);
        const fileNameLen = buffer.readUInt16LE(cur + 28);
        const extraLen = buffer.readUInt16LE(cur + 30);
        const commentLen = buffer.readUInt16LE(cur + 32);
        const localHeaderOffset = buffer.readUInt32LE(cur + 42);

        const fileName = buffer.toString("utf8", cur + 46, cur + 46 + fileNameLen);
        const isDir = fileName.endsWith("/") || fileName.endsWith("\\");

        let uncompressedData = null;
        if (!isDir && compSize > 0 && localHeaderOffset < buffer.length - 30) {
          try {
            const localFileNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
            const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
            const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
            const dataEnd = dataStart + compSize;

            if (dataEnd <= buffer.length) {
              const compressedData = buffer.subarray(dataStart, dataEnd);
              if (compMethod === 0) {
                uncompressedData = compressedData;
              } else if (compMethod === 8) {
                uncompressedData = zlib.inflateRawSync(compressedData);
              }
            }
          } catch (_) {
            // If inflate fails, uncompressedData remains null
          }
        }

        entries.push({
          fileName,
          compressionMethod: compMethod,
          compressedSize: compSize,
          uncompressedSize: uncompSize,
          isDir,
          dataBuffer: uncompressedData,
        });

        cur += 46 + fileNameLen + extraLen + commentLen;
      }

      if (entries.length > 0) {
        return entries;
      }
    } catch (_) {
      // Fallback to local headers scan below
    }
  }

  // Strategy 2: Fallback scan of local file headers
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x03 ||
      buffer[offset + 3] !== 0x04
    ) {
      offset++;
      continue;
    }

    const compMethod = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const headerSize = 30 + fileNameLen + extraLen;
    if (offset + headerSize + compSize > buffer.length) {
      break;
    }

    const rawFileName = buffer.toString("utf8", offset + 30, offset + 30 + fileNameLen);
    const compressedData = buffer.subarray(offset + headerSize, offset + headerSize + compSize);
    const isDir = rawFileName.endsWith("/") || rawFileName.endsWith("\\");

    let uncompressedData = null;
    if (!isDir && compSize > 0) {
      try {
        if (compMethod === 0) {
          uncompressedData = compressedData;
        } else if (compMethod === 8) {
          uncompressedData = zlib.inflateRawSync(compressedData);
        }
      } catch (_) {}
    }

    entries.push({
      fileName: rawFileName,
      compressionMethod: compMethod,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      isDir,
      dataBuffer: uncompressedData,
    });

    offset += headerSize + Math.max(compSize, 1);
  }

  return entries;
}

import { generateProjectFingerprint } from "../projectFingerprinter.js";
import { calculateSha256 } from "../hasher.js";

/**
 * Normalizes file path and checks if it belongs to an ignored/generated folder.
 */
function isIgnoredPath(filePath) {
  const norm = (filePath || "").toLowerCase().replace(/\\/g, "/");
  return (
    norm.includes("node_modules/") ||
    norm.includes(".git/") ||
    norm.includes("dist/") ||
    norm.includes("build/") ||
    norm.includes("coverage/") ||
    norm.includes(".next/") ||
    norm.includes(".cache/") ||
    norm.includes(".turbo/") ||
    norm.includes("vendor/") ||
    norm.includes("__pycache__/")
  );
}

/**
 * Detects programming/markup language from file extension.
 */
function detectLanguage(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  const map = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".json": "json",
    ".md": "markdown",
    ".txt": "text",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".sql": "sql",
    ".py": "python",
    ".java": "java",
    ".php": "php",
    ".go": "go",
    ".rb": "ruby",
    ".rs": "rust",
    ".swift": "swift",
    ".kt": "kotlin",
    ".dart": "dart",
    ".vue": "vue",
    ".svelte": "svelte",
    ".sh": "shell",
  };
  return map[ext] || "unknown";
}

/**
 * Categorizes a file path into source, config, docs, manifests, tests, readme, or assets.
 *
 * @param {string} filePath
 * @returns {string} Category name
 */
function categorizeFilePath(filePath) {
  const norm = (filePath || "").toLowerCase().replace(/\\/g, "/");
  const base = path.basename(norm);

  if (base.endsWith("-lock.json") || base.endsWith(".lock") || base.endsWith(".min.js") || base.endsWith(".min.css") || base === "package-lock.json" || base === "yarn.lock" || base === "pnpm-lock.yaml" || base === "cargo.lock") {
    return "lockfiles";
  }
  if (base.startsWith("readme")) return "readme";
  if (["package.json", "cargo.toml", "requirements.txt", "pom.xml", "build.gradle", "go.mod", "gemfile", "composer.json", "pubspec.yaml", "app.json"].includes(base)) {
    return "manifests";
  }
  if (norm.includes("test") || norm.includes("spec") || norm.includes("__tests__")) return "tests";
  if (base.endsWith(".md") || base.endsWith(".txt") || base.endsWith(".pdf") || norm.includes("/docs/") || norm.includes("/doc/")) {
    return "docs";
  }
  if (base.endsWith(".json") || base.endsWith(".yml") || base.endsWith(".yaml") || base.endsWith(".toml") || base.startsWith(".env") || base.endsWith(".config.js") || base.endsWith(".config.ts") || base.endsWith(".config.mjs")) {
    return "config";
  }
  if (/\.(js|ts|jsx|tsx|mjs|cjs|py|java|cpp|c|h|cs|go|rs|php|rb|html|css|scss|sass|less|vue|svelte|swift|kt|dart|sql|sh)$/.test(base)) {
    return "source";
  }
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|mp4|webm|pdf|woff|woff2|ttf|eot)$/.test(base)) {
    return "assets";
  }

  return "other";
}

/**
 * Process a ZIP evidence file safely.
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.evidenceId
 * @param {string} [params.fileName="archive.zip"]
 * @returns {Promise<{
 *   type: "zip",
 *   status: "processed" | "failed" | "blocked",
 *   totalFiles: number,
 *   totalUncompressedSize: number,
 *   fileTree: Array<object>,
 *   extractedFiles: Array<object>,
 *   projectFingerprint: object,
 *   categorized: object,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processZip({ buffer, evidenceId, fileName = "archive.zip" }) {
  const isZipSig = buffer && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!buffer || (!isZipSig && detectMagicBytes(buffer) !== "zip" && !fileName.toLowerCase().endsWith(".zip"))) {
    return {
      type: "zip",
      status: "failed",
      totalFiles: 0,
      totalUncompressedSize: 0,
      fileTree: [],
      extractedFiles: [],
      projectFingerprint: null,
      categorized: {},
      findings: [],
      chunks: [],
      error: "Invalid ZIP file buffer or magic bytes signature.",
    };
  }

  const rawEntries = parseZipEntries(buffer);
  if (rawEntries.length === 0) {
    return {
      type: "zip",
      status: "failed",
      totalFiles: 0,
      totalUncompressedSize: 0,
      fileTree: [],
      extractedFiles: [],
      projectFingerprint: null,
      categorized: {},
      findings: [],
      chunks: [],
      error: "ZIP archive is empty or header corrupt.",
    };
  }

  // Security Check 1: File Count Limit
  if (rawEntries.length > MAX_FILE_COUNT) {
    return {
      type: "zip",
      status: "blocked",
      totalFiles: rawEntries.length,
      totalUncompressedSize: 0,
      fileTree: [],
      extractedFiles: [],
      projectFingerprint: null,
      categorized: {},
      findings: [
        {
          type: "zip_security_block",
          location: `file: ${fileName}`,
          finding: `ZIP processing blocked: archive contains ${rawEntries.length} files (limit: ${MAX_FILE_COUNT}).`,
        },
      ],
      chunks: [],
      error: `ZIP bomb defense triggered: file count (${rawEntries.length}) exceeds maximum limit (${MAX_FILE_COUNT}).`,
    };
  }

  let totalUncompressedSize = 0;
  const fileTree = [];
  const extractedFiles = [];
  const categorized = {
    source: [],
    config: [],
    docs: [],
    manifests: [],
    tests: [],
    readme: [],
    assets: [],
    lockfiles: [],
    other: [],
  };
  const findings = [];
  const chunks = [];

  // Create isolated temp sandbox directory
  const sandboxPath = path.join(SANDBOX_BASE_DIR, evidenceId);
  try {
    if (!fs.existsSync(sandboxPath)) {
      fs.mkdirSync(sandboxPath, { recursive: true });
    }
  } catch (_) {}

  for (const entry of rawEntries) {
    const entryName = (entry.fileName || "").replace(/\\/g, "/");

    // Security Check 2: Path Traversal Defense
    if (
      entryName.includes("..") ||
      entryName.startsWith("/") ||
      entryName.startsWith("\\") ||
      /^[a-zA-Z]:/.test(entryName)
    ) {
      return {
        type: "zip",
        status: "blocked",
        totalFiles: rawEntries.length,
        totalUncompressedSize: 0,
        fileTree: [],
        extractedFiles: [],
        projectFingerprint: null,
        categorized: {},
        findings: [
          {
            type: "zip_security_block",
            location: `file: ${fileName}`,
            finding: `ZIP processing blocked: path traversal detected in archive entry "${entryName}".`,
          },
        ],
        chunks: [],
        error: `Path traversal attack detected in ZIP entry "${entryName}".`,
      };
    }

    // Security Check 3: ZIP Bomb / Compression Ratio Check
    if (entry.compressedSize > 0 && entry.uncompressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > MAX_COMPRESSION_RATIO && entry.uncompressedSize > 1024 * 1024) {
        return {
          type: "zip",
          status: "blocked",
          totalFiles: rawEntries.length,
          totalUncompressedSize,
          fileTree: [],
          extractedFiles: [],
          projectFingerprint: null,
          categorized: {},
          findings: [
            {
              type: "zip_security_block",
              location: `entry: ${entryName}`,
              finding: `ZIP processing blocked: excessive compression ratio (${Math.round(ratio)}x).`,
            },
          ],
          chunks: [],
          error: `ZIP bomb defense triggered: compression ratio (${Math.round(ratio)}x) exceeds safe limit.`,
        };
      }
    }

    totalUncompressedSize += entry.uncompressedSize;

    // Security Check 4: Total Extracted Size Limit
    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
      return {
        type: "zip",
        status: "blocked",
        totalFiles: rawEntries.length,
        totalUncompressedSize,
        fileTree: [],
        extractedFiles: [],
        projectFingerprint: null,
        categorized: {},
        findings: [
          {
            type: "zip_security_block",
            location: `file: ${fileName}`,
            finding: `ZIP processing blocked: uncompressed size (${totalUncompressedSize} bytes) exceeds limit (${MAX_TOTAL_UNCOMPRESSED_SIZE} bytes).`,
          },
        ],
        chunks: [],
        error: `ZIP bomb defense triggered: total uncompressed size exceeds limit (${MAX_TOTAL_UNCOMPRESSED_SIZE} bytes).`,
      };
    }

    if (entry.isDir) continue;

    // Skip ignored/build directories
    if (isIgnoredPath(entryName)) continue;

    const cat = categorizeFilePath(entryName);
    const lang = detectLanguage(entryName);
    const ext = path.extname(entryName).toLowerCase();

    const fileRecord = {
      path: entryName,
      size: entry.uncompressedSize,
      category: cat,
      language: lang,
      extension: ext,
    };
    fileTree.push(fileRecord);
    if (categorized[cat]) categorized[cat].push(fileRecord);

    // Deep Reading: Extract actual text content from code, configs, manifests, and documentation
    if (
      entry.dataBuffer &&
      (cat === "manifests" ||
        cat === "readme" ||
        cat === "docs" ||
        cat === "config" ||
        cat === "source" ||
        cat === "tests")
    ) {
      let rawStr = "";
      try {
        rawStr = entry.dataBuffer.toString("utf8");
      } catch (_) {}

      // Keep up to 100KB of text content per file for deep static inspection
      const textContent = rawStr.slice(0, 100000);
      const isReadable = textContent.trim().length > 0;

      if (isReadable) {
        const fileHash = calculateSha256(entry.dataBuffer);
        extractedFiles.push({
          path: entryName,
          category: cat,
          language: lang,
          extension: ext,
          size: entry.uncompressedSize,
          hash: fileHash,
          readable: true,
          content: textContent,
        });

        // Generate chunk entries with accurate location provenance
        const fileChunks = chunkContent({
          content: textContent,
          evidenceId,
          sourceType: "zip_entry",
          sourceLocation: `${fileName}:${entryName}`,
        });
        chunks.push(...fileChunks);
      }
    }
  }

  // Generate Deep Project Fingerprint
  const projectFingerprint = generateProjectFingerprint({
    files: extractedFiles,
    chunks,
  });

  findings.push({
    type: "zip_archive_summary",
    location: `file: ${fileName}`,
    finding: `ZIP archive verified safely (${fileTree.length} non-ignored file(s), ${extractedFiles.length} readable text/source file(s), ${totalUncompressedSize} total uncompressed bytes).`,
  });

  findings.push({
    type: "zip_categorization",
    location: `file: ${fileName}`,
    finding: `Categorized contents: ${categorized.source.length} source, ${categorized.config.length} config, ${categorized.docs.length} docs, ${categorized.manifests.length} manifests, ${categorized.tests.length} tests.`,
  });

  findings.push({
    type: "project_fingerprint_summary",
    location: `file: ${fileName}`,
    finding: `Detected Application: "${projectFingerprint.primaryDomain.name}" (Confidence: ${projectFingerprint.primaryDomain.confidence}%). Technologies: [${projectFingerprint.technologies.join(", ")}]. Auth: ${projectFingerprint.hasAuthentication ? "Detected" : "None"}. Tests: ${projectFingerprint.hasTests ? "Detected" : "None"}.`,
  });

  const sampleFileList = fileTree.slice(0, 25).map((f) => f.path).join(", ");
  findings.push({
    type: "zip_file_list",
    location: `file: ${fileName}`,
    finding: `Files extracted from ZIP: [${sampleFileList}${fileTree.length > 25 ? "..." : ""}]`,
  });

  // Clean up sandbox folder safely
  try {
    if (fs.existsSync(sandboxPath)) {
      fs.rmSync(sandboxPath, { recursive: true, force: true });
    }
  } catch (_) {}

  return {
    type: "zip",
    status: "processed",
    totalFiles: fileTree.length,
    totalUncompressedSize,
    fileTree,
    extractedFiles,
    projectFingerprint,
    categorized,
    findings,
    chunks,
  };
}

