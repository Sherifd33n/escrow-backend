import { TRANSACTION_STATUS } from "./transactionStatus.js";

export const TRANSACTION_POLICY = Object.freeze({
  [TRANSACTION_STATUS.PENDING]: {
    buyer: ["fund_escrow"],
    seller: [],
  },

  [TRANSACTION_STATUS.FUNDED]: {
    buyer: [],
    seller: ["start_work"],
  },

  [TRANSACTION_STATUS.INPROGRESS]: {
    buyer: [],
    seller: ["submit_work"],
  },

  [TRANSACTION_STATUS.INSPECTION]: {
    buyer: ["approve_work", "request_revision", "open_dispute"],
    seller: [],
  },

  [TRANSACTION_STATUS.REVISION]: {
    buyer: [],
    seller: ["submit_work"],
  },

  [TRANSACTION_STATUS.AUDIT]: {
    buyer: [],
    seller: [],
  },

  [TRANSACTION_STATUS.APPROVED]: {
    buyer: ["complete"],
    seller: [],
  },

  [TRANSACTION_STATUS.DISPUTED]: {
    buyer: [],
    seller: [],
  },

  [TRANSACTION_STATUS.COMPLETED]: {
    buyer: [],
    seller: [],
  },
});
