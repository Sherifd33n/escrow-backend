/**
 * notificationPreferenceService.js
 *
 * Reads the user's notification preference flags that are already stored on
 * the `users` row (notif_email, notif_sms, notif_push) and returns a simple
 * { email, sms, push } object.
 *
 * This keeps all preference logic in one place. If preferences are ever moved
 * to a separate table, only this file needs updating.
 */

import db from "../config/db.js";

/**
 * Fetch notification preferences for a user.
 *
 * The returned object reflects what the user has opted into.
 * In-app notifications are always enabled and are not gated here.
 *
 * @param {number} userId
 * @returns {Promise<{ email: boolean, sms: boolean, push: boolean }>}
 */
export async function getUserNotificationPreferences(userId) {
  const users = await db.query(
    "SELECT notif_email, notif_sms, notif_push FROM users WHERE id = ?",
    [userId],
  );

  if (!users.length) {
    // Safe default — only in-app if user doesn't exist somehow.
    return { email: false, sms: false, push: false };
  }

  const u = users[0];

  return {
    email: Boolean(u.notif_email),
    sms:   Boolean(u.notif_sms),
    push:  Boolean(u.notif_push),
  };
}
