import { TRANSACTION_STATUS } from "./transactionStatus.js";

const T = TRANSACTION_STATUS;

export const STATE_TRANSITIONS = Object.freeze({
  [T.PENDING]: [T.FUNDED],

  [T.FUNDED]: [T.INPROGRESS, T.DISPUTED],

  [T.INPROGRESS]: [T.INSPECTION, T.DISPUTED],

  [T.INSPECTION]: [T.AUDIT, T.REVISION, T.DISPUTED],

  [T.REVISION]: [T.INPROGRESS, T.DISPUTED],

  [T.AUDIT]: [T.APPROVED, T.DISPUTED],

  [T.APPROVED]: [T.COMPLETED],

  [T.COMPLETED]: [],

  [T.DISPUTED]: [T.APPROVED, T.COMPLETED],
});

export function isValidStatus(status) {
  return Object.values(T).includes(status);
}

export function getAllowedTransitions(status) {
  return STATE_TRANSITIONS[status] || [];
}

export function canTransition(currentStatus, nextStatus) {
  return getAllowedTransitions(currentStatus).includes(nextStatus);
}
