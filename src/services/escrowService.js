import crypto from "crypto";

/**
 * Lock and return a user's wallet.
 */
async function getWallet(conn, userId) {
  const [wallets] = await conn.query(
    "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
    [userId],
  );

  if (!wallets.length) {
    throw new Error("Wallet not found.");
  }

  return wallets[0];
}

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

/**
 * Move buyer funds into escrow.
 */
export async function fundEscrow({ conn, transaction, buyerId, amount }) {
  const wallet = await getWallet(conn, buyerId);

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
 * Release escrow funds to the seller.
 */
export async function releaseEscrow({ conn, transaction, sellerId, amount }) {
  const [wallets] = await conn.query(
    "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
    [sellerId],
  );

  let wallet;

  if (!wallets.length) {
    const [insert] = await conn.query(
      "INSERT INTO wallets (user_id, balance) VALUES (?, 0)",
      [sellerId],
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
