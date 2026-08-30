/**
 * secretDetector.js
 * Stage 4 — Security Hardening: Exposed Secret Detection & Redaction Module
 *
 * Scans evidence documents, text, code, and findings for exposed API keys, private tokens,
 * database URIs, or credentials. Redacts raw secret values before logging or passing
 * context to AI prompts to prevent credential leaks.
 */

const SECRET_PATTERNS = [
  { name: "Stripe Secret Key", regex: /\b(sk_live_[0-9a-zA-Z]{24,99})\b/g, redactPrefix: "sk_live_****" },
  { name: "AWS Access Key", regex: /\b(AKIA[0-9A-Z]{16})\b/g, redactPrefix: "AKIA****" },
  { name: "OpenAI/Groq API Key", regex: /\b(sk-[0-9a-zA-Z]{32,60})\b/g, redactPrefix: "sk-****" },
  { name: "GitHub Personal Token", regex: /\b(ghp_[0-9a-zA-Z]{36})\b/g, redactPrefix: "ghp_****" },
  { name: "Generic Bearer Token", regex: /\bBearer\s+([a-zA-Z0-9._-]{20,})\b/g, redactPrefix: "Bearer ****" },
  { name: "Database Connection String", regex: /\b(postgres|mongodb|mysql|redis):\/\/([^:\s]+):([^@\s]+)@/gi, redactPrefix: "$1://$2:****@" },
  { name: "RSA Private Key", regex: /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA )?PRIVATE KEY-----/g, redactPrefix: "[REDACTED RSA PRIVATE KEY]" },
];

/**
 * Scans text for exposed credentials and produces redacted text & findings.
 *
 * @param {string} text
 * @param {string} [location="file"]
 * @returns {{
 *   hasSecrets: boolean,
 *   redactedText: string,
 *   findings: Array<{ type: "secret_detected", location: string, finding: string, secretType: string }>
 * }}
 */
export function detectAndRedactSecrets(text, location = "file") {
  if (!text || typeof text !== "string") {
    return { hasSecrets: false, redactedText: "", findings: [] };
  }

  let redactedText = text;
  const findings = [];

  SECRET_PATTERNS.forEach((pattern) => {
    let match;
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

    while ((match = regex.exec(text)) !== null) {
      findings.push({
        type: "secret_detected",
        location,
        finding: `Potential ${pattern.name} detected and redacted from audit context.`,
        secretType: pattern.name,
      });
    }

    redactedText = redactedText.replace(pattern.regex, pattern.redactPrefix);
  });

  return {
    hasSecrets: findings.length > 0,
    redactedText,
    findings,
  };
}
