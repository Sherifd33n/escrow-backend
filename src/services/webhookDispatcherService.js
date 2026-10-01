import crypto from "crypto";
import db from "../config/db.js";

/**
 * Dispatches HMAC-signed webhooks to external partner platforms.
 */
export async function dispatchPartnerWebhook({
  apiKeyId,
  webhookUrl,
  webhookSecret,
  eventType,
  transactionId = null,
  data = {},
}) {
  if (!webhookUrl) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    event: eventType,
    id: `evt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    timestamp,
    data,
  };

  const payloadString = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", webhookSecret || "lumbrr_secret")
    .update(`${timestamp}.${payloadString}`)
    .digest("hex");

  const headerSignature = `t=${timestamp},v1=${signature}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lumbrr-Signature": headerSignature,
        "X-Lumbrr-Event": eventType,
        "User-Agent": "Lumbrr-Webhook-Dispatcher/1.0",
      },
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseText = await response.text().catch(() => "");
    const status = response.ok ? "success" : "failed";

    if (apiKeyId) {
      await db.query(
        `INSERT INTO partner_webhooks_log 
         (api_key_id, event_type, transaction_id, target_url, payload, response_status, response_body, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          apiKeyId,
          eventType,
          transactionId,
          webhookUrl,
          JSON.stringify(payload),
          response.status,
          responseText.slice(0, 1000),
          status,
        ]
      );
    }

    return { success: response.ok, status: response.status };
  } catch (error) {
    console.warn(`[WebhookDispatcher] Failed to send ${eventType} to ${webhookUrl}:`, error.message);

    if (apiKeyId) {
      await db.query(
        `INSERT INTO partner_webhooks_log 
         (api_key_id, event_type, transaction_id, target_url, payload, response_status, response_body, status, attempts)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'failed', 1)`,
        [
          apiKeyId,
          eventType,
          transactionId,
          webhookUrl,
          JSON.stringify(payload),
          error.message.slice(0, 1000),
        ]
      ).catch(() => {});
    }

    return { success: false, error: error.message };
  }
}

export default {
  dispatchPartnerWebhook,
};
