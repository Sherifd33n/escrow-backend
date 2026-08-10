import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import usersRoutes from "./routes/users.js";
import transactionsRoutes from "./routes/transactions.js";
import walletRoutes from "./routes/wallet.js";
import adminRoutes from "./routes/admin.js";
import errorHandler from "./middleware/errorHandler.js";

import exchangeRateRoutes from "./routes/exchangeRate.js";
import notificationsRoutes from "./routes/notifications.js";
import subscriptionsRoutes from "./routes/subscriptions.js";
import aiRoutes from "./routes/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const isDev = process.env.NODE_ENV !== "production";

const devOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const prodFrontendUrl = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.replace(/\/$/, "")
  : null;

if (!prodFrontendUrl) {
  console.warn("[CORS Warning]: FRONTEND_URL environment variable is not set.");
}

// Always include FRONTEND_URL if set, plus localhost origins in dev
const allowedOrigins = [
  ...(isDev ? devOrigins : []),
  ...(prodFrontendUrl ? [prodFrontendUrl] : []),
];

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        (isDev &&
          (origin.startsWith("http://localhost:") ||
            origin.startsWith("http://127.0.0.1:")))
      ) {
        return callback(null, true);
      }
      callback(
        new Error(`CORS policy error: Origin ${origin} is not allowed.`),
      );
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);

// Root check
app.get("/", (req, res) => {
  res.json({
    message: "Escrow API is running.",
    version: "2026-08-05-cors-fix",
    nodeEnv: process.env.NODE_ENV,
    frontendUrl: process.env.FRONTEND_URL,
  });
});

// Exchange rate
app.use("/api/exchange-rate", exchangeRateRoutes);

// Notifications
app.use("/api/notifications", notificationsRoutes);

// Subscriptions & AI
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/ai", aiRoutes);

// Error handling
app.use(errorHandler);

export default app;
