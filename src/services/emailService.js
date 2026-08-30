/**
 * emailService.js
 *
 * Thin wrapper around the project's existing nodemailer transporter
 * (configured in utils/mailer.js).  All notification emails flow through
 * here so the template engine stays decoupled from the transport layer.
 *
 * Failures are caught and logged — they must NEVER throw or cause
 * a database rollback upstream.
 */

import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Shared transporter (mirrors the setup in utils/mailer.js so we reuse the
// same SMTP credentials without duplicating the configuration logic).
// ---------------------------------------------------------------------------
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ---------------------------------------------------------------------------
// sendNotificationEmail
// ---------------------------------------------------------------------------

/**
 * Send an HTML email notification.
 *
 * @param {string} to      - Recipient email address.
 * @param {string} subject - Email subject line.
 * @param {string} html    - Full HTML body.
 * @returns {Promise<boolean>} true on success, false if sending failed.
 */
export async function sendNotificationEmail(to, subject, html) {
  if (!transporter) {
    console.warn(
      "[emailService] SMTP not configured — skipping email to",
      to,
    );
    return false;
  }

  if (!process.env.SMTP_FROM) {
    console.warn("[emailService] SMTP_FROM not set — skipping email to", to);
    return false;
  }

  try {
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to,
      subject,
      html,
    });

    if (process.env.NODE_ENV !== "production") {
      console.log(`[emailService] Email sent → ${to} | ${subject}`);
    }

    return true;
  } catch (err) {
    // Non-fatal — log and continue.
    console.error("[emailService] Failed to send email to", to, "—", err.message);
    return false;
  }
}
