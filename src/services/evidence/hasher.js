/**
 * hasher.js
 * Stage 2 — SHA-256 Evidence Hashing Module
 *
 * Calculates deterministic SHA-256 hex hashes for file buffers and strings.
 */

import crypto from "crypto";

/**
 * Calculates SHA-256 hash of a Buffer or string.
 *
 * @param {Buffer|string} input
 * @returns {string} SHA-256 hex string (64 characters)
 */
export function calculateSha256(input) {
  if (!input) return "";
  const hash = crypto.createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}
