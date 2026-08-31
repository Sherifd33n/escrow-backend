import express from "express";
import crypto from "crypto";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import paystackService from "../services/paystackService.js";
import withdrawalService from "../services/withdrawalService.js";
import { getAvailableBalance } from "../services/walletService.js";
import { getUsdToNgnRate } from "../services/exchangeRateService.js";

const router = express.Router();

router.use(authMiddleware);

// ======================================================
// REQUEST BANK WITHDRAWAL
// ======================================================
router.post("/", async (req, res, next) => {
  const { amount, bankAccountId } = req.body;

  const withdrawAmountUSD = parseFloat(amount);
  if (isNaN(withdrawAmountUSD) || withdrawAmountUSD <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  if (!bankAccountId) {
    return res.status(400).json({ error: "Bank account selection is required." });
  }

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Validate Bank Account Ownership & Verification
    const [bankAccounts] = await conn.query(
      "SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?",
      [bankAccountId, req.user.id]
    );

    if (bankAccounts.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Selected bank account not found or access denied." });
    }

    const bankAccount = bankAccounts[0];
    if (!bankAccount.is_verified) {
      await conn.rollback();
      return res.status(400).json({ error: "Selected bank account is not verified." });
    }

    // 2. Validate User KYC Requirement (Tier 2 minimum for bank withdrawals)
    if (req.user.kyc_tier < 2) {
      await conn.rollback();
      return res.status(403).json({
        error: "Identity verification (KYC Tier 2) is required before requesting bank withdrawals.",
        requireKyc: true,
      });
    }

    // 3. Lock user wallet FOR UPDATE
    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [req.user.id]
    );

    if (wallets.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "User wallet not found." });
    }

    const wallet = wallets[0];

    // 4. Calculate Available (Withdrawable) Balance
    const availableBalance = await getAvailableBalance(req.user.id, conn);

    if (withdrawAmountUSD > availableBalance) {
      await conn.rollback();
      return res.status(400).json({
        error: `Insufficient available balance. You have $${availableBalance.toFixed(2)} available for withdrawal. Funds locked in escrow or reserved for pending withdrawals cannot be withdrawn.`,
      });
    }

    // 5. Get NGN exchange rate for payout conversion
    let usdToNgnRate;
    try {
      usdToNgnRate = await getUsdToNgnRate();
    } catch (err) {
      await conn.rollback();
      return res.status(503).json({
        error: "Unable to fetch exchange rate. Payout processing temporarily unavailable.",
      });
    }

    const ngnAmount = withdrawAmountUSD * usdToNgnRate;
    const amountKobo = Math.round(ngnAmount * 100);

    if (amountKobo < 10000) { // Min ₦100
      await conn.rollback();
      return res.status(400).json({
        error: `Minimum withdrawal amount is $${(100 / usdToNgnRate).toFixed(2)} (₦100).`,
      });
    }

    const reference = `REF-WTH-${Date.now()}-${crypto.randomInt(10000, 99999)}`;

    // 6. Deduct balance from wallet atomically
    const newBalance = parseFloat(wallet.balance) - withdrawAmountUSD;
    await conn.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [
      withdrawAmountUSD,
      wallet.id,
    ]);

    // 7. Insert wallet transaction record
    const [wtxResult] = await conn.query(
      `INSERT INTO wallet_transactions
       (wallet_id, type, amount, currency, description, reference)
       VALUES (?, 'withdrawal', ?, ?, ?, ?)`,
      [
        wallet.id,
        withdrawAmountUSD,
        wallet.currency || 'USD',
        `Bank Payout of ₦${ngnAmount.toLocaleString()} to ${bankAccount.bank_name} (${bankAccount.account_number.slice(-4)})`,
        reference,
      ]
    );

    const walletTxId = wtxResult.insertId;

    // 8. Create pending withdrawal record
    const [wResult] = await conn.query(
      `INSERT INTO withdrawals
       (user_id, bank_account_id, reference, amount, amount_kobo, currency, exchange_rate, provider, status, provider_recipient_code, wallet_transaction_id)
       VALUES (?, ?, ?, ?, ?, 'NGN', ?, 'paystack', 'processing', ?, ?)`,
      [
        req.user.id,
        bankAccount.id,
        reference,
        withdrawAmountUSD,
        amountKobo,
        usdToNgnRate,
        bankAccount.recipient_code,
        walletTxId,
      ]
    );

    const withdrawalId = wResult.insertId;

    // Commit DB changes so reservation is safely persisted
    await conn.commit();

    // 9. Ensure Transfer Recipient Code is available
    let recipientCode = bankAccount.recipient_code;
    if (!recipientCode) {
      try {
        const recipient = await paystackService.createTransferRecipient({
          type: "nuban",
          name: bankAccount.account_holder_name,
          accountNumber: bankAccount.account_number,
          bankCode: bankAccount.bank_code,
          currency: "NGN",
        });
        recipientCode = recipient.recipient_code;
        await db.query("UPDATE bank_accounts SET recipient_code = ? WHERE id = ?", [
          recipientCode,
          bankAccount.id,
        ]);
      } catch (recErr) {
        console.error("[Withdrawals] Recipient creation failed:", recErr.message);
        // Fail withdrawal and restore funds
        await withdrawalService.processWithdrawalFailure({
          reference,
          reason: `Recipient setup failed: ${recErr.message}`,
        });
        return res.status(500).json({ error: "Payout failed: Bank recipient creation error." });
      }
    }

    // 10. Initiate Transfer with Paystack
    try {
      const transferResponse = await paystackService.initiateTransfer({
        source: "balance",
        amountKobo,
        recipientCode,
        reference,
        reason: `Escrow Wallet Payout (Ref: ${reference})`,
      });

      await db.query(
        "UPDATE withdrawals SET provider_transfer_code = ? WHERE id = ?",
        [transferResponse.transfer_code || transferResponse.code || "", withdrawalId]
      );
    } catch (transferErr) {
      console.error("[Withdrawals] Paystack transfer initiation error:", transferErr.message);
      // Synchronous failure: Safely restore funds immediately
      await withdrawalService.processWithdrawalFailure({
        reference,
        reason: transferErr.message,
      });

      return res.status(502).json({
        error: `Bank payout initiation failed: ${transferErr.message}. Your wallet balance has been restored.`,
      });
    }

    res.json({
      message: "Withdrawal request submitted successfully. Transfer is processing.",
      reference,
      status: "processing",
      new_balance: newBalance,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ======================================================
// GET USER WITHDRAWALS HISTORY
// ======================================================
router.get("/", async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const withdrawals = await db.query(
      `SELECT w.id, w.reference, w.amount, w.amount_kobo, w.currency, w.status, w.failure_reason,
              w.requested_at, w.processed_at, b.bank_name, b.account_holder_name, b.account_number
       FROM withdrawals w
       JOIN bank_accounts b ON w.bank_account_id = b.id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    const safeWithdrawals = withdrawals.map((w) => ({
      id: w.id,
      reference: w.reference,
      amount: parseFloat(w.amount),
      currency: w.currency,
      status: w.status,
      failure_reason: w.failure_reason,
      bank_name: w.bank_name,
      account_holder_name: w.account_holder_name,
      masked_account_number: w.account_number ? `*${w.account_number.slice(-4)}` : "****",
      requested_at: w.requested_at,
      processed_at: w.processed_at,
    }));

    res.json({ withdrawals: safeAccounts(safeWithdrawals), page, limit });
  } catch (error) {
    next(error);
  }
});

function safeAccounts(arr) {
  return arr;
}

export default router;
