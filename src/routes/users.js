import express from "express";
import bcrypt from "bcryptjs";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import { sendVerificationCode, verifyCode } from "../services/sms/twilio.js";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
      updates.push("two_factor_enabled = ?");
      params.push(two_factor_enabled ? 1 : 0);
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
      "SELECT id, name, email, role, phone, phone_verified, phone_verified_at, kyc_tier, is_verified, two_factor_enabled, notif_email, notif_sms, notif_push, public_profile, marketing_comms FROM users WHERE id = ?",
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
router.post("/phone/send-otp", async (req, res, next) => {
  const userId = req.user.id;
  const rawPhone = req.body.phone || "";
  const phone = normalizePhone(rawPhone);

  console.log(`[phone/send-otp] raw="${rawPhone}" normalized="${phone}"`);

  if (!phone) {
    return res.status(400).json({
      error: "Phone number is required.",
    });
  }

  // Accept any valid Nigerian mobile number: +234 followed by 7xx, 8xx or 9xx then 9 more digits
  const phoneRegex = /^\+234[789]\d{9}$/;

  if (!phoneRegex.test(phone)) {
    console.log(`[phone/send-otp] REJECTED: "${phone}" does not match Nigerian phone pattern`);
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
router.post("/phone/verify", async (req, res, next) => {
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

// DELETE /profile - Delete user account
router.delete("/profile", async (req, res, next) => {
  const userId = req.user.id;
  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    await conn.query("DELETE FROM otp_codes WHERE user_id=?", [userId]);

    await conn.query("DELETE FROM user_sessions WHERE user_id=?", [userId]);

    await conn.query("DELETE FROM kyc_submissions WHERE user_id=?", [userId]);

    await conn.query("DELETE FROM users WHERE id=?", [userId]);

    await conn.commit();

    res.json({
      message: "Account deleted successfully.",
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
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

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../../uploads/kyc");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});

const upload = multer({
  storage,
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

// Admin check middleware
const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({ error: "Admin access required." });
  }
};

// POST /kyc/submit - Submit KYC files and details
router.post("/kyc/submit", kycUpload, async (req, res, next) => {
  try {
    const { phone, idType, idNum, biz, bizName, bizReg } = req.body;
    const userId = req.user.id;

    if (!phone || !idType || !idNum) {
      return res
        .status(400)
        .json({ error: "Phone, ID type, and ID number are required." });
    }

    const files = req.files || {};
    const idFile = files.idFile
      ? `/uploads/kyc/${files.idFile[0].filename}`
      : null;
    const selfieFile = files.selfieFile
      ? `/uploads/kyc/${files.selfieFile[0].filename}`
      : null;
    const bizFile = files.bizFile
      ? `/uploads/kyc/${files.bizFile[0].filename}`
      : null;
    const incorpFile = files.incorpFile
      ? `/uploads/kyc/${files.incorpFile[0].filename}`
      : null;

    if (!idFile) {
      return res.status(400).json({ error: "ID document upload is required." });
    }

    const isBiz = biz === "true" || biz === true;
    if (!isBiz && !selfieFile) {
      return res.status(400).json({
        error: "Selfie holding ID is required for personal verification.",
      });
    }

    if (isBiz) {
      if (!bizName || !bizReg) {
        return res.status(400).json({
          error: "Business name and registration number are required.",
        });
      }
      if (!bizFile) {
        return res
          .status(400)
          .json({ error: "Business document is required." });
      }
      if (!incorpFile) {
        return res
          .status(400)
          .json({ error: "Incorporation certificate is required." });
      }
      if (!selfieFile) {
        return res
          .status(400)
          .json({ error: "Selfie holding ID is required." });
      }
    }

    // Check if there is an active/pending submission for the user
    const existing = await db.query(
      "SELECT status FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
      [userId],
    );

    if (existing.length && existing[0].status === "pending") {
      return res.status(400).json({
        error: "You already have a KYC submission pending review.",
      });
    }

    // Save submission
    await db.query(
      `INSERT INTO kyc_submissions 
       (user_id, phone, id_type, id_number, id_file, selfie_file, biz_name, biz_reg, biz_file, incorp_file, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        userId,
        phone,
        idType,
        idNum,
        idFile,
        selfieFile,
        isBiz ? bizName : null,
        isBiz ? bizReg : null,
        isBiz ? bizFile : null,
        isBiz ? incorpFile : null,
      ],
    );

    res.status(201).json({
      message: "KYC submission received successfully and is under review.",
    });
  } catch (error) {
    if (req.files) {
      Object.values(req.files)
        .flat()
        .forEach((file) => {
          fs.unlink(file.path, () => {});
        });
    }

    next(error);
  }
});

// GET /kyc/status - Get current user KYC details/status
router.get("/kyc/status", async (req, res, next) => {
  const userId = req.user.id;
  try {
    const submissions = await db.query(
      "SELECT id, phone, id_type, id_number, id_file, selfie_file, biz_name, biz_reg, biz_file, incorp_file, status, rejection_reason, created_at FROM kyc_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    if (submissions.length === 0) {
      return res.json({ status: "none", tier: req.user.kyc_tier });
    }
    res.json({
      ...submissions[0],
      tier: req.user.kyc_tier,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc - Update current user's KYC tier directly (Demo helper)
router.patch("/kyc", async (req, res, next) => {
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

// GET /kyc/queue - Get pending KYC submissions (Admin only)
router.get("/kyc/queue", adminOnly, async (req, res, next) => {
  try {
    const queue = await db.query(
      `SELECT k.*, u.name as user_name, u.email as user_email 
       FROM kyc_submissions k 
       JOIN users u ON k.user_id = u.id 
       WHERE k.status = 'pending' 
       ORDER BY k.created_at ASC`,
    );
    res.json(queue);
  } catch (error) {
    next(error);
  }
});

// PATCH /kyc/approve/:id - Approve KYC submission (Admin only)
router.patch("/kyc/approve/:id", adminOnly, async (req, res, next) => {
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
    const targetTier = sub.biz_name ? 3 : 2;

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        'UPDATE kyc_submissions SET status = "approved" WHERE id = ?',
        [submissionId],
      );
      await conn.query(
        `
  UPDATE users
  SET
      phone = ?,
      phone_verified = 1,
      phone_verified_at = NOW(),
      kyc_tier = ?
  WHERE id = ?
  `,
        [sub.phone, targetTier, sub.user_id],
      );

      await conn.commit();
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
  const { reason } = req.body;

  try {
    const submissions = await db.query(
      "SELECT user_id FROM kyc_submissions WHERE id = ?",
      [submissionId],
    );
    if (submissions.length === 0) {
      return res.status(404).json({ error: "KYC submission not found." });
    }
    const sub = submissions[0];

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        'UPDATE kyc_submissions SET status = "rejected", rejection_reason = ? WHERE id = ?',
        [reason || "Documents were unclear or expired.", submissionId],
      );
      await conn.query("UPDATE users SET kyc_tier = 1 WHERE id = ?", [
        sub.user_id,
      ]);

      await conn.commit();
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
