/**
 * deadlineWorker.js
 *
 * Background worker that regularly scans active escrow transactions and milestones
 * for passed deadlines where the provider is yet to submit deliverables, and
 * dispatches email, push, and SMS notifications reminding them to submit work.
 */

import db from "../../config/db.js";
import { notify } from "../notificationService.js";
import { NOTIFICATION_TYPE } from "../../constants/notificationTypes.js";
import { logTransactionEvent } from "../transactionEventService.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
let workerInterval = null;
let isChecking = false;

/**
 * Helper to parse human-readable durations like "5 days", "14 days", "1 month"
 * into milliseconds. Returns null if unparseable.
 */
export function parseDurationToMs(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return null;
  const str = durationStr.trim().toLowerCase();

  const daysMatch = str.match(/^(\d+)\s*(?:day|days|d)$/);
  if (daysMatch) return parseInt(daysMatch[1], 10) * 24 * 60 * 60 * 1000;

  const weeksMatch = str.match(/^(\d+)\s*(?:week|weeks|w)$/);
  if (weeksMatch) return parseInt(weeksMatch[1], 10) * 7 * 24 * 60 * 60 * 1000;

  const monthsMatch = str.match(/^(\d+)\s*(?:month|months|m)$/);
  if (monthsMatch) return parseInt(monthsMatch[1], 10) * 30 * 24 * 60 * 60 * 1000;

  const hoursMatch = str.match(/^(\d+)\s*(?:hour|hours|h)$/);
  if (hoursMatch) return parseInt(hoursMatch[1], 10) * 60 * 60 * 1000;

  return null;
}

/**
 * Scan database for transactions & milestones whose agreed deadline has been reached/passed
 * and whose provider is yet to submit the deliverable.
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

    const frontendBaseUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

    // -------------------------------------------------------------------------
    // 1. Check transactions with explicit agreed_deadline that passed
    // -------------------------------------------------------------------------
    const [transactionsWithDeadline] = await pool.query(`
      SELECT 
        t.id, 
        t.txn_code, 
        t.title, 
        t.amount, 
        t.currency, 
        t.status, 
        t.agreed_duration, 
        t.agreed_deadline, 
        t.created_at,
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

    // -------------------------------------------------------------------------
    // 2. Check active transactions where agreed_deadline is NULL but duration/review_days exist
    // -------------------------------------------------------------------------
    const [transactionsWithDuration] = await pool.query(`
      SELECT 
        t.id, 
        t.txn_code, 
        t.title, 
        t.amount, 
        t.currency, 
        t.status, 
        t.agreed_duration, 
        t.agreed_deadline, 
        t.review_days,
        t.created_at,
        t.buyer_id, 
        t.seller_id,
        u_seller.name AS seller_name,
        u_seller.email AS seller_email
      FROM transactions t
      JOIN users u_seller ON t.seller_id = u_seller.id
      WHERE t.status IN ('funded', 'inprogress', 'revision')
        AND t.agreed_deadline IS NULL
        AND t.deadline_notified_at IS NULL
      ORDER BY t.created_at ASC
      LIMIT 50
    `);

    // Combine candidate transactions
    const candidatesMap = new Map();

    for (const tx of transactionsWithDeadline) {
      candidatesMap.set(tx.id, {
        ...tx,
        effectiveDeadline: new Date(tx.agreed_deadline),
      });
    }

    const nowTime = Date.now();

    for (const tx of transactionsWithDuration) {
      if (candidatesMap.has(tx.id)) continue;

      let durationMs = parseDurationToMs(tx.agreed_duration);
      if (!durationMs && tx.review_days) {
        durationMs = Number(tx.review_days) * 24 * 60 * 60 * 1000;
      }

      if (durationMs) {
        const createdAtTime = new Date(tx.created_at).getTime();
        const computedDeadlineTime = createdAtTime + durationMs;

        if (computedDeadlineTime <= nowTime) {
          candidatesMap.set(tx.id, {
            ...tx,
            effectiveDeadline: new Date(computedDeadlineTime),
          });
        }
      }
    }

    const candidateList = Array.from(candidatesMap.values());

    if (candidateList.length > 0) {
      console.log(`[deadlineWorker] Found ${candidateList.length} candidate overdue transaction(s) requiring verification.`);
    }

    for (const tx of candidateList) {
      try {
        // Verify if provider has unsubmitted deliverables
        const [milestones] = await pool.query(
          "SELECT id, title, status, due_date FROM milestones WHERE transaction_id = ?",
          [tx.id]
        );

        // If transaction has milestones, check if all are already submitted/approved
        if (milestones.length > 0) {
          const unsubmittedMilestones = milestones.filter(
            (m) => !["submitted", "approved"].includes(m.status)
          );

          if (unsubmittedMilestones.length === 0) {
            // All deliverables already submitted/approved! Mark deadline_notified_at to avoid re-checking
            await pool.query(
              "UPDATE transactions SET deadline_notified_at = NOW() WHERE id = ?",
              [tx.id]
            );
            continue;
          }
        }

        const deadlineDate = tx.effectiveDeadline || new Date(tx.agreed_deadline || Date.now());
        const formattedDeadline = deadlineDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
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
            dashboardUrl: `${frontendBaseUrl}`,
          },
          email: true,
          push: true,
          sms: true,
          metadata: {
            transactionId: tx.id,
            txnCode: tx.txn_code,
            agreedDeadline: deadlineDate.toISOString(),
          },
        });

        // 2. Mark deadline as notified to prevent duplicate reminder spam
        await pool.query(
          "UPDATE transactions SET deadline_notified_at = NOW() WHERE id = ?",
          [tx.id]
        );

        // 3. Log audit event
        await logTransactionEvent({
          transactionId: tx.id,
          userId: tx.seller_id,
          action: "deadline_reached_notification_sent",
          note: `Automated deadline reminder email dispatched to provider (${tx.seller_email}) for reached deadline ${formattedDeadline}.`,
          metadata: {
            deadline: deadlineDate.toISOString(),
            notifiedAt: new Date().toISOString(),
          },
        });

        console.log(`[deadlineWorker] Deadline reminder email successfully dispatched for ${tx.txn_code} to ${tx.seller_email}`);
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
  }, 3000);

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
