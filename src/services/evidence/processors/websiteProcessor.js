/**
 * websiteProcessor.js
 * Stage 2 — Website / Staging URL Evidence Processor Module
 *
 * Inspects staging or website URLs safely using SSRF-protected HTTP requests,
 * captures HTTP status codes, final redirect URLs, page titles, and basic DOM text.
 */

import { validateUrlForSsrf, safeFetchUrl } from "../ssrfValidator.js";
import { chunkContent } from "../chunker.js";

/**
 * Parses page title from HTML string.
 *
 * @param {string} html
 * @returns {string|null}
 */
function parseHtmlTitle(html) {
  if (!html) return null;
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Extracts visible plain text snippet from HTML string.
 *
 * @param {string} html
 * @returns {string} Cleaned text snippet
 */
function extractHtmlSnippet(html) {
  if (!html) return "";
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.substring(0, 2000);
}

/**
 * Process a staging or website URL evidence item.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.evidenceId
 * @returns {Promise<{
 *   type: "staging_url",
 *   status: "processed" | "blocked" | "failed",
 *   url: string,
 *   httpStatus: number,
 *   reachable: boolean,
 *   title: string|null,
 *   finalUrl: string,
 *   findings: Array<object>,
 *   chunks: Array<object>,
 *   error?: string
 * }>}
 */
export async function processWebsite({ url, evidenceId }) {
  // 1. SSRF Validation
  const ssrfCheck = await validateUrlForSsrf(url);
  if (!ssrfCheck.valid) {
    return {
      type: "staging_url",
      status: "blocked",
      url,
      httpStatus: 0,
      reachable: false,
      title: null,
      finalUrl: url,
      findings: [
        {
          type: "website_security_block",
          location: `url: ${url}`,
          finding: `Website URL blocked by SSRF protection: ${ssrfCheck.reason}`,
        },
      ],
      chunks: [],
      error: ssrfCheck.reason,
    };
  }

  try {
    const response = await safeFetchUrl(url, { timeoutMs: 6000, maxSize: 2 * 1024 * 1024 });
    const html = response.body.toString("utf8");
    const title = parseHtmlTitle(html);
    const textSnippet = extractHtmlSnippet(html);

    const findings = [];
    const isSuccess = response.statusCode >= 200 && response.statusCode < 400;

    findings.push({
      type: "website_reachability",
      location: `url: ${response.finalUrl}`,
      finding: `Staging site checked (HTTP Status: ${response.statusCode}, Reachable: ${isSuccess}).`,
    });

    if (title) {
      findings.push({
        type: "website_title",
        location: `url: ${response.finalUrl}`,
        finding: `Page Title: "${title}"`,
      });
    }

    const chunks = textSnippet
      ? chunkContent({
          content: textSnippet,
          evidenceId,
          sourceType: "staging_url",
          sourceLocation: response.finalUrl,
        })
      : [];

    return {
      type: "staging_url",
      status: "processed",
      url,
      httpStatus: response.statusCode,
      reachable: isSuccess,
      title,
      finalUrl: response.finalUrl,
      findings,
      chunks,
    };
  } catch (err) {
    if (err.code === "SSRF_BLOCKED") throw err;

    return {
      type: "staging_url",
      status: "failed",
      url,
      httpStatus: 0,
      reachable: false,
      title: null,
      finalUrl: url,
      findings: [
        {
          type: "website_error",
          location: `url: ${url}`,
          finding: `Failed to connect to staging site: ${err.message}`,
        },
      ],
      chunks: [],
      error: err.message,
    };
  }
}
