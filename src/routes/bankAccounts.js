import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import paystackService from "../services/paystackService.js";

const router = express.Router();

router.use(authMiddleware);

// Simple memory cache for bank list (refreshed hourly)
let bankListCache = null;
let bankListCacheTime = 0;

/**
 * Mask account number for safe API response
 */
function maskAccountNumber(acctNum) {
  if (!acctNum || acctNum.length < 4) return "****";
  return "*".repeat(acctNum.length - 4) + acctNum.slice(-4);
}

// ======================================================
// GET SUPPORTED BANKS
// ======================================================
router.get("/banks", async (req, res, next) => {
  try {
    const now = Date.now();
    if (bankListCache && now - bankListCacheTime < 3600000) {
      return res.json({ banks: bankListCache });
    }

    const rawBanks = await paystackService.getBanks("nigeria");
    
    // Top priority popular banks
    const topBankCodes = new Set([
      "044", // Access Bank
      "058", // GTBank
      "057", // Zenith Bank
      "011", // First Bank
      "033", // UBA
      "50211", // Kuda Bank
      "999992", // OPay
      "999991", // PalmPay
      "50515", // Moniepoint
      "221", // Stanbic IBTC
      "070", // Fidelity Bank
      "214", // FCMB
      "232", // Sterling Bank
      "035", // Wema Bank
      "050", // Ecobank
      "076", // Polaris Bank
      "032", // Union Bank
      "101", // Providus Bank
      "301", // Jaiz Bank
      "082", // Keystone Bank
    ]);

    const activeBanks = (Array.isArray(rawBanks) ? rawBanks : [])
      .filter((b) => b && b.active !== false)
      .map((b) => ({
        id: b.code,
        name: b.name,
        code: b.code,
        slug: b.slug,
      }));

    // Sort: Top banks first, then remaining banks alphabetically
    activeBanks.sort((a, b) => {
      const aIsTop = topBankCodes.has(a.code);
      const bIsTop = topBankCodes.has(b.code);
      if (aIsTop && !bIsTop) return -1;
      if (!aIsTop && bIsTop) return 1;
      return a.name.localeCompare(b.name);
    });

    bankListCache = activeBanks;
    bankListCacheTime = now;

    res.json({ banks: activeBanks });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// RESOLVE BANK ACCOUNT NUMBER
// ======================================================
router.get("/resolve", async (req, res, next) => {
  const { account_number, bank_code } = req.query;

  if (!account_number || !bank_code) {
    return res.status(400).json({ error: "Both account_number and bank_code are required." });
  }

  if (account_number.length !== 10 || !/^\d+$/.test(account_number)) {
    return res.status(400).json({ error: "Nigerian account numbers must be exactly 10 digits." });
  }

  try {
    const resolved = await paystackService.resolveAccount({
      accountNumber: account_number,
      bankCode: bank_code,
    });

    res.json({
      account_number: resolved.account_number,
      account_name: resolved.account_name,
      bank_id: resolved.bank_id,
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// SAVE BANK ACCOUNT (creates recipient on Paystack)
// ======================================================
router.post("/", async (req, res, next) => {
  const { bankName, bankCode, accountNumber } = req.body;

  if (!bankCode || !accountNumber) {
    return res.status(400).json({ error: "bankCode and accountNumber are required." });
  }

  if (accountNumber.length !== 10 || !/^\d+$/.test(accountNumber)) {
    return res.status(400).json({ error: "Account number must be 10 digits." });
  }

  try {
    // 1. Backend independently resolves account number
    const resolved = await paystackService.resolveAccount({
      accountNumber,
      bankCode,
    });

    const accountHolderName = resolved.account_name;

    // 2. Create Transfer Recipient on Paystack
    const recipient = await paystackService.createTransferRecipient({
      type: "nuban",
      name: accountHolderName,
      accountNumber,
      bankCode,
      currency: "NGN",
    });

    const recipientCode = recipient.recipient_code;

    // 3. Check existing user accounts
    const existing = await db.query(
      "SELECT id FROM bank_accounts WHERE user_id = ? AND bank_code = ? AND account_number = ?",
      [req.user.id, bankCode, accountNumber]
    );

    if (existing.length > 0) {
      // Update recipient_code and name if already present
      await db.query(
        "UPDATE bank_accounts SET recipient_code = ?, account_holder_name = ?, is_verified = 1 WHERE id = ?",
        [recipientCode, accountHolderName, existing[0].id]
      );
      return res.json({
        message: "Bank account updated successfully.",
        account: {
          id: existing[0].id,
          account_holder_name: accountHolderName,
          bank_name: bankName || resolved.bank_name || bankCode,
          bank_code: bankCode,
          masked_account_number: maskAccountNumber(accountNumber),
          is_verified: true,
        },
      });
    }

    // Check if this is user's first account (set default)
    const userAccounts = await db.query(
      "SELECT id FROM bank_accounts WHERE user_id = ?",
      [req.user.id]
    );
    const isDefault = userAccounts.length === 0 ? 1 : 0;

    // 4. Save into bank_accounts table
    const [result] = await db.getPool().query(
      `INSERT INTO bank_accounts
       (user_id, account_holder_name, bank_name, bank_code, account_number, recipient_code, is_verified, is_default)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        req.user.id,
        accountHolderName,
        bankName || bankCode,
        bankCode,
        accountNumber,
        recipientCode,
        isDefault,
      ]
    );

    res.json({
      message: "Bank account added successfully.",
      account: {
        id: result.insertId,
        account_holder_name: accountHolderName,
        bank_name: bankName || bankCode,
        bank_code: bankCode,
        masked_account_number: maskAccountNumber(accountNumber),
        is_verified: true,
        is_default: Boolean(isDefault),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// GET USER BANK ACCOUNTS
// ======================================================
router.get("/", async (req, res, next) => {
  try {
    const accounts = await db.query(
      `SELECT id, account_holder_name, bank_name, bank_code, account_number, is_verified, is_default, created_at
       FROM bank_accounts
       WHERE user_id = ?
       ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    );

    const safeAccounts = accounts.map((acct) => ({
      id: acct.id,
      account_holder_name: acct.account_holder_name,
      bank_name: acct.bank_name,
      bank_code: acct.bank_code,
      masked_account_number: maskAccountNumber(acct.account_number),
      is_verified: Boolean(acct.is_verified),
      is_default: Boolean(acct.is_default),
      created_at: acct.created_at,
    }));

    res.json({ accounts: safeAccounts });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// SET DEFAULT BANK ACCOUNT
// ======================================================
router.patch("/:id/default", async (req, res, next) => {
  const { id } = req.params;

  try {
    const accounts = await db.query(
      "SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: "Bank account not found." });
    }

    const conn = await db.getPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE bank_accounts SET is_default = 0 WHERE user_id = ?", [req.user.id]);
      await conn.query("UPDATE bank_accounts SET is_default = 1 WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ message: "Default bank account updated successfully." });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// DELETE BANK ACCOUNT
// ======================================================
router.delete("/:id", async (req, res, next) => {
  const { id } = req.params;

  try {
    const accounts = await db.query(
      "SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: "Bank account not found." });
    }

    await db.query("DELETE FROM bank_accounts WHERE id = ?", [id]);
    res.json({ message: "Bank account removed successfully." });
  } catch (error) {
    next(error);
  }
});

export default router;
