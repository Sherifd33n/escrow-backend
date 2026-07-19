/**
 * middleware/admin.js
 *
 * Restricts a route to admin users only.
 * Must be applied AFTER authMiddleware so req.user is already populated.
 */
export default function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      error: "Access denied. Admins only.",
    });
  }
  next();
}
