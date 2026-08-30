/**
 * smsService.js
 *
 * Provider-agnostic SMS gateway.
 * The active provider is selected at boot time from SMS_PROVIDER env var.
 * Adding a new provider only requires:
 *   1. Create services/sms/<provider>.js that exports sendSMS(phone, msg).
 *   2. Add a case to the switch below.
 *
 * Failures are caught and logged — they NEVER throw or roll back
 * database transactions upstream.
 */

import { sendSMS as mockSend }   from "./sms/mock.js";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------
const PROVIDERS = {
  mock: mockSend,
  // twilio: twilioSend,    // import and add when ready
  // termii: termiiSend,    // import and add when ready
  // africastalking: atSend, // import and add when ready
};

const provider = PROVIDERS[process.env.SMS_PROVIDER] || mockSend;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an SMS message.
 *
 * @param {string} phone   - E.164 phone number, e.g. "+2348012345678".
 * @param {string} message - Plain-text message body.
 * @returns {Promise<boolean>} true on success, false on failure.
 */
export async function sendNotificationSMS(phone, message) {
  if (!phone) {
    console.warn("[smsService] No phone number provided — skipping SMS.");
    return false;
  }

  try {
    await provider(phone, message);
    return true;
  } catch (err) {
    // Non-fatal — log and continue.
    console.error("[smsService] Failed to send SMS to", phone, "—", err.message);
    return false;
  }
}
