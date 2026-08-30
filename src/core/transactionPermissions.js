import { TRANSACTION_POLICY } from "./transactionPolicy.js";

export function getAllowedActions(transaction, userId) {
  const role =
    userId === transaction.buyer_id
      ? "buyer"
      : userId === transaction.seller_id
        ? "seller"
        : null;

  if (!role) {
    return [];
  }

  return TRANSACTION_POLICY[transaction.status]?.[role] || [];
}

export function canPerformAction(transaction, userId, action) {
  return getAllowedActions(transaction, userId).includes(action);
}
