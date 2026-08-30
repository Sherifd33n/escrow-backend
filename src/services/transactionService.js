import { validateTransition } from "../core/transactionValidator.js";

export async function updateTransactionStatus({
  conn,
  transaction,
  userId,
  nextStatus,
}) {
  const validation = validateTransition({
    transaction,
    userId,
    nextStatus,
  });

  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const [result] = await conn.query(
    "UPDATE transactions SET status = ? WHERE id = ?",
    [nextStatus, transaction.id],
  );

  if (result.affectedRows !== 1) {
    throw new Error("Failed to update transaction.");
  }

  transaction.status = nextStatus;

  return transaction;
}
