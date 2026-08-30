import db from "../config/db.js";
import crypto from "crypto";


/**
 * Insert a wallet transaction.
 */
async function addWalletTransaction(
  conn,
  walletId,
  type,
  amount,
  description,
  reference,
) {
  await conn.query(
    `
      INSERT INTO wallet_transactions
      (wallet_id, type, amount, description, reference)
      VALUES (?, ?, ?, ?, ?)
    `,
    [walletId, type, amount, description, reference],
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

  if (Number(wallet.balance) < Number(amount)) {
    throw new Error("Insufficient wallet balance.");
  }

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
  );

  return {
    wallet,
    balance: Number(wallet.balance) - Number(amount),
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
    const [insert] = await conn.query(
      "INSERT INTO wallets (user_id, balance) VALUES (?, 0)",
      [buyerId],
    );

    const [created] = await conn.query(
      "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
      [insert.insertId],
    );

    wallet = created[0];
  } else {
    wallet = wallets[0];
  }

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
  );

  return {
    wallet,
    balance: Number(wallet.balance) + Number(amount),
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

  if (!wallets.length) {
    const [insert] = await conn.query(
      "INSERT INTO wallets(user_id, balance) VALUES(?, 0)",
      [recipientId],
    );

    const [created] = await conn.query(
      "SELECT * FROM wallets WHERE id = ? FOR UPDATE",
      [insert.insertId],
    );

    wallet = created[0];
  } else {
    wallet = wallets[0];
  }

  await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
    amount,
    wallet.id,
  ]);

  await conn.query(
    `
      UPDATE transactions
      SET
        escrow_balance = escrow_balance - ?,
        released_amount = released_amount + ?
      WHERE id = ?
    `,
    [amount, amount, transaction.id],
  );

  const reference = `REF-RELEASE-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  await addWalletTransaction(
    conn,
    wallet.id,
    "escrow_release",
    amount,
    `Escrow payout for "${transaction.title}"`,
    reference,
  );

  return {
    wallet,
    balance: Number(wallet.balance) + Number(amount),
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

