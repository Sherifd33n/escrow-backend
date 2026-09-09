/**
 * deadlineWorker.js
 *
 * Background worker that regularly scans active escrow transactions for passed deadlines
 * and dispatches email, push, and SMS notifications to providers reminding them to submit
 * their deliverables in adherence with the contract agreement.
 */

import db from "../../config/db.js";
import { notify } from "../notificationService.js";
import { NOTIFICATION_TYPE } from "../../constants/notificationTypes.js";
import { logTransactionEvent } from "../transactionEventService.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
let workerInterval = null;
let isChecking = false;

/**
 * Scan database for transactions whose agreed deadline has been reached/passed
 * and whose provider has not yet been notified.
 */
export async function checkAndNotifyExpiredDeadlines() {
  if (isChecking) return;
  isChecking = true;

  try {
    const pool = db.getPool();
    if (!pool) {
      isChecking = false;
      return;
    }

    // Query active transactions whose deadline has arrived and not yet notified
    const [transactions] = await pool.query(`
      SELECT 
        t.id, 
        t.txn_code, 
        t.title, 
        t.amount, 
        t.currency, 
        t.status, 
        t.agreed_duration, 
        t.agreed_deadline, 
        t.buyer_id, 
        t.seller_id,
        u_seller.name AS seller_name,
        u_seller.email AS seller_email
      FROM transactions t
      JOIN users u_seller ON t.seller_id = u_seller.id
      WHERE t.status IN ('funded', 'inprogress', 'revision')
        AND t.agreed_deadline IS NOT NULL
        AND t.agreed_deadline <= NOW()
        AND t.deadline_notified_at IS NULL
      ORDER BY t.agreed_deadline ASC
      LIMIT 50
    `);

    if (transactions.length > 0) {
      console.log(`[deadlineWorker] Found ${transactions.length} transaction(s) reaching submission deadline.`);
    }

    const frontendBaseUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

    for (const tx of transactions) {
      try {
        const formattedDeadline = new Date(tx.agreed_deadline).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        // 1. Dispatch email, push, SMS, and in-app notification to provider
        await notify({
          userId: tx.seller_id,
          type: NOTIFICATION_TYPE.TRANSACTION_DEADLINE_REACHED,
          data: {
            transaction: tx.title,
            code: tx.txn_code,
            deadline: formattedDeadline,
            amount: parseFloat(tx.amount || 0).toFixed(2),
            recipientName: tx.seller_name || "Provider",
            dashboardUrl: `${frontendBaseUrl}/dashboard/vendor`,
          },
          email: true,
          push: true,
          sms: true,
          metadata: {
            transactionId: tx.id,
            txnCode: tx.txn_code,
            agreedDeadline: tx.agreed_deadline,
          },
        });

        // 2. Mark deadline as notified to avoid duplicate alerts
        await pool.query(
          "UPDATE transactions SET deadline_notified_at = NOW() WHERE id = ?",
          [tx.id]
        );

        // 3. Log audit event
        await logTransactionEvent({
          transactionId: tx.id,
          userId: tx.seller_id,
          action: "deadline_reached_notification_sent",
          note: `Automated deadline alert sent to provider (${tx.seller_email}) for reached deadline ${formattedDeadline}.`,
          metadata: {
            deadline: tx.agreed_deadline,
            notifiedAt: new Date().toISOString(),
          },
        });

        console.log(`[deadlineWorker] Deadline notification successfully dispatched for ${tx.txn_code} to ${tx.seller_email}`);
      } catch (itemErr) {
        console.error(`[deadlineWorker] Failed to process deadline alert for transaction ${tx.txn_code}:`, itemErr.message);
      }
    }
  } catch (err) {
    console.error("[deadlineWorker] Error executing deadline scan loop:", err.message);
  } finally {
    isChecking = false;
  }
}

/**
 * Start recurring background deadline checker loop.
 */
export function startDeadlineWorkerLoop(intervalMs = CHECK_INTERVAL_MS) {
  if (workerInterval) {
    clearInterval(workerInterval);
  }

  console.log(`[deadlineWorker] Starting deadline worker loop (interval: ${intervalMs / 1000}s)...`);

  // Run initial scan after a short startup delay
  setTimeout(() => {
    checkAndNotifyExpiredDeadlines().catch((err) =>
      console.error("[deadlineWorker] Initial deadline scan failed:", err.message)
    );
  }, 5000);

  workerInterval = setInterval(() => {
    checkAndNotifyExpiredDeadlines().catch((err) =>
      console.error("[deadlineWorker] Recurring deadline scan failed:", err.message)
    );
  }, intervalMs);
}

/**
 * Stop recurring background deadline checker loop.
 */
export function stopDeadlineWorkerLoop() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log("[deadlineWorker] Stopped deadline worker loop.");
  }
}
