import { getApiKeyDetails } from "../services/apiKeyService.js";

/**
 * Middleware for authenticating third-party external platforms via API Key.
 * Supports:
 *   - Authorization: Bearer lmb_test_... or sk_test_...
 *   - X-API-Key: lmb_test_...
 */
export async function apiKeyAuth(req, res, next) {
  try {
    let key = null;

    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      key = authHeader.substring(7).trim();
    } else if (req.headers["x-api-key"]) {
      key = req.headers["x-api-key"].trim();
    }

    if (!key) {
      return res.status(401).json({
        success: false,
        error: "API Key required. Provide 'Authorization: Bearer <your_key>' or 'X-API-Key: <your_key>' header.",
        code: "UNAUTHORIZED_API_KEY",
      });
    }

    const keyDetails = await getApiKeyDetails(key);
    if (!keyDetails) {
      return res.status(401).json({
        success: false,
        error: "Invalid or inactive API Key. Please check your developer dashboard.",
        code: "INVALID_API_KEY",
      });
    }

    // Attach API context to request
    req.apiKey = keyDetails;
    req.apiPartner = keyDetails.owner;
    req.user = keyDetails.owner; // Provide fallback user context for underlying services

    next();
  } catch (error) {
    console.error("[apiKeyAuth] Verification error:", error);
    res.status(500).json({
      success: false,
      error: "Authentication service error.",
    });
  }
}

export default apiKeyAuth;
