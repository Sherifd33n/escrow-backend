import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import crypto from "crypto";
import { notify } from "../services/notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";

const router = express.Router();

// Apply auth middleware to all routes in this router
router.use(authMiddleware);

// Helper to get or create wallet for user
async function getOrCreateWallet(userId, conn = db, lock = false) {
  const sql = lock
    ? "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE"
    : "SELECT * FROM wallets WHERE user_id = ?";

  let results;

  if (conn.getPool) {
    results = await conn.query(sql, [userId]);
  } else {
    const [rows] = await conn.query(sql, [userId]);
    results = rows;
  }

  if (results && results.length > 0) {
    return results[0];
  }

  // Create wallet if it doesn't exist
  await conn.query("INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)", [
    userId,
  ]);

  if (conn.getPool) {
    results = await conn.query(sql, [userId]);
  } else {
    const [rows] = await conn.query(sql, [userId]);
    results = rows;
  }

  return results[0];
}

// ======================================================
// GET WALLET
// ======================================================

router.get("/", async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);

    res.json(wallet);
  } catch (error) {
    next(error);
  }
});

// ======================================================
// DEPOSIT
// ======================================================

router.post("/deposit", async (req, res, next) => {
  const { amount } = req.body;

  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    const wallet = await getOrCreateWallet(req.user.id, conn, true);

    const NGN_USD_RATE = 1381.215;

    const amountInUSD = parseFloat(amount) / NGN_USD_RATE;

    const newBalance = parseFloat(wallet.balance) + amountInUSD;

    await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
      amountInUSD,
      wallet.id,
    ]);

    const reference = `REF-DEP-${crypto.randomInt(100000, 999999)}`;

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, description, reference)
      VALUES (?, 'deposit', ?, ?, ?)`,
      [
        wallet.id,
        amountInUSD,
        `Deposit of ₦${parseFloat(amount).toLocaleString()} converted to USD (Rate: ₦${NGN_USD_RATE.toLocaleString()}/$)`,
        reference,
      ],
    );

    await conn.commit();

    notify({
      userId: req.user.id,
      type: NOTIFICATION_TYPE.WALLET_FUNDED,
      data: {
        amount: amountInUSD.toFixed(2),
        balance: newBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Funded notification:", err));

    res.json({
      message: "Funds deposited successfully.",
      balance: newBalance,
      reference,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ======================================================
// WITHDRAW
// ======================================================

router.post("/withdraw", async (req, res, next) => {
  const { amount, bankId, accountNumber } = req.body;

  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    const wallet = await getOrCreateWallet(req.user.id, conn, true);

    const withdrawAmt = parseFloat(amount);

    const balance = parseFloat(wallet.balance);

    if (balance < withdrawAmt) {
      await conn.rollback();

      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    const newBalance = balance - withdrawAmt;

    await conn.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [
      withdrawAmt,
      wallet.id,
    ]);

    const reference = `REF-WTH-${crypto.randomInt(100000, 999999)}`;

    const bankMsg = bankId
      ? ` to Bank [${bankId}] Acc: ${accountNumber || "N/A"}`
      : "";

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, description, reference)
      VALUES (?, 'withdrawal', ?, ?, ?)`,
      [wallet.id, withdrawAmt, `Withdrawal from wallet${bankMsg}`, reference],
    );

    await conn.commit();

    notify({
      userId: req.user.id,
      type: NOTIFICATION_TYPE.WALLET_WITHDRAWN,
      data: {
        amount: withdrawAmt.toFixed(2),
        balance: newBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Withdrawn notification:", err));

    res.json({
      message: "Withdrawal completed successfully.",
      balance: newBalance,
      reference,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ======================================================
// TRANSFER
// ======================================================

router.post("/transfer", async (req, res, next) => {
  const { amount, recipientEmail, note } = req.body;

  const userId = req.user.id;

  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  if (!recipientEmail) {
    return res.status(400).json({ error: "Recipient email is required." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    const senderWallet = await getOrCreateWallet(userId, conn, true);

    const transferAmt = parseFloat(amount);

    const senderBalance = parseFloat(senderWallet.balance);

    if (senderBalance < transferAmt) {
      await conn.rollback();

      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    const [recipients] = await conn.query(
      "SELECT id, name FROM users WHERE email = ?",
      [recipientEmail.trim().toLowerCase()],
    );

    if (recipients.length === 0) {
      await conn.rollback();

      return res.status(404).json({
        error: `Recipient with email "${recipientEmail}" not found.`,
      });
    }

    const recipientId = recipients[0].id;

    if (recipientId === userId) {
      await conn.rollback();

      return res
        .status(400)
        .json({ error: "Cannot transfer money to yourself." });
    }

    const recipientWallet = await getOrCreateWallet(recipientId, conn, true);

    const newSenderBalance = senderBalance - transferAmt;

    const newRecipientBalance =
      parseFloat(recipientWallet.balance) + transferAmt;

    await conn.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [
      transferAmt,
      senderWallet.id,
    ]);

    await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
      transferAmt,
      recipientWallet.id,
    ]);

    const reference = `REF-TRF-${crypto.randomInt(100000, 999999)}`;

    const transferNote = note ? ` (${note})` : "";

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, description, reference)
      VALUES (?, 'withdrawal', ?, ?, ?)`,
      [
        senderWallet.id,
        transferAmt,
        `Transfer to ${recipients[0].name}${transferNote}`,
        reference,
      ],
    );

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, description, reference)
      VALUES (?, 'deposit', ?, ?, ?)`,
      [
        recipientWallet.id,
        transferAmt,
        `Transfer from ${req.user.name}${transferNote}`,
        `REF-REC-${crypto.randomInt(100000, 999999)}`,
      ],
    );

    await conn.commit();

    notify({
      userId,
      type: NOTIFICATION_TYPE.WALLET_WITHDRAWN,
      data: {
        amount: transferAmt.toFixed(2),
        balance: newSenderBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Withdrawn notification for sender:", err));

    notify({
      userId: recipientId,
      type: NOTIFICATION_TYPE.WALLET_FUNDED,
      data: {
        amount: transferAmt.toFixed(2),
        balance: newRecipientBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Funded notification for recipient:", err));

    res.json({
      message: "Transfer completed successfully.",
      balance: newSenderBalance,
      reference,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ======================================================
// HISTORY
// ======================================================

router.get("/history", async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;

  const limit = 20;

  const offset = (page - 1) * limit;

  try {
    const wallet = await getOrCreateWallet(req.user.id);

    const history = await db.query(
      `SELECT *
       FROM wallet_transactions
       WHERE wallet_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [wallet.id, limit, offset],
    );

    res.json({
      history,
      page,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
