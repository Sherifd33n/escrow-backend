import jwt from 'jsonwebtoken';
import db from '../config/db.js';

export default async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided, authorization denied.' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'escrow_super_secret_key_change_in_production_2025');

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
      'SELECT id, name, email, role, phone, phone_verified, phone_verified_at, kyc_tier, is_verified, two_factor_enabled, notif_email, notif_sms, notif_push, public_profile, marketing_comms FROM users WHERE id = ?',
      [decoded.id]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Token is invalid or user does not exist.' });
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
