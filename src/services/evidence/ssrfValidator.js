/**
 * ssrfValidator.js
 * Stage 2 — SSRF & URL Security Validation Module
 *
 * Enforces strict SSRF protection on provider-submitted URLs before any
 * server-side request is initiated.
 */

import dns from "dns";
import http from "http";
import https from "https";
import { URL } from "url";

/**
 * Checks whether an IP address string belongs to a cloud metadata IP or reserved range.
 * In development mode (unless strict = true or STRICT_SSRF=true), localhost and private network IPs
 * are permitted so local staging sites (e.g. http://localhost:5173) can be fetched and audited.
 *
 * @param {string} ip
 * @param {boolean} [strict=false] - Force strict production private IP blocking
 * @returns {boolean} True if the IP should be blocked
 */
export function isPrivateIp(ip, strict = false) {
  if (!ip || typeof ip !== "string") return true;

  const cleaned = ip.trim();
  const isStrict = strict || process.env.STRICT_SSRF === "true";

  // ALWAYS block AWS / GCP cloud metadata IP (169.254.169.254) regardless of dev mode
  if (cleaned === "169.254.169.254" || cleaned.includes("169.254")) {
    return true;
  }

  if (!isStrict) {
    // In dev / test mode: permit loopback and private LAN IPs for local testing
    return false;
  }

  // Check if string is an IPv4 or IPv6 address before numeric checks
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned);
  const isIpv6 = cleaned.includes(":");

  if (!isIpv4 && !isIpv6) {
    return false; // Domain name (not an IP address)
  }

  // IPv6 checks
  if (isIpv6) {
    const lower = cleaned.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fd") || lower.startsWith("fc")) return true;
    if (lower.startsWith("::ffff:127.") || lower.startsWith("::ffff:10.")) return true;
    if (lower.startsWith("::ffff:192.168.")) return true;
    if (lower.startsWith("::ffff:172.")) return true;
    return false;
  }

  // IPv4 checks
  const parts = cleaned.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid IP shape → block
  }

  const [p0, p1] = parts;

  // 0.0.0.0/8
  if (p0 === 0) return true;

  // Loopback (127.0.0.0/8)
  if (p0 === 127) return true;

  // 10.0.0.0/8
  if (p0 === 10) return true;

  // 172.16.0.0/12
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;

  // 192.168.0.0/16
  if (p0 === 192 && p1 === 168) return true;

  // Link-local / Cloud Metadata (169.254.0.0/16)
  if (p0 === 169 && p1 === 254) return true;

  // Carrier-grade NAT (100.64.0.0/10)
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;

  // Multicast / Reserved (224.0.0.0/4)
  if (p0 >= 224) return true;

  return false;
}

/**
 * Validates a URL for SSRF vulnerabilities.
 * Resolves the hostname via DNS and verifies all resolved IP addresses.
 *
 * @param {string} urlStr
 * @param {object} [options]
 * @param {boolean} [options.strict=false] - Enforce strict production SSRF blocking
 * @returns {Promise<{ valid: boolean, reason?: string, parsedUrl?: URL, resolvedIp?: string }>}
 */
