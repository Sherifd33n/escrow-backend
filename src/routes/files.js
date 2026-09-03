import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import authMiddleware from "../middleware/auth.js";
import db from "../config/db.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(path.join(__dirname, "../../uploads"));

// Protect all files with authentication
router.use(authMiddleware);

/**
 * GET /uploads/* — Authenticated & authorized file access route
 */
router.get("/{*subpath}", async (req, res, next) => {
  try {
    const rawSubpath = req.params.subpath || req.params[0] || "";
    const decodedSubpath = decodeURIComponent(rawSubpath);
    const safeBasename = path.basename(decodedSubpath);
    const subfolder = decodedSubpath.split("/")[0] || "";

    // Root jail verification
    const targetPath = path.resolve(path.join(UPLOADS_DIR, subfolder, safeBasename));
    const allowedRoot = path.resolve(UPLOADS_DIR);

    if (!targetPath.startsWith(allowedRoot)) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: "File not found." });
    }

    const userId = req.user.id;
    const isUserAdmin = req.user.role === "admin";

    // 1. Admin bypass
    if (isUserAdmin) {
      return res.sendFile(targetPath);
    }

    // 2. KYC Upload Authorization
    if (subfolder === "kyc") {
      const kycRows = await db.query(
        `SELECT id FROM kyc_submissions
         WHERE user_id = ?
           AND (id_file LIKE ? OR selfie_file LIKE ? OR biz_file LIKE ? OR incorp_file LIKE ?)`,
        [userId, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`]
      );

      if (kycRows.length > 0) {
        return res.sendFile(targetPath);
      }
      return res.status(403).json({ error: "Access denied: You are not authorized to view this document." });
    }

    // 3. Evidence Upload Authorization
    if (subfolder === "evidence") {
      // Check if file is linked to a transaction where req.user is buyer or seller
      const txRows = await db.query(
        `SELECT t.id FROM transactions t
         LEFT JOIN milestone_submissions s ON s.transaction_id = t.id
         LEFT JOIN evidence_items e ON e.transaction_id = t.id
         WHERE (t.buyer_id = ? OR t.seller_id = ?)
           AND (e.storage_path LIKE ? OR e.original_url LIKE ? OR e.file_name LIKE ? OR s.attachments LIKE ? OR s.submission_data LIKE ?)`,
        [userId, userId, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`]
      );

      if (txRows.length > 0) {
        return res.sendFile(targetPath);
      }

      return res.status(403).json({ error: "Access denied: You are not authorized to view this evidence file." });
    }

    return res.sendFile(targetPath);
  } catch (error) {
    next(error);
  }
});

export default router;
