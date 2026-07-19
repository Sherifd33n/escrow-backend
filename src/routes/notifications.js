/**
 * routes/notifications.js
 *
 * Authenticated REST endpoints for the notification inbox.
 *
 * GET    /notifications             - Paginated list (newest first)
 * GET    /notifications/unread-count - Count of unread notifications
 * PATCH  /notifications/:id/read   - Mark one notification as read
 * PATCH  /notifications/read-all   - Mark all notifications as read
 * DELETE /notifications/:id        - Delete one notification
 *
 * All endpoints are scoped to req.user.id — users can only see/modify
 * their own notifications.
 */

import express       from "express";
import db            from "../config/db.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

// All routes in this file require authentication.
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// GET /notifications
// Returns paginated notifications for the current user, newest first.
// Query params: page (default 1), limit (default 20, max 100)
// ---------------------------------------------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [notifications, [{ total }]] = await Promise.all([
      db.query(
        `SELECT id, type, title, message, channel, is_read, metadata, created_at
         FROM notifications
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, limit, offset],
      ),
      db.query(
        "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?",
        [userId],
      ),
    ]);

    res.json({
      notifications,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /notifications/unread-count
// Must be defined BEFORE /:id routes to avoid Express treating "unread-count"
// as an :id parameter.
// ---------------------------------------------------------------------------
router.get("/unread-count", async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [{ count }] = await db.query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
      [userId],
    );

    res.json({ count });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// PATCH /notifications/read-all
// Mark every unread notification for the user as read.
// ---------------------------------------------------------------------------
router.patch("/read-all", async (req, res, next) => {
  try {
    const userId = req.user.id;

    await db.query(
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
      [userId],
    );

    res.json({ message: "All notifications marked as read." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// PATCH /notifications/:id/read
// Mark a single notification as read.
// ---------------------------------------------------------------------------
router.patch("/:id/read", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const notifId = parseInt(req.params.id);

    if (isNaN(notifId)) {
      return res.status(400).json({ error: "Invalid notification ID." });
    }

    const notifications = await db.query(
      "SELECT id FROM notifications WHERE id = ? AND user_id = ?",
      [notifId, userId],
    );

    if (!notifications.length) {
      return res.status(404).json({ error: "Notification not found." });
    }

    await db.query(
      "UPDATE notifications SET is_read = 1 WHERE id = ?",
      [notifId],
    );

    res.json({ message: "Notification marked as read." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// DELETE /notifications/:id
// Delete a single notification (user-owned only).
// ---------------------------------------------------------------------------
router.delete("/:id", async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const notifId = parseInt(req.params.id);

    if (isNaN(notifId)) {
      return res.status(400).json({ error: "Invalid notification ID." });
    }

    const notifications = await db.query(
      "SELECT id FROM notifications WHERE id = ? AND user_id = ?",
      [notifId, userId],
    );

    if (!notifications.length) {
      return res.status(404).json({ error: "Notification not found." });
    }

    await db.query("DELETE FROM notifications WHERE id = ?", [notifId]);

    res.json({ message: "Notification deleted." });
  } catch (error) {
    next(error);
  }
});

export default router;
