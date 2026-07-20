/**
 * notificationService.js
 *
 * The single entry point for all notifications in the escrow backend.
 *
 * Usage:
 *   import { notify } from "../services/notificationService.js";
 *
 *   await notify({
 *     userId,
 *     type:  NOTIFICATION_TYPE.TRANSACTION_CREATED,
 *     data:  { transaction: tx.title, amount: tx.amount, code: tx.txn_code },
 *     email: true,   // honour user prefs and send email
 *     sms:   false,  // skip SMS for this call
 *     push:  true,   // honour user prefs and send push
 *   });
 *
 * Design principles:
 *  - Always saves an in-app notification to MySQL (the only failure that
 *    propagates to the caller).
 *  - Email / SMS / push failures are caught, logged, and never throw.
 *  - The caller does not need to know how notifications are delivered.
 *  - Socket.IO / WebSocket can be wired in at the "// REALTIME EXTENSION POINT"
 *    comment below with zero changes to callers.
 */

import db from "../config/db.js";
import { NOTIFICATION_CHANNEL } from "../constants/notificationTypes.js";
import {
  buildInAppContent,
  buildEmailContent,
  buildSmsContent,
} from "./notificationTemplates.js";
import { sendNotificationEmail } from "./emailService.js";
import { sendNotificationSMS } from "./smsService.js";
import { sendPushNotification } from "./pushService.js";
import { getUserNotificationPreferences } from "./notificationPreferenceService.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Persist a single notification row to MySQL.
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.type
 * @param {string}  opts.title
 * @param {string}  opts.message
 * @param {string}  opts.channel  - NOTIFICATION_CHANNEL value
 * @param {object}  [opts.metadata]
 * @returns {Promise<number>} insertId of the new row.
 */
async function persistNotification({
  userId,
  type,
  title,
  message,
  channel,
  metadata,
}) {
  const users = await db.query("SELECT id, email FROM users WHERE id = ?", [
    userId,
  ]);

  console.log("Notification sees user:", users);

  const [result] = await db.getPool().query(
    `INSERT INTO notifications
       (user_id, type, title, message, channel, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      type,
      title,
      message,
      channel,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );

  return result.insertId;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a notification across all requested channels.
 *
 * @param {object}  opts
 * @param {number}  opts.userId    - Recipient user ID.
 * @param {string}  opts.type      - NOTIFICATION_TYPE constant.
 * @param {object}  [opts.data]    - Template placeholder values.
 * @param {boolean} [opts.email]   - Attempt email (respects user prefs). Default false.
 * @param {boolean} [opts.sms]     - Attempt SMS (respects user prefs).   Default false.
 * @param {boolean} [opts.push]    - Attempt push (respects user prefs).  Default false.
 * @param {object}  [opts.metadata] - Extra JSON stored on the notification row.
 * @returns {Promise<{ id: number }>} The in-app notification id.
 */
export async function notify({
  userId,
  type,
  data = {},
  email = false,
  sms = false,
  push = false,
  metadata,
}) {
  // 1. Build in-app content from the template.
  const { title, message } = buildInAppContent(type, data);

  // 2. Save the in-app notification (this IS allowed to throw — it's a core
  //    DB write and callers should be aware if it fails).
  const id = await persistNotification({
    userId,
    type,
    title,
    message,
    channel: NOTIFICATION_CHANNEL.IN_APP,
    metadata,
  });

  // ── REALTIME EXTENSION POINT ─────────────────────────────────────────────
  // To push live updates via Socket.IO, emit here:
  //   if (global.io) {
  //     global.io.to(`user:${userId}`).emit("notification", { id, title, message, type });
  //   }
  // ─────────────────────────────────────────────────────────────────────────

  // 3. Fetch user preferences (non-critical — default to off on error).
  let prefs = { email: false, sms: false, push: false };
  try {
    prefs = await getUserNotificationPreferences(userId);
  } catch (err) {
    console.error(
      "[notificationService] Failed to load user prefs:",
      err.message,
    );
  }

  // 4. Fetch user contact details for email/SMS (only if needed).
  let userEmail = null;
  let userPhone = null;
  let userName = null;

  if ((email && prefs.email) || (sms && prefs.sms)) {
    try {
      const users = await db.query(
        "SELECT email, phone, name FROM users WHERE id = ?",
        [userId],
      );
      if (users.length) {
        userEmail = users[0].email;
        userPhone = users[0].phone;
        userName = users[0].name;
      }
    } catch (err) {
      console.error(
        "[notificationService] Failed to load user contact info:",
        err.message,
      );
    }
  }

  // Merge user name into template data so templates can use {{name}}.
  const tplData = userName ? { name: userName, ...data } : data;

  // 5. Email (non-fatal).
  if (email && prefs.email && userEmail) {
    const emailContent = buildEmailContent(type, tplData);
    if (emailContent) {
      // Fire-and-forget — don't await or let failures surface to the caller.
      sendNotificationEmail(
        userEmail,
        emailContent.subject,
        emailContent.html,
      ).catch((err) =>
        console.error(
          "[notificationService] Email dispatch error:",
          err.message,
        ),
      );
    }
  }

  // 6. SMS (non-fatal).
  if (sms && prefs.sms && userPhone) {
    const smsText = buildSmsContent(type, tplData);
    if (smsText) {
      sendNotificationSMS(userPhone, smsText).catch((err) =>
        console.error("[notificationService] SMS dispatch error:", err.message),
      );
    }
  }

  // 7. Push (non-fatal).
  if (push && prefs.push) {
    sendPushNotification({ userId, title, message, data: tplData }).catch(
      (err) =>
        console.error(
          "[notificationService] Push dispatch error:",
          err.message,
        ),
    );
  }

  return { id };
}

/**
 * Convenience helper: notify multiple users with the same event.
 *
 * @param {number[]} userIds
 * @param {object}   opts    - Same as notify() minus userId.
 */
export async function notifyMany(userIds, opts) {
  await Promise.all(userIds.map((userId) => notify({ userId, ...opts })));
}
