import crypto from "crypto";
import express from "express";
import bcrypt from "bcryptjs";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import adminOnly from "../middleware/admin.js";
import { sendVerificationCode, verifyCode } from "../services/sms/twilio.js";
import { sendOTPEmail } from "../utils/mailer.js";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { notify } from "../services/notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import { otpLimiter } from "../middleware/rateLimiter.js";
import { uploadFile } from "../config/cloudinary.js";

const router = express.Router();

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function normalizePhone(phone) {
  if (!phone) return "";
  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, "");
  // 0XXXXXXXXXX (11 digits, local format) → +234XXXXXXXXX
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = "+234" + cleaned.substring(1);
  // 234XXXXXXXXXX (13 digits, no leading +) → +234XXXXXXXXXX
  } else if (/^234[789]/.test(cleaned) && cleaned.length === 13) {
    cleaned = "+" + cleaned;
  // +234XXXXXXXXXX (already correct international format)
  } else if (cleaned.startsWith("+234") && cleaned.length === 14) {
    // already normalized
  } else if (/^[789]\d{9}$/.test(cleaned)) {
    // 10-digit number starting with 7/8/9 (no country code)
    cleaned = "+234" + cleaned;
  }
  return cleaned;
}

// Twilio Verify is used for phone OTP — no local OTP generation needed for SMS

// All user routes require authentication
router.use(authMiddleware);

// GET /profile - Get current user profile
router.get("/profile", async (req, res, next) => {
  try {
    res.json(req.user);
  } catch (error) {
    next(error);
  }
});

// PATCH /profile - Update profile details
router.patch("/profile", async (req, res, next) => {
  const {
    name,
    email,
    two_factor_enabled,
    notif_email,
    notif_sms,
    notif_push,
    public_profile,
    marketing_comms,
  } = req.body;
  const userId = req.user.id;

  const hasUpdates =
    name !== undefined ||
    email !== undefined ||
    two_factor_enabled !== undefined ||
    notif_email !== undefined ||
    notif_sms !== undefined ||
    notif_push !== undefined ||
    public_profile !== undefined ||
    marketing_comms !== undefined;

  if (!hasUpdates) {
    return res
      .status(400)
      .json({ error: "Please provide at least one field to update." });
  }

  try {
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name ? name.trim() : "");
    }

    if (email !== undefined) {
      const emailLower = email.trim().toLowerCase();
      // Check if email already exists for another user
      const existing = await db.query(
        "SELECT id FROM users WHERE email = ? AND id != ?",
        [emailLower, userId],
      );
      if (existing.length > 0) {
        return res
          .status(400)
          .json({ error: "An account with this email already exists." });
      }
      updates.push("email = ?");
      params.push(emailLower);
    }

    // Toggle fields
    if (two_factor_enabled !== undefined) {
      return res.status(400).json({
        error: "Two-factor authentication cannot be toggled directly. Please use the 2FA setup or disable option with verification.",
      });
    }

    if (notif_email !== undefined) {
      updates.push("notif_email = ?");
      params.push(notif_email ? 1 : 0);
    }

    if (notif_sms !== undefined) {
      updates.push("notif_sms = ?");
      params.push(notif_sms ? 1 : 0);
    }

    if (notif_push !== undefined) {
      updates.push("notif_push = ?");
      params.push(notif_push ? 1 : 0);
    }

    if (public_profile !== undefined) {
      updates.push("public_profile = ?");
      params.push(public_profile ? 1 : 0);
    }

    if (marketing_comms !== undefined) {
      updates.push("marketing_comms = ?");
      params.push(marketing_comms ? 1 : 0);
    }

    if (updates.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid fields provided for update." });
    }

    params.push(userId);

    await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );

    // Fetch updated user
    const users = await db.query(
      "SELECT id, name, email, role, phone, phone_verified, phone_verified_at, kyc_tier, is_verified, two_factor_enabled, notif_email, notif_sms, notif_push, public_profile, marketing_comms, portfolio_url, portfolio_verified, portfolio_verified_at, portfolio_status, portfolio_rejection_reason FROM users WHERE id = ?",
      [userId],
    );

    res.json({
      message: "Profile updated successfully.",
      user: users[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /phone/send-otp — sends OTP via Twilio Verify
router.post("/phone/send-otp", otpLimiter, async (req, res, next) => {
  const userId = req.user.id;
  const rawPhone = req.body.phone || "";
  const phone = normalizePhone(rawPhone);

  if (!phone) {
    return res.status(400).json({
      error: "Phone number is required.",
    });
  }

  // Accept any valid Nigerian mobile number: +234 followed by 7xx, 8xx or 9xx then 9 more digits
  const phoneRegex = /^\+234[789]\d{9}$/;

  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      error: `Please enter a valid Nigerian phone number (e.g. 0801 234 5678). Received: ${rawPhone}`,
    });
  }

  try {
    // Check if phone belongs to another verified user
    const existing = await db.query(
      `SELECT id FROM users WHERE phone = ? AND phone_verified = 1 AND id != ?`,
      [phone, userId],
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "Phone number already belongs to another account.",
      });
    }

    // Save phone on user record so it's ready for verification
    await db.query("UPDATE users SET phone = ? WHERE id = ?", [phone, userId]);

    // Send OTP via Twilio Verify
    const result = await sendVerificationCode(phone);

    if (!result.success) {
      return res.status(400).json({
        error: result.message || "Failed to send verification code. Please try again.",
      });
    }

    // Invalidate previous phone OTPs for this user in DB
    await db.query(
      `DELETE FROM otp_codes WHERE user_id = ? AND type = 'phone_verification'`,
      [userId]
    );

    // Save a record in otp_codes table to log the send action
    const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || "10");
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
    await db.query(
      `INSERT INTO otp_codes (user_id, email, phone, code, type, expires_at)
       VALUES (?, ?, ?, ?, 'phone_verification', ?)`,
      [userId, req.user.email, phone, result.sid || "twilio_verify", expiresAt]
    );

    res.json({
      message: "Verification code sent.",
    });
  } catch (err) {
    next(err);
  }
});

