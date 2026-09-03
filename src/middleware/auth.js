import jwt from 'jsonwebtoken';
import db from '../config/db.js';

export default async function auth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'No token provided, authorization denied.' });
    }

    // Verify token strictly using JWT_SECRET
    if (!process.env.JWT_SECRET) {
      console.error("[AuthMiddleware] Fatal: JWT_SECRET environment variable is missing.");
      return res.status(500).json({ error: "Server authentication misconfiguration." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify session in DB if it has a JTI claim
    if (decoded.jti) {
      const activeSessions = await db.query(
        'SELECT id FROM user_sessions WHERE user_id = ? AND token_jti = ?',
        [decoded.id, decoded.jti]
      );
      if (activeSessions.length === 0) {
        return res.status(401).json({ error: 'Your session has been revoked. Please log in again.' });
      }
      req.sessionJti = decoded.jti;
    }

    // Retrieve user from DB to verify they still exist and get updated information
    const users = await db.query(
      'SELECT id, name, email, role, phone, phone_verified, phone_verified_at, kyc_tier, is_verified, is_active, deleted_at, two_factor_enabled, notif_email, notif_sms, notif_push, public_profile, marketing_comms, portfolio_url, portfolio_verified, portfolio_verified_at FROM users WHERE id = ?',
      [decoded.id]
    );

    if (users.length === 0 || users[0].is_active === 0 || users[0].deleted_at !== null) {
      return res.status(401).json({ error: 'Token is invalid, or account has been deactivated.' });
    }

    // Attach user to request object
    req.user = users[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired.' });
    }
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}
