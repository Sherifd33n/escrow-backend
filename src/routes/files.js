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
 * Authenticated & authorized file access and download handler
 */
router.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  try {
    const rawSubpath = req.path || req.url || "";
    const cleanSubpath = rawSubpath.split("?")[0].split("#")[0].replace(/^\/+/, "");
    const decodedSubpath = decodeURIComponent(cleanSubpath);
    const parts = decodedSubpath.split("/").filter(Boolean);
    const safeBasename = parts.length > 0 ? path.basename(parts[parts.length - 1]) : "";
    const subfolder = parts.length > 1 ? parts[0] : "";

    const allowedRoot = path.resolve(UPLOADS_DIR);
    let targetPath = parts.length > 0
      ? path.resolve(path.join(UPLOADS_DIR, ...parts))
      : allowedRoot;

    // Check if file exists directly or in common subfolders
    if (!fs.existsSync(targetPath) && safeBasename) {
      const evidenceCandidate = path.resolve(path.join(UPLOADS_DIR, "evidence", safeBasename));
      const kycCandidate = path.resolve(path.join(UPLOADS_DIR, "kyc", safeBasename));
      if (fs.existsSync(evidenceCandidate)) {
        targetPath = evidenceCandidate;
      } else if (fs.existsSync(kycCandidate)) {
        targetPath = kycCandidate;
      }
    }

    // Root jail verification
    if (!targetPath.startsWith(allowedRoot)) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      return res.status(404).json({ error: "File not found." });
    }

    const userId = req.user.id;
    const isUserAdmin = req.user.role === "admin";
    const ext = path.extname(safeBasename).toLowerCase();

    const sendFileWithHeaders = () => {
      if (ext === ".zip" || req.query.download === "1" || req.query.download === "true") {
        if (ext === ".zip") res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${safeBasename}"`);
      }
      return res.sendFile(targetPath);
    };

    // 1. Admin bypass
    if (isUserAdmin) {
      return sendFileWithHeaders();
    }

    // 2. KYC Upload Authorization
    if (subfolder === "kyc" || targetPath.includes(path.sep + "kyc" + path.sep)) {
      const kycRows = await db.query(
        `SELECT id FROM kyc_submissions
         WHERE user_id = ?
           AND (id_file LIKE ? OR selfie_file LIKE ? OR biz_file LIKE ? OR incorp_file LIKE ?)`,
        [userId, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`]
      );

      if (kycRows.length > 0) {
        return sendFileWithHeaders();
      }
      return res.status(403).json({ error: "Access denied: You are not authorized to view this document." });
    }

    // 3. Evidence / Deliverable Upload Authorization
    if (subfolder === "evidence" || targetPath.includes(path.sep + "evidence" + path.sep) || ext === ".zip") {
      // Check if file is linked to a transaction where req.user is buyer or seller
      const txRows = await db.query(
        `SELECT t.id FROM transactions t
         LEFT JOIN milestones m ON m.transaction_id = t.id
         LEFT JOIN milestone_submissions s ON s.transaction_id = t.id
         LEFT JOIN evidence_items e ON e.transaction_id = t.id
         LEFT JOIN disputes d ON d.transaction_id = t.id
         WHERE (t.buyer_id = ? OR t.seller_id = ?)
           AND (
             e.storage_path LIKE ? OR e.original_url LIKE ? OR e.file_name LIKE ? OR
             s.attachments LIKE ? OR s.submission_data LIKE ? OR s.deliverable_note LIKE ? OR
             m.deliverable_note LIKE ? OR d.evidence LIKE ?
           )`,
        [
          userId, userId,
          `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`,
          `%${safeBasename}%`, `%${safeBasename}%`, `%${safeBasename}%`,
          `%${safeBasename}%`, `%${safeBasename}%`
        ]
      );

      if (txRows.length > 0) {
        return sendFileWithHeaders();
      }

      // Fallback: Check if user is buyer/seller on any active transaction on the platform
      const userTx = await db.query(
        `SELECT id FROM transactions WHERE buyer_id = ? OR seller_id = ? LIMIT 1`,
        [userId, userId]
      );

      if (userTx.length > 0) {
        return sendFileWithHeaders();
      }

      return res.status(403).json({ error: "Access denied: You are not authorized to view this evidence file." });
    }

    return sendFileWithHeaders();
  } catch (error) {
    next(error);
  }
});

export default router;
