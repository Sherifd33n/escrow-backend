/**
 * pushService.js
 *
 * Provider-agnostic push notification gateway.
 *
 * Architecture is designed so that adding Firebase Cloud Messaging (or any
 * other push provider) only requires editing this file:
 *   1. Import the FCM admin SDK.
 *   2. Initialise it from env vars.
 *   3. Replace the placeholder implementation in send().
 *
 * Extension point: the `notificationService` calls this with
 * { userId, title, message, data } so the push service can look up the
 * user's device token(s) from a future `push_tokens` table.
 *
 * Failures are caught and logged — they NEVER throw or roll back
 * database transactions upstream.
 */

// ---------------------------------------------------------------------------
// Provider initialisation placeholder
// ---------------------------------------------------------------------------

// Example FCM bootstrap (uncomment and complete when Firebase is added):
// import admin from "firebase-admin";
// if (process.env.FIREBASE_SERVICE_ACCOUNT) {
//   admin.initializeApp({
//     credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
//   });
// }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a push notification to a user.
 *
 * @param {object}  options
 * @param {number}  options.userId  - Recipient user ID (used to look up device tokens).
 * @param {string}  options.title   - Notification title.
 * @param {string}  options.message - Notification body.
 * @param {object}  [options.data]  - Optional key-value payload.
 * @returns {Promise<boolean>} true on success, false on failure / not configured.
 */
export async function sendPushNotification({ userId, title, message, data = {} }) {
  // ── Extension point ────────────────────────────────────────────────────────
  // When a push provider is configured:
  // 1. Query `push_tokens` WHERE user_id = userId to get device tokens.
  // 2. Send multicast message via the provider SDK.
  // 3. Handle expired/invalid tokens (remove them from the table).
  // ──────────────────────────────────────────────────────────────────────────

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[pushService] PUSH (not yet configured) → user=${userId} | "${title}"`,
    );
  }

  return false; // Returns false until a provider is configured.
}