// POST /phone/verify — verifies OTP via Twilio Verify then marks phone as verified in DB
router.post("/phone/verify", otpLimiter, async (req, res, next) => {
  const userId = req.user.id;

  const phone = normalizePhone(req.body.phone);
  const { code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({
      error: "Phone and code are required.",
    });
  }

  try {
    // Verify OTP via Twilio
    const result = await verifyCode(phone, code);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid or expired OTP. Please try again.",
      });
    }

    // Mark the verification code record as used in database
    await db.query(
      `UPDATE otp_codes SET used = 1 WHERE user_id = ? AND phone = ? AND type = 'phone_verification'`,
      [userId, phone]
    );

    // Mark phone as verified in the database
    await db.query(
      `UPDATE users
       SET
         phone = ?,
         phone_verified = 1,
         phone_verified_at = NOW()
       WHERE id = ?`,
      [phone, userId],
    );

    res.json({
      message: "Phone verified successfully.",
    });
  } catch (err) {
    next(err);
  }
});

// POST /portfolio/submit (or /portfolio/verify) — validates URL and submits for admin review
const handlePortfolioSubmit = async (req, res, next) => {
  const userId = req.user.id;
  let { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Portfolio URL is required." });
  }

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      return res.status(400).json({
        error: "Please enter a valid website URL (e.g. github.com/username or yourportfolio.com).",
      });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL format." });
  }

  try {
    // Check URL reachability with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let reachable = false;

    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Lumbrr/1.0" },
      });
      clearTimeout(timeout);
      if (response.ok || (response.status >= 300 && response.status < 400)) {
        reachable = true;
      } else {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), 7000);
        const getRes = await fetch(url, {
          method: "GET",
          signal: getController.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });
        clearTimeout(getTimeout);
        if (getRes.status < 500) {
          reachable = true;
        }
      }
    } catch (headErr) {
      clearTimeout(timeout);
      try {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), 7000);
        const getRes = await fetch(url, {
          method: "GET",
          signal: getController.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });
        clearTimeout(getTimeout);
        if (getRes.status < 500) {
          reachable = true;
        }
      } catch (getErr) {
        // unreachable
      }
    }

    if (!reachable) {
      return res.status(400).json({
        error: "Unable to reach your portfolio URL. Please ensure it is publicly accessible and online.",
      });
    }

    await db.query(
      `UPDATE users 
       SET portfolio_url = ?, portfolio_status = 'pending', portfolio_verified = 0, portfolio_rejection_reason = NULL 
       WHERE id = ?`,
      [url, userId],
    );

    res.json({
      message: "Portfolio link submitted for admin review.",
      portfolio_url: url,
      portfolio_status: "pending",
      portfolio_verified: 0,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/portfolio/submit", handlePortfolioSubmit);
router.post("/portfolio/verify", handlePortfolioSubmit);

// GET /portfolio/queue — Admin: list pending portfolio verification requests
router.get("/portfolio/queue", adminOnly, async (req, res, next) => {
  try {
    const queue = await db.query(
      `SELECT id, name, email, role, phone, portfolio_url, portfolio_status, portfolio_rejection_reason, updated_at as submitted_at 
       FROM users 
       WHERE portfolio_status = 'pending' 
       ORDER BY updated_at ASC`
    );
    res.json(queue);
  } catch (error) {
    next(error);
  }
});

// PATCH /portfolio/approve/:userId — Admin: approve portfolio verification
router.patch("/portfolio/approve/:userId", adminOnly, async (req, res, next) => {
  const targetId = req.params.userId;
  try {
    const users = await db.query("SELECT id, name, email FROM users WHERE id = ?", [targetId]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    await db.query(
      `UPDATE users 
       SET portfolio_status = 'approved', portfolio_verified = 1, portfolio_verified_at = NOW(), portfolio_rejection_reason = NULL 
       WHERE id = ?`,
      [targetId]
    );

    res.json({ message: "Portfolio approved successfully." });
  } catch (error) {
    next(error);
  }
});

// PATCH /portfolio/reject/:userId — Admin: reject portfolio verification
router.patch("/portfolio/reject/:userId", adminOnly, async (req, res, next) => {
  const targetId = req.params.userId;
  const { reason } = req.body;
  try {
    const users = await db.query("SELECT id, name, email FROM users WHERE id = ?", [targetId]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    await db.query(
      `UPDATE users 
       SET portfolio_status = 'rejected', portfolio_verified = 0, portfolio_rejection_reason = ? 
       WHERE id = ?`,
      [reason || "Portfolio could not be verified.", targetId]
    );

    res.json({ message: "Portfolio rejected." });
  } catch (error) {
    next(error);
  }
});

// PATCH /change-password - Change user password
router.patch("/change-password", async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ error: "Please provide current and new passwords." });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: "Password must be at least 8 characters long.",
    });
  }

  const userId = req.user.id;

  try {
    // Get full user detail including password hash
    const users = await db.query(
      "SELECT password_hash FROM users WHERE id = ?",
      [userId],
    );
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = users[0];

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Incorrect current password." });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    // Save new password
    await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [
      newHash,
      userId,
    ]);

    await db.query("DELETE FROM user_sessions WHERE user_id=?", [userId]);

    res.json({ message: "Password updated successfully." });
  } catch (error) {
    next(error);
  }
});

