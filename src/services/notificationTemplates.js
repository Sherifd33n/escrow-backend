/**
 * notificationTemplates.js
 *
 * Centralised templates for all notification types.
 * Returns { title, message, emailSubject?, emailBody?, smsText? }
 *
 * All string interpolation uses a simple {{key}} replacement so
 * templates never execute arbitrary code.
 */

import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";

// ---------------------------------------------------------------------------
// Simple interpolation helper — replaces {{key}} with data[key].
// ---------------------------------------------------------------------------
function fill(template, data = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    data[key] !== undefined ? String(data[key]) : `{{${key}}}`,
  );
}

// ---------------------------------------------------------------------------
// Shared email wrapper (matches the existing brand style in mailer.js)
// ---------------------------------------------------------------------------
function emailWrap(subject, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="margin:0;padding:40px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;">
<table style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.08);">
  <tr>
    <td style="background:#001637;padding:24px;text-align:center;color:#ffffff;font-size:28px;font-weight:bold;letter-spacing:1px;">
      ESCROW
    </td>
  </tr>
  <tr>
    <td style="padding:40px;">
      ${bodyContent}
    </td>
  </tr>
  <tr>
    <td style="padding:20px;background:#f7f7f7;text-align:center;font-size:13px;color:#999;">
      © ${new Date().getFullYear()} Escrow. All rights reserved.
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------
const TEMPLATES = {
  [NOTIFICATION_TYPE.WELCOME]: {
    title:        "Welcome to Escrow",
    message:      "Welcome, {{name}}! Your account has been created successfully.",
    emailSubject: "Welcome to Escrow — Let's get started",
    emailBody: (d) => emailWrap("Welcome to Escrow", `
      <h2 style="margin-top:0;color:#001637;">Welcome, ${d.name}!</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        Your account has been created successfully. You can now create secure
        escrow transactions, fund milestones, and trade with confidence.
      </p>
      <p style="font-size:14px;color:#999;line-height:1.8;">
        If you have any questions, simply reply to this email.
      </p>`),
    smsText: "Welcome to Escrow, {{name}}! Your account is ready.",
  },

  [NOTIFICATION_TYPE.OTP_SENT]: {
    title:        "Your OTP Code",
    message:      "Your verification code is {{code}}. It expires in {{expiry}} minutes.",
    emailSubject: "Escrow — Your Verification Code",
    emailBody: (d) => emailWrap("Your Verification Code", `
      <h2 style="margin-top:0;color:#001637;">Verification Code</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">Use the code below to verify your account.</p>
      <div style="margin:35px 0;text-align:center;">
        <div style="display:inline-block;padding:18px 35px;background:#eef3fb;border-radius:8px;font-size:36px;font-weight:bold;letter-spacing:8px;color:#001637;">
          ${d.code}
        </div>
      </div>
      <p style="color:#666;font-size:15px;line-height:1.8;">This code expires in <strong>${d.expiry} minutes.</strong></p>
      <p style="font-size:14px;color:#999;line-height:1.8;">If you didn't request this, you can safely ignore it.</p>`),
    smsText: "Your Escrow OTP is {{code}}. Expires in {{expiry}} minutes. Do not share.",
  },

  [NOTIFICATION_TYPE.PASSWORD_RESET]: {
    title:        "Password Reset",
    message:      "A password reset link has been sent to your email.",
    emailSubject: "Escrow — Reset Your Password",
    emailBody: (d) => emailWrap("Reset Your Password", `
      <h2 style="margin-top:0;color:#001637;">Reset Your Password</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        Click below to reset your password. The link expires in <strong>${d.expiry} minutes</strong>.
      </p>
      <div style="text-align:center;margin:35px 0;">
        <a href="${d.link}" style="display:inline-block;padding:16px 40px;background:#001637;color:#ffffff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">
          Reset Password
        </a>
      </div>
      <p style="font-size:14px;color:#999;line-height:1.8;">
        If you did not request a password reset, you can safely ignore this email.
      </p>`),
    smsText: "Escrow password reset requested. Check your email for the reset link.",
  },

  [NOTIFICATION_TYPE.SECURITY_ALERT]: {
    title:        "Security Alert",
    message:      "A new login was detected on your account from {{device}}.",
    emailSubject: "Escrow — New Login Detected",
    emailBody: (d) => emailWrap("Security Alert", `
      <h2 style="margin-top:0;color:#c0392b;">Security Alert</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        A new login was detected on your account:
      </p>
      <ul style="font-size:15px;color:#333;line-height:2;">
        <li><strong>Device:</strong> ${d.device}</li>
        <li><strong>Time:</strong> ${d.time || "Just now"}</li>
      </ul>
      <p style="font-size:14px;color:#999;line-height:1.8;">
        If this wasn't you, please change your password immediately.
      </p>`),
    smsText: "Escrow: New login on your account from {{device}}. Not you? Change your password.",
  },

  [NOTIFICATION_TYPE.TRANSACTION_CREATED]: {
    title:        "Transaction Created",
    message:      "Transaction \"{{transaction}}\" for ${{amount}} has been created.",
    emailSubject: "Escrow — New Transaction Created",
    emailBody: (d) => emailWrap("Transaction Created", `
      <h2 style="margin-top:0;color:#001637;">Transaction Created</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        A new escrow transaction has been created.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:10px;color:#555;font-size:14px;border-bottom:1px solid #eee;"><strong>Title</strong></td><td style="padding:10px;font-size:14px;border-bottom:1px solid #eee;">${d.transaction}</td></tr>
        <tr><td style="padding:10px;color:#555;font-size:14px;border-bottom:1px solid #eee;"><strong>Amount</strong></td><td style="padding:10px;font-size:14px;border-bottom:1px solid #eee;">$${d.amount}</td></tr>
        <tr><td style="padding:10px;color:#555;font-size:14px;"><strong>Code</strong></td><td style="padding:10px;font-size:14px;">${d.code || "—"}</td></tr>
      </table>
      <p style="font-size:14px;color:#999;line-height:1.8;">Log in to your dashboard to take action.</p>`),
    smsText: "Escrow: Transaction \"{{transaction}}\" for ${{amount}} created. Ref: {{code}}.",
  },

  [NOTIFICATION_TYPE.TRANSACTION_FUNDED]: {
    title:        "Escrow Funded",
    message:      "Milestone funded for \"{{transaction}}\" — ${{amount}} is now in escrow.",
    emailSubject: "Escrow — Funds Received",
    emailBody: (d) => emailWrap("Escrow Funded", `
      <h2 style="margin-top:0;color:#001637;">Escrow Funded</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        A milestone for <strong>${d.transaction}</strong> has been funded.
        <strong>$${d.amount}</strong> is now held in escrow.
      </p>
      <p style="font-size:14px;color:#999;">You can now begin work on this milestone.</p>`),
    smsText: "Escrow: ${{amount}} funded for \"{{transaction}}\". Funds held in escrow.",
  },

  [NOTIFICATION_TYPE.TRANSACTION_STARTED]: {
    title:        "Work Started",
    message:      "Work has started on transaction \"{{transaction}}\".",
    emailSubject: "Escrow — Work Has Started",
    emailBody: (d) => emailWrap("Work Started", `
      <h2 style="margin-top:0;color:#001637;">Work Has Started</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        The seller has started work on <strong>${d.transaction}</strong>.
      </p>`),
    smsText: "Escrow: Work started on \"{{transaction}}\".",
  },

  [NOTIFICATION_TYPE.TRANSACTION_STATUS_CHANGED]: {
    title:        "Transaction Updated",
    message:      "Transaction \"{{transaction}}\" moved to {{status}}.",
    emailSubject: "Escrow — Transaction Status Updated",
    emailBody: (d) => emailWrap("Transaction Status Updated", `
      <h2 style="margin-top:0;color:#001637;">Transaction Updated</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>${d.transaction}</strong> has moved from
        <strong>${d.fromStatus || "—"}</strong> to <strong>${d.status}</strong>.
      </p>
      ${d.note ? `<p style="font-size:14px;color:#666;">${d.note}</p>` : ""}`),
    smsText: "Escrow: \"{{transaction}}\" status → {{status}}.",
  },

  [NOTIFICATION_TYPE.TRANSACTION_COMPLETED]: {
    title:        "Transaction Completed",
    message:      "Transaction \"{{transaction}}\" has been completed successfully.",
    emailSubject: "Escrow — Transaction Completed 🎉",
    emailBody: (d) => emailWrap("Transaction Completed", `
      <h2 style="margin-top:0;color:#27ae60;">Transaction Completed 🎉</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>${d.transaction}</strong> has been completed successfully.
        Funds have been released to the seller.
      </p>`),
    smsText: "Escrow: \"{{transaction}}\" completed successfully.",
  },

  [NOTIFICATION_TYPE.MILESTONE_DUE]: {
    title:        "Milestone Due",
    message:      "Milestone \"{{milestone}}\" in \"{{transaction}}\" is now due.",
    emailSubject: "Escrow — Milestone Due",
    emailBody: (d) => emailWrap("Milestone Due", `
      <h2 style="margin-top:0;color:#e67e22;">Milestone Due</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>${d.milestone}</strong> in transaction <strong>${d.transaction}</strong>
        is now due for payment.
      </p>`),
    smsText: "Escrow: Milestone \"{{milestone}}\" in \"{{transaction}}\" is now due.",
  },

  [NOTIFICATION_TYPE.MILESTONE_PAID]: {
    title:        "Milestone Paid",
    message:      "Milestone \"{{milestone}}\" has been funded — ${{amount}} in escrow.",
    emailSubject: "Escrow — Milestone Funded",
    emailBody: (d) => emailWrap("Milestone Funded", `
      <h2 style="margin-top:0;color:#001637;">Milestone Funded</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        Milestone <strong>${d.milestone}</strong> has been funded.
        <strong>$${d.amount}</strong> is now held in escrow.
      </p>`),
    smsText: "Escrow: Milestone \"{{milestone}}\" funded — ${{amount}} in escrow.",
  },

  [NOTIFICATION_TYPE.MILESTONE_SUBMITTED]: {
    title:        "Deliverable Submitted",
    message:      "Seller submitted a deliverable for milestone \"{{milestone}}\".",
    emailSubject: "Escrow — Deliverable Submitted for Review",
    emailBody: (d) => emailWrap("Deliverable Submitted", `
      <h2 style="margin-top:0;color:#001637;">Deliverable Submitted</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        The seller has submitted a deliverable for milestone
        <strong>${d.milestone}</strong> in <strong>${d.transaction}</strong>.
        Please review and approve or request a revision.
      </p>
      ${d.note ? `<blockquote style="border-left:3px solid #ccc;margin:16px 0;padding:10px 16px;color:#666;font-size:14px;">${d.note}</blockquote>` : ""}`),
    smsText: "Escrow: Deliverable submitted for \"{{milestone}}\". Please review.",
  },

  [NOTIFICATION_TYPE.MILESTONE_APPROVED]: {
    title:        "Milestone Approved",
    message:      "Milestone \"{{milestone}}\" has been approved.",
    emailSubject: "Escrow — Milestone Approved",
    emailBody: (d) => emailWrap("Milestone Approved", `
      <h2 style="margin-top:0;color:#27ae60;">Milestone Approved ✓</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        Milestone <strong>${d.milestone}</strong> in <strong>${d.transaction}</strong>
        has been approved by the buyer.
      </p>`),
    smsText: "Escrow: Milestone \"{{milestone}}\" approved.",
  },

  [NOTIFICATION_TYPE.MILESTONE_REJECTED]: {
    title:        "Milestone Rejected",
    message:      "Milestone \"{{milestone}}\" was rejected. Revision requested.",
    emailSubject: "Escrow — Milestone Revision Requested",
    emailBody: (d) => emailWrap("Revision Requested", `
      <h2 style="margin-top:0;color:#c0392b;">Revision Requested</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        The buyer has requested a revision on milestone
        <strong>${d.milestone}</strong> in <strong>${d.transaction}</strong>.
      </p>
      ${d.note ? `<blockquote style="border-left:3px solid #e74c3c;margin:16px 0;padding:10px 16px;color:#666;font-size:14px;">${d.note}</blockquote>` : ""}`),
    smsText: "Escrow: Revision requested on milestone \"{{milestone}}\".",
  },

  [NOTIFICATION_TYPE.DISPUTE_FILED]: {
    title:        "Dispute Filed",
    message:      "A dispute has been filed for transaction \"{{transaction}}\".",
    emailSubject: "Escrow — Dispute Filed",
    emailBody: (d) => emailWrap("Dispute Filed", `
      <h2 style="margin-top:0;color:#c0392b;">Dispute Filed</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        A dispute has been filed for transaction <strong>${d.transaction}</strong>.
      </p>
      <p style="font-size:15px;color:#666;line-height:1.8;"><strong>Reason:</strong> ${d.reason}</p>
      <p style="font-size:14px;color:#999;">Our team will review the case within 5 business days.</p>`),
    smsText: "Escrow: A dispute was filed for \"{{transaction}}\". Our team will review.",
  },

  [NOTIFICATION_TYPE.DISPUTE_RESOLVED]: {
    title:        "Dispute Resolved",
    message:      "Dispute for \"{{transaction}}\" has been resolved. Winner: {{winner}}.",
    emailSubject: "Escrow — Dispute Resolved",
    emailBody: (d) => emailWrap("Dispute Resolved", `
      <h2 style="margin-top:0;color:#001637;">Dispute Resolved</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        The dispute for transaction <strong>${d.transaction}</strong> has been resolved.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:10px;color:#555;font-size:14px;border-bottom:1px solid #eee;"><strong>Decision</strong></td><td style="padding:10px;font-size:14px;border-bottom:1px solid #eee;">${d.resolution}</td></tr>
        <tr><td style="padding:10px;color:#555;font-size:14px;"><strong>Winner</strong></td><td style="padding:10px;font-size:14px;text-transform:capitalize;">${d.winner}</td></tr>
      </table>`),
    smsText: "Escrow: Dispute for \"{{transaction}}\" resolved. Winner: {{winner}}.",
  },

  [NOTIFICATION_TYPE.REVIEW_RECEIVED]: {
    title:        "New Review",
    message:      "You received a {{rating}}-star review from {{reviewer}}.",
    emailSubject: "Escrow — You Have a New Review",
    emailBody: (d) => emailWrap("New Review Received", `
      <h2 style="margin-top:0;color:#001637;">New Review</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>${d.reviewer}</strong> left you a review for transaction
        <strong>${d.transaction}</strong>.
      </p>
      <div style="margin:20px 0;font-size:28px;">
        ${"★".repeat(d.rating)}${"☆".repeat(5 - d.rating)}
        <span style="font-size:18px;color:#001637;font-weight:bold;margin-left:8px;">${d.rating}/5</span>
      </div>
      ${d.comment ? `<blockquote style="border-left:3px solid #ddd;margin:16px 0;padding:10px 16px;color:#666;font-size:15px;font-style:italic;">"${d.comment}"</blockquote>` : ""}`),
    smsText: "Escrow: You received a {{rating}}-star review from {{reviewer}}.",
  },

  [NOTIFICATION_TYPE.WALLET_FUNDED]: {
    title:        "Wallet Funded",
    message:      "${{amount}} has been added to your wallet. New balance: ${{balance}}.",
    emailSubject: "Escrow — Wallet Funded",
    emailBody: (d) => emailWrap("Wallet Funded", `
      <h2 style="margin-top:0;color:#27ae60;">Wallet Funded</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>$${d.amount}</strong> has been added to your wallet.
        Your new balance is <strong>$${d.balance}</strong>.
      </p>`),
    smsText: "Escrow: ${{amount}} added to your wallet. Balance: ${{balance}}.",
  },

  [NOTIFICATION_TYPE.WALLET_WITHDRAWN]: {
    title:        "Withdrawal Processed",
    message:      "${{amount}} has been withdrawn from your wallet.",
    emailSubject: "Escrow — Withdrawal Processed",
    emailBody: (d) => emailWrap("Withdrawal Processed", `
      <h2 style="margin-top:0;color:#001637;">Withdrawal Processed</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>$${d.amount}</strong> has been withdrawn from your wallet.
        Your new balance is <strong>$${d.balance}</strong>.
      </p>`),
    smsText: "Escrow: ${{amount}} withdrawn from your wallet. Balance: ${{balance}}.",
  },

  [NOTIFICATION_TYPE.WALLET_REFUNDED]: {
    title:        "Refund Received",
    message:      "${{amount}} has been refunded to your wallet.",
    emailSubject: "Escrow — Escrow Refund",
    emailBody: (d) => emailWrap("Refund Received", `
      <h2 style="margin-top:0;color:#27ae60;">Refund Received</h2>
      <p style="font-size:16px;color:#555;line-height:1.8;">
        <strong>$${d.amount}</strong> has been refunded to your wallet
        following the resolution of the dispute for
        <strong>${d.transaction || "your transaction"}</strong>.
      </p>`),
    smsText: "Escrow: ${{amount}} refunded to your wallet.",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the in-app title and message for a notification type.
 * @param {string} type   - NOTIFICATION_TYPE value
 * @param {object} data   - Placeholder values
 * @returns {{ title: string, message: string }}
 */
export function buildInAppContent(type, data = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl) {
    return { title: "Notification", message: "You have a new notification." };
  }
  return {
    title:   fill(tpl.title,   data),
    message: fill(tpl.message, data),
  };
}

/**
 * Build the email subject + HTML body for a notification type.
 * Returns null if no email template is defined for the type.
 * @param {string} type
 * @param {object} data
 * @returns {{ subject: string, html: string } | null}
 */
export function buildEmailContent(type, data = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl || !tpl.emailSubject || !tpl.emailBody) return null;
  return {
    subject: fill(tpl.emailSubject, data),
    html:    tpl.emailBody(data),
  };
}

/**
 * Build the SMS text for a notification type.
 * Returns null if no SMS template is defined for the type.
 * @param {string} type
 * @param {object} data
 * @returns {string | null}
 */
export function buildSmsContent(type, data = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl || !tpl.smsText) return null;
  return fill(tpl.smsText, data);
}
