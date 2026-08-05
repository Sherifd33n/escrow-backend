/**
 * pushService.js
 *
 * WebPush notification gateway using standard VAPID protocol.
 * Delivers browser push notifications via Service Worker even when the app tab is closed.
 */

import webpush from "web-push";
import db from "../config/db.js";

// Initialize VAPID details if configured in environment
const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:support@escrow.com";

let pushConfigured = false;
if (vapidPublic && vapidPrivate) {
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    pushConfigured = true;
    console.log("[pushService] VAPID keys successfully configured.");
  } catch (err) {
    console.error("[pushService] Failed to set VAPID details:", err.message);
  }
} else {
  console.warn("[pushService] VAPID keys missing. Web Push disabled.");
}

/**
 * Save or update a user's browser push subscription.
 *
 * @param {number} userId
 * @param {object} subscription - { endpoint, keys: { p256dh, auth } }
 */
export async function saveSubscription(userId, subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error("Invalid push subscription payload.");
  }

  const { endpoint, keys } = subscription;
  const { p256dh, auth } = keys;

  // Avoid duplicate endpoints for the same user
  const existing = await db.query(
    "SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
    [userId, endpoint]
  );

  if (existing.length === 0) {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)`,
      [userId, endpoint, p256dh, auth]
    );
  } else {
    await db.query(
      `UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE id = ?`,
      [p256dh, auth, existing[0].id]
    );
  }

  return true;
}

/**
 * Remove a push subscription.
 *
 * @param {number} userId
 * @param {string} endpoint
 */
export async function removeSubscription(userId, endpoint) {
  await db.query(
    "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
    [userId, endpoint]
  );
}

/**
 * Send a WebPush notification to a user's active device subscriptions.
 *
 * @param {object} options
 * @param {number} options.userId - Recipient user ID.
 * @param {string} options.title - Push notification title.
 * @param {string} options.message - Push notification body.
 * @param {object} [options.data] - Optional metadata payload.
 */
export async function sendPushNotification({ userId, title, message, data = {} }) {
  if (!pushConfigured) {
    console.log(`[pushService] Skipped (not configured) → user=${userId}`);
    return false;
  }

  try {
    const subs = await db.query(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
      [userId]
    );

    if (!subs.length) return false;

    const payload = JSON.stringify({
      title,
      body: message,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: {
        url: "/dashboard",
        timestamp: new Date().toISOString(),
        ...data,
      },
    });

    const sendPromises = subs.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, payload);
      } catch (err) {
        // If subscription is expired / invalid (404 or 410 Gone), remove it
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log(`[pushService] Removing expired subscription ${sub.id}`);
          await db.query("DELETE FROM push_subscriptions WHERE id = ?", [sub.id]);
        } else {
          console.error(`[pushService] Error sending to sub ${sub.id}:`, err.message);
        }
      }
    });

    await Promise.all(sendPromises);
    return true;
  } catch (err) {
    console.error("[pushService] Send failed:", err.message);
    return false;
  }
}
