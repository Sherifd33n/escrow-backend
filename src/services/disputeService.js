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
export async function resolveDispute({ disputeOrTxId, resolution, winner, adminId }) {
  if (!resolution || !String(resolution).trim()) {
    const error = new Error("Resolution text is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!["buyer", "seller"].includes(winner)) {
    const error = new Error('Winner must be either "buyer" or "seller".');
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
    let wallet;
    if (winner === "seller") {
      const result = await releaseEscrow({
        conn,
        transaction,
        recipientId: transaction.seller_id,
        amount: escrowAmount,
      });
      wallet = result.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_released",
        note: `Escrow of $${escrowAmount} released to seller (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          sellerId: transaction.seller_id,
          walletId: wallet ? wallet.id : null,
          amount: escrowAmount,
        },
      });
    } else {
      const result = await refundEscrow({
        conn,
        transaction,
        buyerId: transaction.buyer_id,
        amount: escrowAmount,
      });
      wallet = result.wallet;

      await logTransactionEvent({
        conn,
        transactionId: transaction.id,
        userId: adminId,
        action: "escrow_refunded",
        note: `Escrow of $${escrowAmount} refunded to buyer (dispute resolved).`,
        metadata: {
          disputeId: dispute.id,
          buyerId: transaction.buyer_id,
          walletId: wallet ? wallet.id : null,
          amount: escrowAmount,
        },
      });
    }

    // 6. Update dispute status to resolved
    await conn.query(
      "UPDATE disputes SET status = 'resolved', resolution = ?, updated_at = NOW() WHERE id = ?",
      [cleanResolution, dispute.id]
    );

    // 7. Update milestones status according to dispute winner
    if (winner === "seller") {
      await conn.query("UPDATE milestones SET status = 'approved' WHERE transaction_id = ?", [transaction.id]);
    } else {
      await conn.query("UPDATE milestones SET status = 'rejected' WHERE transaction_id = ?", [transaction.id]);
    }

    // 8. Update transaction status to completed and reset escrow balance
    await conn.query(
      "UPDATE transactions SET status = ?, escrow_balance = 0.00 WHERE id = ?",
      [TRANSACTION_STATUS.COMPLETED, transaction.id]
    );

    // 9. Log administrative dispute resolution event
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
        walletId: wallet ? wallet.id : null,
        resolvedByAdmin: adminId,
      },
    });

    await conn.commit();

    // 10. Send notifications
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

    if (winner === "seller") {
      notify({
        userId: transaction.seller_id,
        type: NOTIFICATION_TYPE.WALLET_FUNDED,
        data: {
          amount: escrowAmount.toFixed(2),
          balance: Number(wallet ? wallet.balance : 0).toFixed(2),
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) => console.error("Notification dispatch error:", err));
    } else {
      notify({
        userId: transaction.buyer_id,
        type: NOTIFICATION_TYPE.WALLET_REFUNDED,
        data: {
          amount: escrowAmount.toFixed(2),
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
      newTransactionStatus: TRANSACTION_STATUS.COMPLETED,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
