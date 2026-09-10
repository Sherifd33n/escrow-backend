import "dotenv/config";
import dns from "dns";

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}
try {
  dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch (e) {
  // Ignore in case environment restricts custom DNS
}

/* Validate Required Environment Variables */
const requiredEnv = ["JWT_SECRET", "DB_HOST", "DB_USER", "DB_NAME"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

import app from "./src/app.js";
import { initDatabase } from "./src/config/db.js";
import { startAuditWorkerLoop } from "./src/services/jobs/auditWorker.js";
import { startDeadlineWorkerLoop } from "./src/services/jobs/deadlineWorker.js";

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    // Initialize MySQL Database
    await initDatabase();

    // Start Durable Background Audit Worker Loop
    startAuditWorkerLoop();

    // Start Automated Deadline Check Worker Loop
    startDeadlineWorkerLoop();

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
