import app from "./src/app.js";
import { initDatabase } from "./src/config/db.js";
import dotenv from "dotenv";

dotenv.config();

/* Validate Required Environment Variables */

const requiredEnv = ["JWT_SECRET", "DB_HOST", "DB_USER", "DB_NAME"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 4000;

import { startAuditWorkerLoop } from "./src/services/jobs/auditWorker.js";

async function startServer() {
  try {
    // Initialize MySQL Database
    await initDatabase();

    // Start Durable Background Audit Worker Loop
    startAuditWorkerLoop();

    // Start Express Server
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
