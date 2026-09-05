import db from "../config/db.js";
import { releaseEscrow, refundEscrow } from "./walletService.js";
import { logTransactionEvent } from "./transactionEventService.js";
import { notify } from "./notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import { TRANSACTION_STATUS } from "../core/transactionStatus.js";

/**
 * Shared dispute resolution business logic.
 * Resolves an active dispute in favour of either the buyer or seller.
 *
 * @param {object} params
 * @param {string|number} params.disputeOrTxId - Dispute ID, Transaction ID, or Transaction Code
 * @param {string} params.resolution - Text explanation for the resolution
 * @param {string} params.winner - 'buyer' or 'seller'
 * @param {number} params.adminId - ID of the admin user resolving the dispute
 * @returns {Promise<object>} Result metadata detailing the resolution outcome
 */
export async function resolveDispute({
  disputeOrTxId,
  resolution,
  winner,
  adminId,
  splitDetails = null,
  aiAnalysisId = null,
  adminFeedback = null,
}) {
  if (!resolution || !String(resolution).trim()) {
    const error = new Error("Resolution text is required.");
    error.statusCode = 400;
    throw error;
  }

  const validWinners = ["buyer", "seller", "split"];
  if (!validWinners.includes(winner)) {
    const error = new Error('Winner must be "buyer", "seller", or "split".');
    error.statusCode = 400;
    throw error;
  }

  const cleanResolution = String(resolution).trim();
  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    let transaction = null;
    let dispute = null;

    const numId = Number(disputeOrTxId);

    if (!isNaN(numId)) {
      // 1. Try finding transaction by numeric ID first
      const [txs] = await conn.query(
        "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
        [numId]
      );

      if (txs.length) {
        transaction = txs[0];
      } else {
        // 2. Try finding dispute by numeric ID if transaction not found directly
        const [disputesById] = await conn.query(
          "SELECT * FROM disputes WHERE id = ? FOR UPDATE",
          [numId]
        );
        if (disputesById.length) {
          dispute = disputesById[0];
          const [txsForDispute] = await conn.query(
            "SELECT * FROM transactions WHERE id = ? FOR UPDATE",
            [dispute.transaction_id]
          );
          if (txsForDispute.length) {
            transaction = txsForDispute[0];
          }
        }
      }
    } else {
      // 3. String identifier: lookup transaction by txn_code
      const [txsByCode] = await conn.query(
        "SELECT * FROM transactions WHERE txn_code = ? FOR UPDATE",
        [disputeOrTxId]
      );
      if (txsByCode.length) {
        transaction = txsByCode[0];
      }
    }

    if (!transaction) {
      await conn.rollback();
      const error = new Error("Transaction not found.");
      error.statusCode = 404;
      throw error;
    }

    // If dispute wasn't fetched yet by dispute.id, fetch the latest dispute for this transaction
    if (!dispute) {
      const [disputesForTx] = await conn.query(
        "SELECT * FROM disputes WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [transaction.id]
      );
      if (disputesForTx.length) {
        dispute = disputesForTx[0];
      }
    }

    if (!dispute) {
      await conn.rollback();
      const error = new Error("No dispute found for this transaction.");
      error.statusCode = 404;
      throw error;
    }

    // 4. Validation checks
    if (dispute.status === "resolved") {
      await conn.rollback();
      const error = new Error("This dispute has already been resolved.");
      error.statusCode = 409;
      throw error;
    }

    if (["completed", "cancelled"].includes(transaction.status)) {
      await conn.rollback();
      const error = new Error(`Transaction is already ${transaction.status}.`);
      error.statusCode = 400;
      throw error;
    }

    const escrowAmount = Number(transaction.escrow_balance);
    if (escrowAmount <= 0) {
      await conn.rollback();
      const error = new Error("Escrow balance is empty — cannot release or refund funds.");
      error.statusCode = 400;
      throw error;
    }

    // 5. Move escrow funds based on winner decision
    let buyerRefundAmount = 0;
    let sellerReleaseAmount = 0;
    let buyerWallet = null;
    let sellerWallet = null;

    if (winner === "seller") {
      sellerReleaseAmount = escrowAmount;
      const res = await releaseEscrow({
        conn,
        transaction,
        recipientId: transaction.seller_id,
        amount: sellerReleaseAmount,
      });
      sellerWallet = res.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_released",
        note: `Escrow of $${sellerReleaseAmount} released to seller (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          sellerId: transaction.seller_id,
          walletId: sellerWallet ? sellerWallet.id : null,
          amount: sellerReleaseAmount,
        },
      });
    } else if (winner === "buyer") {
      buyerRefundAmount = escrowAmount;
      const res = await refundEscrow({
        conn,
        transaction,
        buyerId: transaction.buyer_id,
        amount: buyerRefundAmount,
      });
      buyerWallet = res.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_refunded",
        note: `Escrow of $${buyerRefundAmount} refunded to buyer (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          buyerId: transaction.buyer_id,
          walletId: buyerWallet ? buyerWallet.id : null,
          amount: buyerRefundAmount,
        },
      });
    } else if (winner === "split") {
      const buyerPct = Number(splitDetails?.buyerPercentage ?? 50);
      buyerRefundAmount = Number(((escrowAmount * buyerPct) / 100).toFixed(2));
      sellerReleaseAmount = Number((escrowAmount - buyerRefundAmount).toFixed(2));

      if (buyerRefundAmount > 0) {
        const bRes = await refundEscrow({
          conn,
          transaction,
          buyerId: transaction.buyer_id,
          amount: buyerRefundAmount,
        });
        buyerWallet = bRes.wallet;

        await logTransactionEvent({
          conn,
          transactionId: transaction.id,
          userId: adminId,
          action: "escrow_refunded",
          note: `Partial escrow of $${buyerRefundAmount} (${buyerPct}%) refunded to buyer (split dispute resolution).`,
          metadata: {
            disputeId: dispute.id,
            buyerId: transaction.buyer_id,
            walletId: buyerWallet ? buyerWallet.id : null,
            amount: buyerRefundAmount,
          },
        });
      }

      if (sellerReleaseAmount > 0) {
        const sRes = await releaseEscrow({
          conn,
          transaction,
          recipientId: transaction.seller_id,
          amount: sellerReleaseAmount,
        });
        sellerWallet = sRes.wallet;

        await logTransactionEvent({
          conn,
          transactionId: transaction.id,
          userId: adminId,
          action: "escrow_released",
          note: `Partial escrow of $${sellerReleaseAmount} (${100 - buyerPct}%) released to seller (split dispute resolution).`,
          metadata: {
            disputeId: dispute.id,
            sellerId: transaction.seller_id,
            walletId: sellerWallet ? sellerWallet.id : null,
            amount: sellerReleaseAmount,
          },
        });
      }
    }

    // 6. Update dispute status to resolved
    await conn.query(
      "UPDATE disputes SET status = 'resolved', resolution = ?, updated_at = NOW() WHERE id = ?",
      [cleanResolution, dispute.id]
    );

    // 7. Update milestones status according to dispute winner
    if (winner === "seller") {
      await conn.query("UPDATE milestones SET status = 'approved' WHERE transaction_id = ?", [transaction.id]);
    } else if (winner === "buyer") {
      await conn.query("UPDATE milestones SET status = 'rejected' WHERE transaction_id = ?", [transaction.id]);
    } else {
      // Split: mark approved
      await conn.query("UPDATE milestones SET status = 'approved' WHERE transaction_id = ?", [transaction.id]);
    }

    // 8. Update transaction status to completed and reset escrow balance
    await conn.query(
      "UPDATE transactions SET status = ?, escrow_balance = 0.00 WHERE id = ?",
      [TRANSACTION_STATUS.COMPLETED, transaction.id]
    );

    // 9. Link & record AI override / adoption if analysis exists
    try {
      const [aiRows] = await conn.query(
        "SELECT * FROM ai_dispute_analyses WHERE dispute_id = ? ORDER BY analysis_version DESC LIMIT 1",
        [dispute.id]
      );
      if (aiRows.length) {
        const latestAi = aiRows[0];
        const isOverride = latestAi.recommendation && latestAi.recommendation !== winner;
        await conn.query(
          `UPDATE ai_dispute_analyses
           SET admin_override = ?, admin_decision = ?, admin_feedback = ?
           WHERE id = ?`,
          [isOverride, winner, adminFeedback || cleanResolution, latestAi.id]
        );
      }
    } catch (aiErr) {
      console.warn("[disputeService] Could not update ai_dispute_analyses feedback:", aiErr.message);
    }

    // 10. Log administrative dispute resolution event
    await logTransactionEvent({
      conn,
      transactionId: transaction.id,
      userId: adminId,
      action: "dispute_resolved",
      fromStatus: transaction.status,
      toStatus: TRANSACTION_STATUS.COMPLETED,
      note: cleanResolution,
      metadata: {
        disputeId: dispute.id,
        winner,
        amount: escrowAmount,
        buyerRefundAmount,
        sellerReleaseAmount,
        resolvedByAdmin: adminId,
      },
    });

    await conn.commit();

    // 11. Send notifications
    notify({
      userId: transaction.buyer_id,
      type: NOTIFICATION_TYPE.DISPUTE_RESOLVED,
      data: {
        transaction: transaction.title,
        resolution: cleanResolution,
        winner,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    notify({
      userId: transaction.seller_id,
      type: NOTIFICATION_TYPE.DISPUTE_RESOLVED,
      data: {
        transaction: transaction.title,
        resolution: cleanResolution,
        winner,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Notification dispatch error:", err));

    if (sellerReleaseAmount > 0) {
      notify({
        userId: transaction.seller_id,
        type: NOTIFICATION_TYPE.WALLET_FUNDED,
        data: {
          amount: sellerReleaseAmount.toFixed(2),
          balance: Number(sellerWallet ? sellerWallet.balance : 0).toFixed(2),
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    }

    if (buyerRefundAmount > 0) {
      notify({
        userId: transaction.buyer_id,
        type: NOTIFICATION_TYPE.WALLET_REFUNDED,
        data: {
          amount: buyerRefundAmount.toFixed(2),
          transaction: transaction.title,
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    }

    return {
      message: "Dispute resolved successfully.",
      winner,
      amountTransferred: escrowAmount,
      buyerRefundAmount,
      sellerReleaseAmount,
      newTransactionStatus: TRANSACTION_STATUS.COMPLETED,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
