import { canTransition } from "./transactionStateMachine.js";

export function validateTransition({ transaction, nextStatus }) {
  if (!canTransition(transaction.status, nextStatus)) {
    return {
      valid: false,
      message: `Cannot move transaction from "${transaction.status}" to "${nextStatus}".`,
    };
  }

  return {
    valid: true,
    message: null,
  };
}
