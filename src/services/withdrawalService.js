import db from "../config/db.js";
import paystackService from "./paystackService.js";
import { notify } from "./notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import crypto from "crypto";

/**
 * Handle successful bank withdrawal payout confirmation.
 */
export async function processWithdrawalSuccess({ reference, providerData = null, passedConn = null }) {
  const ownConnection = !passedConn;
  const conn = passedConn || (await db.getPool().getConnection());

  try {
    if (ownConnection) await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM withdrawals WHERE reference = ? FOR UPDATE",
      [reference]
    );

    if (!rows.length) {
      throw new Error(`Withdrawal record with reference "${reference}" not found.`);
    }

    const withdrawal = rows[0];

    // Idempotency: If already finalized as success, do nothing
    if (withdrawal.status === "success") {
      if (ownConnection) await conn.commit();
      return { alreadyProcessed: true, withdrawal };
    }

    // Mark withdrawal as successful
    await conn.query(
      `UPDATE withdrawals
       SET status = 'success',
           processed_at = NOW(),
           provider_transfer_code = ?
       WHERE id = ?`,
      [
        providerData?.transfer_code || providerData?.code || withdrawal.provider_transfer_code,
        withdrawal.id,
      ]
    );

    if (ownConnection) await conn.commit();

    // Notify user of successful withdrawal
    notify({
      userId: withdrawal.user_id,
      type: NOTIFICATION_TYPE.WALLET_WITHDRAWN,
      data: {
        amount: parseFloat(withdrawal.amount).toFixed(2),
        reference,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) =>
      console.error("[WithdrawalService] Failed to trigger withdrawal notification:", err)
    );

    return { alreadyProcessed: false, success: true, withdrawal };
  } catch (error) {
    if (ownConnection) await conn.rollback();
    throw error;
  } finally {
    if (ownConnection) conn.release();
  }
}

/**
 * Handle failed bank transfer — restore reserved funds back to user's wallet exactly once.
 */
export async function processWithdrawalFailure({
  reference,
  reason = "Paystack transfer failed",
  providerData = null,
  passedConn = null,
}) {
  const ownConnection = !passedConn;
  const conn = passedConn || (await db.getPool().getConnection());

  try {
    if (ownConnection) await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM withdrawals WHERE reference = ? FOR UPDATE",
      [reference]
    );

    if (!rows.length) {
      throw new Error(`Withdrawal record with reference "${reference}" not found.`);
    }

    const withdrawal = rows[0];

    // Idempotency: If already marked failed or reversed, do NOT restore funds again!
    if (["failed", "reversed", "cancelled"].includes(withdrawal.status)) {
      if (ownConnection) await conn.commit();
      return { alreadyProcessed: true, withdrawal };
    }

    // Lock user's wallet
    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [withdrawal.user_id]
    );

    if (wallets.length > 0) {
      const wallet = wallets[0];
      const restoreAmount = parseFloat(withdrawal.amount);

      // Restore funds to wallet
      await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
        restoreAmount,
        wallet.id,
      ]);

      // Create restoration ledger entry
      const refCode = `REF-WTH-FAIL-${crypto.randomInt(100000, 999999)}`;
      await conn.query(
        `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference)
         VALUES (?, 'deposit', ?, ?, ?)`,
        [
          wallet.id,
          restoreAmount,
          `Failed Withdrawal Refund (${reason}) [Ref: ${reference}]`,
          refCode,
        ]
      );
    }

    // Update withdrawal record
    await conn.query(
      `UPDATE withdrawals
       SET status = 'failed',
           failure_reason = ?,
           processed_at = NOW()
       WHERE id = ?`,
      [reason, withdrawal.id]
    );

    if (ownConnection) await conn.commit();

    // Notify user of failed withdrawal
    notify({
      userId: withdrawal.user_id,
      type: NOTIFICATION_TYPE.WALLET_REFUNDED,
      data: {
        amount: parseFloat(withdrawal.amount).toFixed(2),
        reason,
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) =>
      console.error("[WithdrawalService] Failed to trigger withdrawal failure notification:", err)
    );

    return { alreadyProcessed: false, success: true, withdrawal };
  } catch (error) {
    if (ownConnection) await conn.rollback();
    throw error;
  } finally {
    if (ownConnection) conn.release();
  }
}

/**
 * Handle reversed bank transfer — restore funds to user wallet idempotently.
 */
export async function processWithdrawalReversal({
  reference,
  reason = "Paystack transfer reversed by recipient bank",
  providerData = null,
  passedConn = null,
}) {
  const ownConnection = !passedConn;
  const conn = passedConn || (await db.getPool().getConnection());

  try {
    if (ownConnection) await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM withdrawals WHERE reference = ? FOR UPDATE",
      [reference]
    );

    if (!rows.length) {
      throw new Error(`Withdrawal record with reference "${reference}" not found.`);
    }

    const withdrawal = rows[0];

    // Idempotency: If already marked reversed or failed, do NOT restore again
    if (["reversed", "failed", "cancelled"].includes(withdrawal.status)) {
      if (ownConnection) await conn.commit();
      return { alreadyProcessed: true, withdrawal };
    }

    // Lock user's wallet
    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [withdrawal.user_id]
    );

    if (wallets.length > 0) {
      const wallet = wallets[0];
      const restoreAmount = parseFloat(withdrawal.amount);

      // Restore balance
      await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
        restoreAmount,
        wallet.id,
      ]);

      // Create ledger entry
      const refCode = `REF-WTH-REV-${crypto.randomInt(100000, 999999)}`;
      await conn.query(
        `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference)
         VALUES (?, 'deposit', ?, ?, ?)`,
        [
          wallet.id,
          restoreAmount,
          `Reversed Withdrawal Restored (${reason}) [Ref: ${reference}]`,
          refCode,
        ]
      );
    }

    // Update withdrawal record
    await conn.query(
      `UPDATE withdrawals
       SET status = 'reversed',
           failure_reason = ?,
           processed_at = NOW()
       WHERE id = ?`,
      [reason, withdrawal.id]
    );

    if (ownConnection) await conn.commit();

    notify({
      userId: withdrawal.user_id,
      type: NOTIFICATION_TYPE.WALLET_REFUNDED,
      data: {
        amount: parseFloat(withdrawal.amount).toFixed(2),
        reason: "Withdrawal transfer was reversed",
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) =>
      console.error("[WithdrawalService] Failed to trigger withdrawal reversal notification:", err)
    );

    return { alreadyProcessed: false, success: true, withdrawal };
  } catch (error) {
    if (ownConnection) await conn.rollback();
    throw error;
  } finally {
    if (ownConnection) conn.release();
  }
}

export default {
  processWithdrawalSuccess,
  processWithdrawalFailure,
  processWithdrawalReversal,
};
