import rateLimit from "express-rate-limit";

/**
 * Auth Rate Limiter
 * Restricts login, signup, forgot password, and reset password endpoints.
 * Allows up to 10 requests per 15-minute window per IP address.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    error: "Too many login/auth attempts from this IP. Please try again after 15 minutes.",
  },
});

/**
 * OTP Rate Limiter
 * Restricts OTP generation, resend, and verification endpoints.
 * Allows up to 5 requests per 10-minute window per IP address.
 */
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many OTP requests from this IP. Please try again after 10 minutes.",
  },
});

/**
 * General API Rate Limiter
 * Protects public or high-frequency endpoints.
 * Allows up to 300 requests per 15-minute window per IP address.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later.",
  },
});
