import db from "../config/db.js";
import crypto from "crypto";


/**
 * Insert a wallet transaction ledger entry with snapshots and metadata.
 */
export async function addWalletTransaction(
  conn,
  walletId,
  type,
  amount,
  description,
  reference,
  currency = "USD",
  balanceBefore = null,
  balanceAfter = null,
  metadata = null,
  status = "completed",
) {
  const metaJson = metadata
    ? typeof metadata === "string"
      ? metadata
      : JSON.stringify(metadata)
    : null;

  await conn.query(
    `
      INSERT INTO wallet_transactions
      (wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      walletId,
      type,
      amount,
      currency,
      description,
      reference,
      balanceBefore,
      balanceAfter,
      metaJson,
      status,
    ],
  );
}

export async function fundEscrow({ conn, transaction, buyerId, amount }) {
  const [wallets] = await conn.query(
    "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
    [buyerId],
  );

  if (!wallets.length) {
    throw new Error("Buyer wallet not found.");
  }

  const wallet = wallets[0];
  const walletCurrency = wallet.currency || "USD";
  const txCurrency = transaction.currency || "USD";

  if (walletCurrency.toUpperCase() !== txCurrency.toUpperCase()) {
    throw new Error(
      `Currency mismatch: wallet is denominated in ${walletCurrency}, but transaction requires ${txCurrency}. Direct cross-currency debit is not permitted.`,
    );
  }

  if (Number(wallet.balance) < Number(amount)) {
    throw new Error("Insufficient wallet balance.");
  }

  const balBefore = parseFloat(wallet.balance) || 0;
  const balAfter = balBefore - Number(amount);

  await conn.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [
    amount,
    wallet.id,
  ]);

  await conn.query(
    `
      UPDATE transactions
      SET escrow_balance = escrow_balance + ?
      WHERE id = ?
    `,
    [amount, transaction.id],
  );

  const reference = `REF-HOLD-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  await addWalletTransaction(
    conn,
    wallet.id,
    "escrow_hold",
    amount,
    `Escrow hold for "${transaction.title}"`,
    reference,
    txCurrency,
    balBefore,
    balAfter,
    { transaction_id: transaction.id, title: transaction.title },
    "completed",
  );

  return {
    wallet,
    balance: balAfter,
  };
}

/**
 * Refund escrow funds back to the buyer.
 * Used when a dispute is resolved in the buyer's favour.
 *
 * @param {object}  conn        - mysql2/promise pooled connection (inside a transaction).
 * @param {object}  transaction - Full transaction row.
 * @param {number}  buyerId     - The buyer's user id.
 * @param {number}  amount      - How much to refund (usually the full escrow_balance).
 * @returns {{ wallet: object, balance: number }}
 */
export async function refundEscrow({ conn, transaction, buyerId, amount }) {
  // 1. Lock and fetch buyer's wallet
  const [wallets] = await conn.query(
    "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
    [buyerId],
  );

  let wallet;

  if (!wallets.length) {
    // Create wallet if it somehow doesn't exist yet (edge case)
    const txCurrency = transaction.currency || "USD";
    const [insert] = await conn.query(
      "INSERT INTO wallets (user_id, balance, currency) VALUES (?, 0, ?)",
      [buyerId, txCurrency],
    );

    const [created] = await conn.query(
      "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
      [insert.insertId],
    );

    wallet = created[0];
  } else {
    wallet = wallets[0];
  }

  const txCurrency = transaction.currency || "USD";
  const balBefore = parseFloat(wallet.balance) || 0;
  const balAfter = balBefore + Number(amount);

  // 2. Credit buyer's wallet balance
  await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
    amount,
    wallet.id,
  ]);

  // 3. Deduct from transaction's escrow_balance
  await conn.query(
    `
      UPDATE transactions
      SET escrow_balance = escrow_balance - ?
      WHERE id = ?
    `,
    [amount, transaction.id],
  );

  // 4. Record the wallet_transaction ledger entry
  const reference = `REF-REFUND-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  await addWalletTransaction(
    conn,
    wallet.id,
    "escrow_refund",
    amount,
    `Escrow refund for "${transaction.title}"`,
    reference,
    txCurrency,
    balBefore,
    balAfter,
    { transaction_id: transaction.id, title: transaction.title, dispute_refund: true },
    "completed",
  );

  return {
    wallet,
    balance: balAfter,
  };
}

export async function releaseEscrow({
  conn,
  transaction,
  recipientId,
  amount,
}) {
  const [wallets] = await conn.query(
    "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
    [recipientId],
  );

  let wallet;
  const txCurrency = transaction.currency || "USD";

  if (!wallets.length) {
    const [insert] = await conn.query(
      "INSERT INTO wallets(user_id, balance, currency) VALUES(?, 0, ?)",
      [recipientId, txCurrency],
    );

    const [created] = await conn.query(
      "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
      [insert.insertId],
    );

    wallet = created[0];
  } else {
    wallet = wallets[0];
  }

  // Calculate escrow fee (default rate 0.0350 unless stored on transaction)
  const feeRate = parseFloat(transaction.escrow_fee_rate || 0.035);
  const releaseAmount = parseFloat(amount || 0);
  const feeAmount = Number((releaseAmount * feeRate).toFixed(2));
  const netPayout = Math.max(0, Number((releaseAmount - feeAmount).toFixed(2)));

  const balBefore = parseFloat(wallet.balance) || 0;
  const balAfter = balBefore + netPayout;

  // Credit net payout to recipient's (seller's) wallet
  await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
    netPayout,
    wallet.id,
  ]);

  // Update transaction's escrow balance and released amount
  await conn.query(
    `
      UPDATE transactions
      SET
        escrow_balance = escrow_balance - ?,
        released_amount = released_amount + ?
      WHERE id = ?
    `,
    [releaseAmount, releaseAmount, transaction.id],
  );

  // Record net payout ledger entry for seller
  const releaseRef = `REF-RELEASE-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  await addWalletTransaction(
    conn,
    wallet.id,
    "escrow_release",
    netPayout,
    `Escrow payout for "${transaction.title}" (Net of ${(feeRate * 100).toFixed(1)}% fee)`,
    releaseRef,
    txCurrency,
    balBefore,
    balAfter,
    {
      transaction_id: transaction.id,
      title: transaction.title,
      gross_amount: releaseAmount,
      fee_amount: feeAmount,
      fee_rate: feeRate,
      net_payout: netPayout,
    },
    "completed",
  );

  // Record escrow fee booking ledger entry if fee > 0
  if (feeAmount > 0) {
    const feeRef = `REF-FEE-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    await addWalletTransaction(
      conn,
      wallet.id,
      "escrow_fee",
      feeAmount,
      `Escrow platform fee (${(feeRate * 100).toFixed(1)}%) for "${transaction.title}"`,
      feeRef,
      txCurrency,
      balBefore,
      balBefore,
      {
        transaction_id: transaction.id,
        title: transaction.title,
        fee_rate: feeRate,
        fee_amount: feeAmount,
      },
      "completed",
    );
  }

  return {
    wallet,
    balance: balAfter,
    feeAmount,
    netPayout,
  };
}

/**
 * Calculate the user's withdrawable available balance.
 * Subtracts pending withdrawal reservations if any exist.
 */
export async function getAvailableBalance(userId, conn = null) {
  // db.query() returns rows directly; conn.query() (raw pool connection) returns [rows, fields].
  // Normalize to always get the rows array.
  const queryFn = conn
    ? async (sql, params) => { const [rows] = await conn.query(sql, params); return rows; }
    : (sql, params) => db.query(sql, params);
  
  const wallets = await queryFn("SELECT balance FROM wallets WHERE user_id = ?", [userId]);
  if (!wallets || wallets.length === 0) return 0;

  const currentBalance = parseFloat(wallets[0].balance) || 0;

  const pending = await queryFn(
    "SELECT COALESCE(SUM(amount), 0) AS reserved FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'processing')",
    [userId]
  );
  
  const reservedAmount = parseFloat(pending[0]?.reserved || 0);

  return Math.max(0, currentBalance - reservedAmount);
}