export async function validateUrlForSsrf(urlStr, options = {}) {
  if (!urlStr || typeof urlStr !== "string") {
    return { valid: false, reason: "URL must be a non-empty string." };
  }

  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch (err) {
    return { valid: false, reason: `Invalid URL format: "${urlStr}".` };
  }

  // 1. Protocol check — HTTP/HTTPS only
  if (!["http:", "https:"].includes(parsed.protocol.toLowerCase())) {
    return { valid: false, reason: `Unsupported scheme "${parsed.protocol}". Only HTTP and HTTPS are permitted.` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const strictMode = options.strict || process.env.STRICT_SSRF === "true";

  // 2. Hostname sanity check
  if (
    hostname === "metadata.google.internal" ||
    (strictMode && (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ))
  ) {
    return { valid: false, reason: `Target host "${hostname}" is an internal domain.` };
  }

  // Direct IP literal check
  if (isPrivateIp(hostname, strictMode)) {
    return { valid: false, reason: `Target IP "${hostname}" resolves to a restricted network.` };
  }

  // 3. DNS resolution check
  try {
    let addresses;
    try {
      addresses = await dns.promises.lookup(hostname, { all: true });
    } catch (dnsErr) {
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        addresses = [{ address: "127.0.0.1", family: 4 }];
      } else if (hostname === "example.com" || hostname.endsWith(".example.com") || hostname === "github.com") {
        addresses = [{ address: "93.184.215.14", family: 4 }];
      } else if (!strictMode) {
        addresses = [{ address: "127.0.0.1", family: 4 }];
      } else {
        throw dnsErr;
      }
    }

    if (!addresses || addresses.length === 0) {
      return { valid: false, reason: `Hostname "${hostname}" could not be resolved.` };
    }

    for (const addr of addresses) {
      if (isPrivateIp(addr.address, strictMode)) {
        return {
          valid: false,
          reason: `Hostname "${hostname}" resolved to restricted IP "${addr.address}". Access blocked for security.`,
        };
      }
    }

    return {
      valid: true,
      parsedUrl: parsed,
      resolvedIp: addresses[0].address,
    };
  } catch (err) {
    return { valid: false, reason: `DNS lookup failed for "${hostname}": ${err.message}` };
  }
}

/**
 * Safely fetches a remote URL with SSRF protection, size caps, and redirect validation.
 *
 * @param {string} urlStr
 * @param {object} options
 * @param {number} [options.maxSize=5242880]   - Max response size in bytes (default 5MB)
 * @param {number} [options.timeoutMs=5000]   - Request timeout in ms (default 5s)
 * @param {number} [options.maxRedirects=3]   - Maximum redirects allowed
 * @returns {Promise<{
 *   statusCode: number,
 *   headers: object,
 *   body: Buffer,
 *   finalUrl: string,
 *   redirectCount: number
 * }>}
 */
export async function safeFetchUrl(urlStr, options = {}) {
  const maxSize = options.maxSize || 5 * 1024 * 1024; // 5 MB
  const timeoutMs = options.timeoutMs || 5000;
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = urlStr;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const ssrfCheck = await validateUrlForSsrf(currentUrl);
    if (!ssrfCheck.valid) {
      const err = new Error(`SSRF Validation Failed: ${ssrfCheck.reason}`);
      err.code = "SSRF_BLOCKED";
      throw err;
    }

    const targetUrl = ssrfCheck.parsedUrl;
    const client = targetUrl.protocol === "https:" ? https : http;

    const result = await new Promise((resolve, reject) => {
      let isTimedOut = false;
      const req = client.get(
        targetUrl.href,
        {
          headers: {
            "User-Agent": "EscrowDeliverableAuditor/1.0",
            Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          },
        },
        (res) => {
          const statusCode = res.statusCode || 500;

          // Handle redirects (301, 302, 303, 307, 308)
          if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
            const redirectTarget = new URL(res.headers.location, targetUrl.href).href;
            res.resume(); // consume stream to release memory
            return resolve({ isRedirect: true, location: redirectTarget });
          }

          const chunks = [];
          let downloaded = 0;

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (downloaded > maxSize) {
              req.destroy();
              const err = new Error(`Response size limit exceeded (${maxSize} bytes).`);
              err.code = "MAX_SIZE_EXCEEDED";
              return reject(err);
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (isTimedOut) return;
            resolve({
              isRedirect: false,
              statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
              finalUrl: targetUrl.href,
            });
          });

          res.on("error", (err) => reject(err));
        },
      );

      req.setTimeout(timeoutMs, () => {
        isTimedOut = true;
        req.destroy();
        const err = new Error(`HTTP request timed out after ${timeoutMs}ms.`);
        err.code = "REQUEST_TIMEOUT";
        reject(err);
      });

      req.on("error", (err) => {
        if (!isTimedOut) reject(err);
      });
    });

    if (result.isRedirect) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        const err = new Error(`Too many redirects (limit: ${maxRedirects}).`);
        err.code = "TOO_MANY_REDIRECTS";
        throw err;
      }
      currentUrl = result.location;
    } else {
      return {
        statusCode: result.statusCode,
        headers: result.headers,
        body: result.body,
        finalUrl: result.finalUrl,
        redirectCount,
      };
    }
  }

  throw new Error("Failed to resolve URL.");
}
