/**
 * Utility to resolve request location dynamically.
 * Order of evaluation:
 * 1. Proxy/CDN geo headers (e.g. Cloudflare)
 * 2. Forwarded / Direct Request IP address
 * 3. Fallback "Unknown"
 *
 * @param {object} req - Express request object
 * @returns {string} Formatted location string
 */
export function getRequestLocation(req) {
  if (!req) return "Unknown";

  // 1. Forwarded Geo headers (e.g., Cloudflare, AWS CloudFront, etc.)
  const city = req.headers["cf-ipcity"] || req.headers["x-appengine-city"];
  const country = req.headers["cf-ipcountry"] || req.headers["x-appengine-country"];

  if (city && country) {
    return `${city}, ${country}`;
  }

  if (country) {
    return country;
  }

  // 2. Request IP address
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : req.ip || req.socket?.remoteAddress;

  if (ip) {
    if (ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1") {
      return "Local Network";
    }
    return `IP (${ip})`;
  }

  // 3. Fallback
  return "Unknown";
}
