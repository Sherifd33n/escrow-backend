import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";

import { TRANSACTION_STATUS } from "../core/transactionStatus.js";
import { updateTransactionStatus } from "../services/transactionService.js";
import { logTransactionEvent } from "../services/transactionEventService.js";

const router = express.Router();

router.use(authMiddleware);
