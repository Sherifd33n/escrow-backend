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

import exchangeRateRoutes   from "./routes/exchangeRate.js";
import notificationsRoutes  from "./routes/notifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Middleware
app.use(
  cors({
    origin: "*", // Allow all origins for local development, can restrict to frontend URL later
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);

// Root check
app.get("/", (req, res) => {
  res.json({ message: "Escrow API is running." });
});

// Exchange rate
app.use("/api/exchange-rate", exchangeRateRoutes);

// Notifications
app.use("/api/notifications", notificationsRoutes);

// Error handling
app.use(errorHandler);

export default app;
