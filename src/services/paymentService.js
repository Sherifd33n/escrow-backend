import db from "../config/db.js";
import paystackService from "./paystackService.js";
import { notify } from "./notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import crypto from "crypto";

/**
 * Process a successful incoming payment atomically & idempotently.
 * Shared by GET /api/payments/verify/:reference and POST /api/payments/webhook/paystack.
 */
export async function processSuccessfulPayment({ reference, providerData = null, passedConn = null }) {
  const ownConnection = !passedConn;
  const conn = passedConn || (await db.getPool().getConnection());

  try {
    if (ownConnection) {
      await conn.beginTransaction();
    }

    // 1. Fetch payment record FOR UPDATE
    const [payments] = await conn.query(
      "SELECT * FROM payments WHERE reference = ? FOR UPDATE",
      [reference]
    );

    if (!payments || payments.length === 0) {
      throw new Error(`Payment record with reference "${reference}" not found.`);
    }

    const payment = payments[0];

    // 2. Idempotency Check — if already marked success, return immediately with current wallet balance
    if (payment.status === "success") {
      const [wallets] = await conn.query(
        "SELECT balance FROM wallets WHERE user_id = ?",
        [payment.user_id]
      );
      const currentBal = wallets.length > 0 ? parseFloat(wallets[0].balance) : 0;
      if (ownConnection) await conn.commit();
      return {
        alreadyProcessed: true,
        success: true,
        payment,
        balance: currentBal,
        message: "Payment has already been processed and credited.",
      };
    }


    // 3. Fetch latest data from Paystack if providerData not supplied
    let pData = providerData;
    if (!pData) {
      pData = await paystackService.verifyTransaction(reference);
    }

    // 4. Validate Provider Status
    if (pData.status !== "success") {
      await conn.query("UPDATE payments SET status = ? WHERE id = ?", [
        pData.status === "failed" ? "failed" : "abandoned",
        payment.id,
      ]);
      if (ownConnection) await conn.commit();
      return {
        alreadyProcessed: false,
        success: false,
        payment,
        message: `Paystack payment status is ${pData.status}. Wallet not credited.`,
      };
    }

    // 5. Amount Verification (Paystack returns amount in kobo)
    const expectedKobo = Number(payment.amount_kobo);
    const actualKobo = Number(pData.amount);

    // Allow up to 100 kobo (1 NGN) tolerance for edge-case payment gateway fee rounding
    if (isNaN(actualKobo) || Math.abs(expectedKobo - actualKobo) > 100) {
      console.error(
        `[PaymentService] Amount mismatch for ${reference}: expected ${expectedKobo} kobo, got ${actualKobo} kobo`
      );
      await conn.query("UPDATE payments SET status = 'failed' WHERE id = ?", [payment.id]);
      if (ownConnection) await conn.commit();
      throw new Error("Payment verification failed: Amount paid does not match internal record.");
    }

    // 6. Lock and fetch user's wallet
    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [payment.user_id]
    );

    let wallet;
    if (!wallets.length) {
      const [insert] = await conn.query(
        "INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)",
        [payment.user_id]
      );
      const [created] = await conn.query(
        "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
        [insert.insertId]
      );
      wallet = created[0];
    } else {
      wallet = wallets[0];
    }

    // 7. Credit Wallet
    const creditAmountUSD = parseFloat(payment.amount); // stored in USD
    const newBalance = parseFloat(wallet.balance) + creditAmountUSD;

    await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
      creditAmountUSD,
      wallet.id,
    ]);

    // 8. Create Ledger Entry in wallet_transactions
    const walletRef = `REF-DEP-${crypto.randomInt(100000, 999999)}`;
    const ngnFormatted = (Number(payment.amount_kobo) / 100).toLocaleString();
    const rateText = payment.exchange_rate
      ? ` (Rate: ₦${parseFloat(payment.exchange_rate).toLocaleString()}/$)`
      : "";

    const [txResult] = await conn.query(
      `INSERT INTO wallet_transactions
       (wallet_id, type, amount, currency, description, reference)
       VALUES (?, 'deposit', ?, 'USD', ?, ?)`,
      [
        wallet.id,
        creditAmountUSD,
        `Paystack Deposit of ₦${ngnFormatted} converted to $${creditAmountUSD.toFixed(2)}${rateText}`,
        walletRef,
      ]
    );

    const walletTxId = txResult.insertId;

    // 9. Update Payment Record
    await conn.query(
      `UPDATE payments
       SET status = 'success',
           provider_transaction_id = ?,
           provider_reference = ?,
           wallet_transaction_id = ?
       WHERE id = ?`,
      [
        String(pData.id || pData.transaction_id || ""),
        pData.reference || reference,
        walletTxId,
        payment.id,
      ]
    );

    const sendNotification = () => {
      notify({
        userId: payment.user_id,
        type: NOTIFICATION_TYPE.WALLET_FUNDED,
        data: {
          amount: creditAmountUSD.toFixed(2),
          balance: newBalance.toFixed(2),
        },
        email: true,
        sms: true,
        push: true,
      }).catch((err) =>
        console.error("[PaymentService] Failed to trigger Wallet Funded notification:", err)
      );
    };

    if (ownConnection) {
      await conn.commit();
      sendNotification();
    }

    return {
      alreadyProcessed: false,
      success: true,
      balance: newBalance,
      reference,
      walletTxId,
      sendNotification,
    };
  } catch (error) {
    if (ownConnection) {
      await conn.rollback();
    }
    throw error;
  } finally {
    if (ownConnection) {
      conn.release();
    }
  }
}

export default {
  processSuccessfulPayment,
};
