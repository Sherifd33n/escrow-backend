import { TRANSACTION_STATUS } from "./transactionStatus.js";

export const STATUS_ROLE_PERMISSIONS = Object.freeze({
  [TRANSACTION_STATUS.FUNDED]: "buyer",

  [TRANSACTION_STATUS.INPROGRESS]: "seller",

  [TRANSACTION_STATUS.INSPECTION]: "seller",

  [TRANSACTION_STATUS.APPROVED]: "buyer",

  [TRANSACTION_STATUS.COMPLETED]: "system",

  [TRANSACTION_STATUS.DISPUTED]: "both",
});

export function canUserTransition(userId, transaction, nextStatus) {
  const permission = STATUS_ROLE_PERMISSIONS[nextStatus];

  if (!permission) return false;

  if (permission === "both") {
    return userId === transaction.buyer_id || userId === transaction.seller_id;
  }

  if (permission === "buyer") {
    return userId === transaction.buyer_id;
  }

  if (permission === "seller") {
    return userId === transaction.seller_id;
  }

  // completed can only be performed internally
  if (permission === "system") {
    return false;
  }

  return false;
}
