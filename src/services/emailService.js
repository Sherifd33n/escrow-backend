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

function getTransporter() {
  if (!transporter && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === "true" || port === 465;

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

export function isEmailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM
  );
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
  const activeTransporter = getTransporter();

  if (!activeTransporter) {
    console.warn(
      "[emailService] SMTP not configured (missing SMTP_HOST/USER/PASS) — skipping email to",
      to,
    );
    return false;
  }

  if (!process.env.SMTP_FROM) {
    console.warn("[emailService] SMTP_FROM not set — skipping email to", to);
    return false;
  }

  try {
    const info = await activeTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
    });

    console.log(`[emailService] Email sent successfully → ${to} | ${subject} (id: ${info?.messageId || "ok"})`);
    return true;
  } catch (err) {
    // Non-fatal — log and continue.
    console.error(`[emailService] Failed to send email to ${to} (${subject}):`, err.message);
    return false;
  }
}