// POST /2fa/send-otp - Send OTP email for 2FA activation
router.post("/2fa/send-otp", otpLimiter, async (req, res, next) => {
  const userId = req.user.id;
  try {
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await db.query("UPDATE otp_codes SET used = 1 WHERE user_id = ? AND type = 'login_2fa'", [userId]);
    await db.query("INSERT INTO otp_codes (user_id, code, type, expires_at) VALUES (?, ?, 'login_2fa', ?)", [userId, otpCode, expiresAt]);

    try {
      await sendOTPEmail(req.user.email, otpCode, "login_2fa");
    } catch (e) {
      console.error("[2FA send-otp]", e.message);
    }

    res.json({ message: "Verification code sent to your email." });
  } catch (err) {
    next(err);
  }
});

// POST /2fa/enable - Enable 2FA after verifying OTP code
router.post("/2fa/enable", async (req, res, next) => {
  const userId = req.user.id;
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Verification code is required." });
  }

  try {
    const otps = await db.query(
      `SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND type = 'login_2fa' AND used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [userId, code]
    );

    if (otps.length === 0) {
      return res.status(400).json({ error: "Invalid or expired verification code." });
    }

    await db.query("UPDATE otp_codes SET used = 1 WHERE id = ?", [otps[0].id]);
    await db.query("UPDATE users SET two_factor_enabled = 1 WHERE id = ?", [userId]);

    const users = await db.query("SELECT id, name, email, role, two_factor_enabled FROM users WHERE id = ?", [userId]);
    res.json({ message: "Two-Factor Authentication enabled successfully.", user: users[0] });
  } catch (err) {
    next(err);
  }
});

// POST /2fa/disable - Disable 2FA with password re-authentication
router.post("/2fa/disable", async (req, res, next) => {
  const userId = req.user.id;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "Current password is required to disable 2FA." });
  }

  try {
    const users = await db.query("SELECT password_hash FROM users WHERE id = ?", [userId]);
    if (!users.length) return res.status(404).json({ error: "User not found." });

    const isMatch = await bcrypt.compare(password, users[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Incorrect password." });
    }

    await db.query("UPDATE users SET two_factor_enabled = 0 WHERE id = ?", [userId]);
    const updated = await db.query("SELECT id, name, email, role, two_factor_enabled FROM users WHERE id = ?", [userId]);

    res.json({ message: "Two-Factor Authentication disabled successfully.", user: updated[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /profile - Deactivate user account while preserving financial/audit history
router.delete("/profile", async (req, res, next) => {
  const userId = req.user.id;

  try {
    // 1. Check for active financial obligations
    const activeTx = await db.query(
      `SELECT id FROM transactions WHERE (buyer_id = ? OR seller_id = ?) AND status IN ('funded', 'inprogress', 'inspection', 'audit', 'revision', 'disputed') LIMIT 1`,
      [userId, userId]
    );
    if (activeTx.length > 0) {
      return res.status(400).json({
        error: "Cannot deactivate account while active financial transactions or escrows are in progress."
      });
    }

    const pendingWithdrawals = await db.query(
      `SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending' LIMIT 1`,
      [userId]
    );
    if (pendingWithdrawals.length > 0) {
      return res.status(400).json({
        error: "Cannot deactivate account while a withdrawal is pending."
      });
    }

    const openDisputes = await db.query(
      `SELECT id FROM disputes WHERE filed_by = ? AND status = 'open' LIMIT 1`,
      [userId]
    );
    if (openDisputes.length > 0) {
      return res.status(400).json({
        error: "Cannot deactivate account while an open dispute exists."
      });
    }

    // 2. Perform soft-deactivation (mark user inactive, set deleted_at, anonymize PII)
    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE users
         SET is_active = 0,
             deleted_at = CURRENT_TIMESTAMP,
             name = 'Deactivated User',
             email = CONCAT('deactivated_', id, '@removed.local'),
             phone = NULL
         WHERE id = ?`,
        [userId]
      );

      // Invalidate active sessions and active OTPs
      await conn.query("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
      await conn.query("DELETE FROM otp_codes WHERE user_id = ?", [userId]);

      await conn.commit();

      res.json({
        message: "Account deactivated successfully. Financial and audit history preserved for compliance."
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /sessions - Fetch active sessions
router.get("/sessions", async (req, res, next) => {
  const userId = req.user.id;
  try {
    const sessions = await db.query(
      "SELECT id, device, ip_address, location, token_jti, last_active, created_at FROM user_sessions WHERE user_id = ? ORDER BY last_active DESC",
      [userId],
    );
    const mapped = sessions.map((s) => ({
      id: s.id,
      device: s.device,
      ip_address: s.ip_address,
      location: s.location,
      last_active: s.last_active,
      created_at: s.created_at,
      active: s.token_jti === req.sessionJti,
    }));
    res.json(mapped);
  } catch (error) {
    next(error);
  }
});

// DELETE /sessions/:id - Revoke user session
router.delete("/sessions/:id", async (req, res, next) => {
  const userId = req.user.id;
  const sessionId = req.params.id;
  try {
    await db.query("DELETE FROM user_sessions WHERE id = ? AND user_id = ?", [
      sessionId,
      userId,
    ]);
    res.json({ message: "Session revoked successfully." });
  } catch (error) {
    next(error);
  }
});

// ─── KYC MIGRATION & SERVICES ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer memory storage
const kycStorage = multer.memoryStorage();

const upload = multer({
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    if (allowedTypes.test(ext) && allowedTypes.test(mime)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, or PDF files are allowed."));
    }
  },
});

const kycUpload = upload.fields([
  { name: "idFile", maxCount: 1 },
  { name: "selfieFile", maxCount: 1 },
  { name: "bizFile", maxCount: 1 },
  { name: "incorpFile", maxCount: 1 },
]);

// POST /kyc/submit - Submit KYC files and details
router.post("/kyc/submit", kycUpload, async (req, res, next) => {
  try {
    const { phone, idType, idNum, biz, bizName, bizReg } = req.body;
    const userId = req.user.id;
    const isBiz = biz === "true" || biz === true;

    const files = req.files || {};
    const idFile = files.idFile ? await uploadFile(files.idFile[0], "kyc") : null;
    const selfieFile = files.selfieFile ? await uploadFile(files.selfieFile[0], "kyc") : null;
    const bizFile = files.bizFile ? await uploadFile(files.bizFile[0], "kyc") : null;
    const incorpFile = files.incorpFile ? await uploadFile(files.incorpFile[0], "kyc") : null;

    const userPhone = phone || req.user.phone || null;

    if (isBiz) {
      if (!bizName || !bizName.trim()) {
        return res.status(400).json({ error: "Business name is required." });
      }
      if (!bizReg || !bizReg.trim()) {
        return res
          .status(400)
          .json({ error: "Registration / CAC number is required." });
      }
      if (!bizFile) {
        return res
          .status(400)
          .json({ error: "Business document is required." });
      }
      if (!incorpFile) {
        return res
          .status(400)
          .json({ error: "Certificate of Incorporation is required." });
      }

      // Check if user already has an active pending business submission
      const existing = await db.query(
        "SELECT id, status FROM kyc_submissions WHERE user_id = ? AND submission_type = 'business' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [userId],
      );
      if (existing.length > 0) {
        return res.status(400).json({
          error: "You already have a business profile verification pending review.",
        });
      }

      await db.query(
        `INSERT INTO kyc_submissions 
         (user_id, phone, biz_name, biz_reg, biz_file, incorp_file, selfie_file, submission_type, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, 'business', 'pending')`,
        [
          userId,
          userPhone,
          bizName.trim(),
          bizReg.trim(),
          bizFile,
          incorpFile,
          selfieFile,
        ],
      );

      return res.status(201).json({
        message: "Business profile verification received successfully and is under review.",
      });
    } else {
      if (!idType) {
        return res.status(400).json({ error: "ID type is required." });
      }
      if (!idNum || !idNum.trim()) {
        return res.status(400).json({ error: "ID number is required." });
      }
      if (!idFile) {
        return res.status(400).json({ error: "ID document upload is required." });
      }
      if (!selfieFile) {
        return res.status(400).json({
          error: "Selfie holding ID is required for personal verification.",
        });
      }

      // Check if user already has an active pending govt_id submission
      const existing = await db.query(
        "SELECT id, status FROM kyc_submissions WHERE user_id = ? AND submission_type = 'govt_id' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [userId],
      );
      if (existing.length > 0) {
        return res.status(400).json({
          error: "You already have an identity verification pending review.",
        });
      }

      await db.query(
        `INSERT INTO kyc_submissions 
         (user_id, phone, id_type, id_number, id_file, selfie_file, submission_type, status) 
         VALUES (?, ?, ?, ?, ?, ?, 'govt_id', 'pending')`,
        [userId, userPhone, idType, idNum.trim(), idFile, selfieFile],
      );

      return res.status(201).json({
        message: "Identity verification received successfully and is under review.",
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /kyc/status - Get current user KYC details/status
router.get("/kyc/status", async (req, res, next) => {
  const userId = req.user.id;
  try {
    const userRows = await db.query(
      "SELECT kyc_tier, phone, phone_verified, is_verified FROM users WHERE id = ?",
      [userId]
    );
    const userRow = userRows[0] || {};
    const currentTier = userRow.kyc_tier || 1;

    // Fetch latest govt ID submission
    const govtRows = await db.query(
      `SELECT * FROM kyc_submissions 
       WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    // Fetch latest business submission
    const bizRows = await db.query(
      `SELECT * FROM kyc_submissions 
       WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    let govtIdStatus = "none";
    let govtRejectionReason = null;
    if (govtRows.length > 0) {
      govtIdStatus = govtRows[0].status; // pending, approved, or rejected
      if (govtRows[0].status === "rejected") govtRejectionReason = govtRows[0].rejection_reason;
    }

    let bizStatus = "none";
    let bizRejectionReason = null;
    if (bizRows.length > 0) {
      bizStatus = bizRows[0].status; // pending, approved, or rejected
      if (bizRows[0].status === "rejected") bizRejectionReason = bizRows[0].rejection_reason;
    }

    const latestSub = (govtRows[0]?.created_at > (bizRows[0]?.created_at || 0)) ? govtRows[0] : (bizRows[0] || govtRows[0] || {});

    res.json({
      ...latestSub,
      phone: userRow.phone,
      tier: currentTier,
      govt_id_status: govtIdStatus,
      govt_rejection_reason: govtRejectionReason,
      biz_status: bizStatus,
      biz_rejection_reason: bizRejectionReason,
      id_type: govtRows[0]?.id_type || "passport",
      id_number: govtRows[0]?.id_number || "",
      biz_name: bizRows[0]?.biz_name || "",
      biz_reg: bizRows[0]?.biz_reg || "",
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc - Update current user's KYC tier directly (Admin/Demo helper)
router.patch("/kyc", adminOnly, async (req, res, next) => {
  const { tier } = req.body;
  const userId = req.user.id;

  if (tier === undefined) {
    return res.status(400).json({ error: "KYC tier is required." });
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    const status = tier > 1 ? "approved" : "rejected";
    
    // Find latest pending kyc submission of this user to simulate approving it
    const [existing] = await conn.query(
      "SELECT id, phone FROM kyc_submissions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [userId]
    );

    if (existing.length > 0) {
      const subId = existing[0].id;
      const phone = existing[0].phone;
      
      await conn.query(
        "UPDATE kyc_submissions SET status = ?, rejection_reason = ? WHERE id = ?",
        [status, status === "rejected" ? "Simulated rejection." : null, subId]
      );

      await conn.query(
        `UPDATE users 
         SET kyc_tier = ?, 
             phone = ?, 
             phone_verified = ?, 
             phone_verified_at = ? 
         WHERE id = ?`,
        [
          tier,
          phone,
          status === "approved" ? 1 : req.user.phone_verified,
          status === "approved" ? new Date() : req.user.phone_verified_at,
          userId
        ]
      );
    } else {
      // Direct update of the user's tier
      await conn.query(
        "UPDATE users SET kyc_tier = ? WHERE id = ?",
        [tier, userId]
      );
    }

    await conn.commit();
    res.json({ message: "KYC tier updated successfully.", tier });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// POST /kyc/reset - Reset current user's KYC submission and status (Testing helper)
router.post("/kyc/reset", async (req, res, next) => {
  const userId = req.user.id;
  const { type } = req.body || {}; // 'business' | 'govt_id' | undefined (all)
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    if (type === "business") {
      await conn.query(
        "DELETE FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL))",
        [userId]
      );
      const [govt] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [userId]
      );
      const tier = govt.length > 0 ? 2 : 1;
      await conn.query("UPDATE users SET kyc_tier = ? WHERE id = ?", [tier, userId]);
    } else if (type === "govt_id") {
      await conn.query(
        "DELETE FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL))",
        [userId]
      );
      const [biz] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [userId]
      );
      const tier = biz.length > 0 ? 2 : 1;
      await conn.query("UPDATE users SET kyc_tier = ? WHERE id = ?", [tier, userId]);
    } else {
      await conn.query("DELETE FROM kyc_submissions WHERE user_id = ?", [userId]);
      await conn.query("UPDATE users SET kyc_tier = 1 WHERE id = ?", [userId]);
    }

    await conn.commit();
    res.json({ message: "KYC reset successfully. You can now test identity verification again." });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// GET /kyc/queue - Get all KYC submissions (Admin only), with optional filters
router.get("/kyc/queue", adminOnly, async (req, res, next) => {
  try {
    const { status, type, search } = req.query;
    const conditions = [];
    const params = [];

    if (status && ["pending", "approved", "rejected"].includes(status)) {
      conditions.push("k.status = ?");
      params.push(status);
    }
    if (type && ["govt_id", "business"].includes(type)) {
      conditions.push("k.submission_type = ?");
      params.push(type);
    }
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push("(u.name LIKE ? OR u.email LIKE ? OR k.phone LIKE ? OR k.id_number LIKE ? OR k.biz_name LIKE ?)");
      params.push(term, term, term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const queue = await db.query(
      `SELECT k.*, u.name as user_name, u.email as user_email, u.kyc_tier as current_tier,
              r.name as reviewer_name
       FROM kyc_submissions k
       JOIN users u ON k.user_id = u.id
       LEFT JOIN users r ON k.reviewed_by = r.id
       ${whereClause}
       ORDER BY FIELD(k.status, 'pending', 'rejected', 'approved'), k.created_at DESC`,
      params,
    );
    res.json(queue);
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc/approve/:id - Approve KYC submission (Admin only)
router.patch("/kyc/approve/:id", adminOnly, async (req, res, next) => {
  const submissionId = req.params.id;
  const adminId = req.user.id;
  try {
    const submissions = await db.query(
      "SELECT k.*, u.name as user_name, u.kyc_tier as current_tier FROM kyc_submissions k JOIN users u ON k.user_id = u.id WHERE k.id = ?",
      [submissionId],
    );
    if (submissions.length === 0) {
      return res.status(404).json({ error: "KYC submission not found." });
    }
    const sub = submissions[0];
    if (sub.status === "approved") {
      return res.status(400).json({ error: "Submission is already approved." });
    }

    const isBusiness = sub.submission_type === "business" || !!sub.biz_name || !!sub.biz_file;

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE kyc_submissions
         SET status = 'approved', rejection_reason = NULL, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [adminId, submissionId],
      );

      // Check which verifications are approved for this user
      const [approvedGovt] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );
      const [approvedBiz] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );

      let targetTier = 1;
      if (approvedGovt.length > 0 && approvedBiz.length > 0) {
        targetTier = 3;
      } else if (approvedGovt.length > 0 || approvedBiz.length > 0) {
        targetTier = 2;
      }

      await conn.query(
        `UPDATE users
         SET kyc_tier = ?
         WHERE id = ?`,
        [targetTier, sub.user_id],
      );

      if (sub.phone) {
        await conn.query(
          `UPDATE users SET phone = ?, phone_verified = 1, phone_verified_at = COALESCE(phone_verified_at, NOW()) WHERE id = ?`,
          [sub.phone, sub.user_id],
        );
      }

      await conn.commit();

      // Fire notification (non-blocking)
      notify({
        userId: sub.user_id,
        type:   NOTIFICATION_TYPE.KYC_APPROVED,
        data:   { name: sub.user_name, type: isBusiness ? "Business Profile" : "Government ID" },
        email:  true,
        sms:    false,
        push:   true,
      }).catch((e) => console.error("[KYC approve notify]", e));

      res.json({
        message: "KYC submission approved successfully.",
        target_tier: targetTier,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc/reject/:id - Reject KYC submission (Admin only)
router.patch("/kyc/reject/:id", adminOnly, async (req, res, next) => {
  const submissionId = req.params.id;
  const adminId = req.user.id;
  const { reason } = req.body;

  try {
    const submissions = await db.query(
      "SELECT k.*, u.name as user_name, u.kyc_tier as current_tier FROM kyc_submissions k JOIN users u ON k.user_id = u.id WHERE k.id = ?",
      [submissionId],
    );
    if (submissions.length === 0) {
      return res.status(404).json({ error: "KYC submission not found." });
    }
    const sub = submissions[0];
    const rejectionReason = reason || "Documents were unclear or expired.";
    const isBusiness = sub.submission_type === "business" || !!sub.biz_name || !!sub.biz_file;

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE kyc_submissions
         SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [rejectionReason, adminId, submissionId],
      );

      // Re-calculate the proper kyc_tier based on remaining approved submissions
      const [approvedGovt] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );
      const [approvedBiz] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );

      let targetTier = 1;
      if (approvedGovt.length > 0 && approvedBiz.length > 0) {
        targetTier = 3;
      } else if (approvedGovt.length > 0 || approvedBiz.length > 0) {
        targetTier = 2;
      }

      await conn.query(
        `UPDATE users
         SET kyc_tier = ?
         WHERE id = ?`,
        [targetTier, sub.user_id],
      );

      await conn.commit();

      // Fire notification (non-blocking)
      notify({
        userId: sub.user_id,
        type:   NOTIFICATION_TYPE.KYC_REJECTED,
        data:   { name: sub.user_name, reason: rejectionReason, type: isBusiness ? "Business Profile" : "Government ID" },
        email:  true,
        sms:    false,
        push:   true,
      }).catch((e) => console.error("[KYC reject notify]", e));

      res.json({ message: "KYC submission rejected successfully." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc/submissions/:id - Edit KYC submission details (Admin only)
router.patch("/kyc/submissions/:id", adminOnly, async (req, res, next) => {
  const submissionId = req.params.id;
  const adminId = req.user.id;
  const { status, id_type, id_number, phone, biz_name, biz_reg, rejection_reason } = req.body;

  try {
    const submissions = await db.query(
      "SELECT k.*, u.name as user_name FROM kyc_submissions k JOIN users u ON k.user_id = u.id WHERE k.id = ?",
      [submissionId],
    );
    if (submissions.length === 0) {
      return res.status(404).json({ error: "KYC submission not found." });
    }
    const sub = submissions[0];
    const isBusiness = sub.submission_type === "business" || !!sub.biz_name || !!sub.biz_file;

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      // Build dynamic update fields
      const updates = [];
      const vals = [];

      if (status && ["pending", "approved", "rejected"].includes(status)) {
        updates.push("status = ?");
        vals.push(status);
        updates.push("reviewed_by = ?");
        vals.push(adminId);
        updates.push("reviewed_at = NOW()");
        if (status === "approved") {
          updates.push("rejection_reason = NULL");
        }
      }
      if (id_type !== undefined) { updates.push("id_type = ?"); vals.push(id_type || null); }
      if (id_number !== undefined) { updates.push("id_number = ?"); vals.push(id_number || null); }
      if (phone !== undefined) { updates.push("phone = ?"); vals.push(phone || null); }
      if (biz_name !== undefined) { updates.push("biz_name = ?"); vals.push(biz_name || null); }
      if (biz_reg !== undefined) { updates.push("biz_reg = ?"); vals.push(biz_reg || null); }
      if (rejection_reason !== undefined) { updates.push("rejection_reason = ?"); vals.push(rejection_reason || null); }

      if (updates.length === 0) {
        conn.release();
        return res.status(400).json({ error: "No fields to update." });
      }

      vals.push(submissionId);
      await conn.query(
        `UPDATE kyc_submissions SET ${updates.join(", ")} WHERE id = ?`,
        vals,
      );

      // Recalculate user kyc_tier based on approved submissions
      const [approvedGovt] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );
      const [approvedBiz] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );

      let targetTier = 1;
      if (approvedGovt.length > 0 && approvedBiz.length > 0) {
        targetTier = 3;
      } else if (approvedGovt.length > 0 || approvedBiz.length > 0) {
        targetTier = 2;
      }

      await conn.query("UPDATE users SET kyc_tier = ? WHERE id = ?", [targetTier, sub.user_id]);

      await conn.commit();

      // Notify user on status change
      const newStatus = status || sub.status;
      if (status && status !== sub.status) {
        if (status === "approved") {
          notify({
            userId: sub.user_id,
            type:   NOTIFICATION_TYPE.KYC_APPROVED,
            data:   { name: sub.user_name, type: isBusiness ? "Business Profile" : "Government ID" },
            email: true, sms: false, push: true,
          }).catch((e) => console.error("[KYC edit approve notify]", e));
        } else if (status === "rejected") {
          notify({
            userId: sub.user_id,
            type:   NOTIFICATION_TYPE.KYC_REJECTED,
            data:   { name: sub.user_name, reason: rejection_reason || "Admin decision.", type: isBusiness ? "Business Profile" : "Government ID" },
            email: true, sms: false, push: true,
          }).catch((e) => console.error("[KYC edit reject notify]", e));
        }
      }

      res.json({ message: "KYC submission updated successfully.", target_tier: targetTier });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
});

// DELETE /kyc/submissions/:id - Delete a KYC submission (Admin only)
router.delete("/kyc/submissions/:id", adminOnly, async (req, res, next) => {
  const submissionId = req.params.id;
  try {
    const submissions = await db.query(
      "SELECT * FROM kyc_submissions WHERE id = ?",
      [submissionId],
    );
    if (submissions.length === 0) {
      return res.status(404).json({ error: "KYC submission not found." });
    }
    const sub = submissions[0];

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query("DELETE FROM kyc_submissions WHERE id = ?", [submissionId]);

      // Recalculate user kyc_tier
      const [approvedGovt] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'govt_id' OR (id_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );
      const [approvedBiz] = await conn.query(
        "SELECT id FROM kyc_submissions WHERE user_id = ? AND (submission_type = 'business' OR (biz_file IS NOT NULL AND submission_type IS NULL)) AND status = 'approved' LIMIT 1",
        [sub.user_id],
      );

      let targetTier = 1;
      if (approvedGovt.length > 0 && approvedBiz.length > 0) {
        targetTier = 3;
      } else if (approvedGovt.length > 0 || approvedBiz.length > 0) {
        targetTier = 2;
      }

      await conn.query("UPDATE users SET kyc_tier = ? WHERE id = ?", [targetTier, sub.user_id]);

      await conn.commit();
      res.json({ message: "KYC submission deleted successfully.", target_tier: targetTier });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
});

// GET /:id/reviews - Get reviews received by a user, including stats & breakdown
router.get("/:id/reviews", async (req, res, next) => {
  const targetUserId = req.params.id;

  try {
    const userRows = await db.query("SELECT id FROM users WHERE id = ?", [targetUserId]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    // Fetch all reviews received by targetUserId (reviewee_id = targetUserId)
    const reviews = await db.query(
      `SELECT r.*,
              u_reviewer.name as reviewer_name, u_reviewer.email as reviewer_email
       FROM reviews r
       JOIN users u_reviewer ON r.reviewer_id = u_reviewer.id
       WHERE r.reviewee_id = ?
       ORDER BY r.created_at DESC`,
      [targetUserId]
    );

    const totalReviews = reviews.length;

    let averageRating = 0;
    if (totalReviews > 0) {
      const sum = reviews.reduce((acc, val) => acc + val.rating, 0);
      averageRating = parseFloat((sum / totalReviews).toFixed(1));
    }

    const breakdown = {
      "5": 0,
      "4": 0,
      "3": 0,
      "2": 0,
      "1": 0
    };

    reviews.forEach(r => {
      const ratingStr = String(r.rating);
      if (breakdown[ratingStr] !== undefined) {
        breakdown[ratingStr]++;
      }
    });

    return res.json({
      averageRating,
      totalReviews,
      breakdown,
      reviews
    });
  } catch (error) {
    next(error);
  }
});

export default router;
