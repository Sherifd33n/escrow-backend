/**
 * Notification type constants.
 * Use these everywhere instead of inline strings.
 */
export const NOTIFICATION_TYPE = Object.freeze({
  // Auth
  WELCOME:           "welcome",
  OTP_SENT:          "otp_sent",
  PASSWORD_RESET:    "password_reset",
  SECURITY_ALERT:    "security_alert",

  // Transactions
  TRANSACTION_CREATED:        "transaction_created",
  TRANSACTION_FUNDED:         "transaction_funded",
  TRANSACTION_STARTED:        "transaction_started",
  TRANSACTION_STATUS_CHANGED: "transaction_status_changed",
  TRANSACTION_COMPLETED:      "transaction_completed",

  // Milestones
  MILESTONE_DUE:       "milestone_due",
  MILESTONE_PAID:      "milestone_paid",
  MILESTONE_SUBMITTED: "milestone_submitted",
  MILESTONE_APPROVED:  "milestone_approved",
  MILESTONE_REJECTED:  "milestone_rejected",

  // Disputes
  DISPUTE_FILED:    "dispute_filed",
  DISPUTE_RESOLVED: "dispute_resolved",

  // Reviews
  REVIEW_RECEIVED: "review_received",

  // Wallet
  WALLET_FUNDED:    "wallet_funded",
  WALLET_WITHDRAWN: "wallet_withdrawn",
  WALLET_REFUNDED:  "wallet_refunded",
});

/**
 * Delivery channels. Mirrors the DB ENUM.
 */
export const NOTIFICATION_CHANNEL = Object.freeze({
  IN_APP: "in_app",
  EMAIL:  "email",
  SMS:    "sms",
  PUSH:   "push",
});
