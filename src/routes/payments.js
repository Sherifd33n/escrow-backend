import express from "express";
import crypto from "crypto";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import paystackService from "../services/paystackService.js";
import paymentService from "../services/paymentService.js";
import withdrawalService from "../services/withdrawalService.js";
import { verifyAndActivateSubscriptionPayment } from "../services/subscriptionService.js";
import { getUsdToNgnRate } from "../services/exchangeRateService.js";
import { getAvailableBalance } from "../services/walletService.js";

const router = express.Router();

// ======================================================
// PAYSTACK WEBHOOK ENDPOINT (Public — signature protected)
// Must handle raw body signature verification
// ======================================================
router.post("/webhook/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.rawBody || req.body;

  if (!paystackService.verifyWebhookSignature(rawBody, signature)) {
    console.error("[PaystackWebhook] Invalid webhook signature detected.");
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = typeof req.body === "object" ? req.body : JSON.parse(rawBody.toString("utf8"));
  const eventType = event.event;
  const eventData = event.data || {};
  const providerRef = eventData.reference || eventData.transfer_code || "";

  if (!eventType || !providerRef) {
    return res.status(400).json({ error: "Malformed webhook payload" });
  }

  const idempotencyKey = `paystack_${eventType}_${providerRef}_${eventData.id || ""}`;

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // Check if event already processed
    const [existing] = await conn.query(
      "SELECT id FROM webhook_events WHERE idempotency_key = ?",
      [idempotencyKey]
    );

    if (existing.length > 0) {
      await conn.commit();
      return res.status(200).json({ status: "already_processed" });
    }

    // Record webhook event
    await conn.query(
      `INSERT INTO webhook_events (provider, event_type, provider_reference, idempotency_key, payload)
       VALUES ('paystack', ?, ?, ?, ?)`,
      [eventType, providerRef, idempotencyKey, JSON.stringify(event)]
    );

    // Process event based on type
    let postCommitCallback = null;
    switch (eventType) {
      case "charge.success": {
        const paymentPurpose = eventData.metadata?.purpose;

        if (paymentPurpose === "subscription") {
          // Subscription payment — verify and activate the plan
          // userId=null: ownership is established from the payments record itself
          await verifyAndActivateSubscriptionPayment(providerRef, null);
        } else {
          // Wallet-funding payment (default)
          const result = await paymentService.processSuccessfulPayment({
            reference: providerRef,
            providerData: eventData,
            passedConn: conn,
          });
          if (result && typeof result.sendNotification === "function") {
            postCommitCallback = result.sendNotification;
          }
        }
        break;
      }

      case "transfer.success":
        await withdrawalService.processWithdrawalSuccess({
          reference: providerRef,
          providerData: eventData,
          passedConn: conn,
        });
        break;

      case "transfer.failed":
        await withdrawalService.processWithdrawalFailure({
          reference: providerRef,
          reason: eventData.reason || "Paystack transfer failed",
          providerData: eventData,
          passedConn: conn,
        });
        break;

      case "transfer.reversed":
        await withdrawalService.processWithdrawalReversal({
          reference: providerRef,
          reason: eventData.reason || "Paystack transfer reversed",
          providerData: eventData,
          passedConn: conn,
        });
        break;

      default:
        console.log(`[PaystackWebhook] Ignored unhandled event: ${eventType}`);
        break;
    }

    await conn.commit();
    if (typeof postCommitCallback === "function") {
      postCommitCallback();
    }
    return res.status(200).json({ status: "success" });
  } catch (error) {
    await conn.rollback();
    console.error(`[PaystackWebhook] Processing error for ${eventType}:`, error);
    // Return 200 to acknowledge webhook even on non-recoverable error so Paystack doesn't spam retries endlessly, or 500 if temporary
    return res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

// Apply auth middleware for remaining payment routes
router.use(authMiddleware);

// ======================================================
// INITIALIZE PAYMENT (Wallet Funding)
// ======================================================
router.post("/initialize", async (req, res, next) => {
  const { amount } = req.body; // Amount in NGN from user input

  const ngnAmount = parseFloat(amount);
  if (isNaN(ngnAmount) || ngnAmount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  if (ngnAmount < 100) {
    return res.status(400).json({ error: "Minimum funding amount is ₦100." });
  }

  if (ngnAmount > 50000000) {
    return res.status(400).json({ error: "Maximum single funding limit is ₦50,000,000." });
  }

  try {
    // 1. Fetch current exchange rate NGN to USD
    let ngnToUsdRate;
    try {
      ngnToUsdRate = await getUsdToNgnRate();
    } catch (err) {
      return res.status(503).json({
        error: "Unable to retrieve current exchange rate. Please try again later.",
      });
    }

    const amountInUSD = parseFloat((ngnAmount / ngnToUsdRate).toFixed(2));
    const amountKobo = Math.round(ngnAmount * 100);
    const reference = `REF-PAY-${Date.now()}-${crypto.randomInt(10000, 99999)}`;

    // 2. Insert pending payment record BEFORE calling Paystack
    await db.query(
      `INSERT INTO payments
       (user_id, reference, amount, amount_kobo, currency, exchange_rate, purpose, provider, status, metadata)
       VALUES (?, ?, ?, ?, 'NGN', ?, 'wallet_funding', 'paystack', 'pending', ?)`,
      [
        req.user.id,
        reference,
        amountInUSD,
        amountKobo,
        ngnToUsdRate,
        JSON.stringify({ user_email: req.user.email, ngn_amount: ngnAmount }),
      ]
    );

    // 3. Call Paystack API to initialize transaction
    const resolvedCallbackUrl = req.body.callbackUrl || process.env.PAYSTACK_CALLBACK_URL;
    let paystackResponse;
    try {
      paystackResponse = await paystackService.initializeTransaction({
        email: req.user.email,
        amountKobo,
        reference,
        callbackUrl: resolvedCallbackUrl,
        metadata: {
          user_id: req.user.id,
          purpose: "wallet_funding",
          usd_amount: amountInUSD,
        },
      });
    } catch (err) {
      // Safely update payment record status on initialization failure
      await db.query("UPDATE payments SET status = 'failed' WHERE reference = ?", [reference]);
      throw err;
    }

    // 4. Return safe checkout information to frontend
    res.json({
      message: "Payment initialized successfully.",
      authorization_url: paystackResponse.authorization_url,
      access_code: paystackResponse.access_code,
      reference,
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// VERIFY PAYMENT (Callback verification endpoint)
// ======================================================
router.get("/verify/:reference", async (req, res, next) => {
  const { reference } = req.params;

  if (!reference) {
    return res.status(400).json({ error: "Payment reference is required." });
  }

  try {
    // Confirm payment belongs to authenticated user
    // NOTE: db.query() wraps pool.query() and already destructures [results],
    // so it returns the rows array directly — no further destructuring needed.
    const paymentRows = await db.query(
      "SELECT user_id FROM payments WHERE reference = ?",
      [reference]
    );

    if (!paymentRows || paymentRows.length === 0) {
      return res.status(404).json({ error: "Payment record not found." });
    }

    if (paymentRows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "You are not authorized to verify this payment." });
    }


    const result = await paymentService.processSuccessfulPayment({ reference });

    // Check for payment failure FIRST — before any balance lookups
    if (!result.success && !result.alreadyProcessed) {
      return res.status(400).json({
        error: result.message || "Payment verification failed. Payment was not successful on Paystack.",
        ...result,
      });
    }

    // Payment succeeded — try to fetch updated available balance
    // Wrapped in try/catch so a balance-fetch error can never
    // mask a successful payment or crash the success response
    try {
      const availableBalance = await getAvailableBalance(req.user.id);
      result.balance = availableBalance;
    } catch (balErr) {
      console.error("[PaymentVerify] Non-critical: failed to fetch available balance after successful payment:", balErr.message);
      // result.balance already set by processSuccessfulPayment, so we keep it
    }

    res.json({
      message: result.alreadyProcessed
        ? "Payment verified (already processed)."
        : "Payment verified successfully and wallet credited.",
      ...result,
    });

  } catch (error) {
    next(error);
  }
});

// ======================================================
// SYNC PENDING PAYMENTS (Silent & manual self-healing)
// ======================================================
router.post("/sync-pending", async (req, res, next) => {
  try {
    const pendingPayments = await db.query(
      `SELECT reference FROM payments 
       WHERE user_id = ? AND status = 'pending' AND purpose = 'wallet_funding'
       ORDER BY created_at DESC LIMIT 5`,
      [req.user.id]
    );

    const results = [];
    let newlyCreditedCount = 0;

    for (const p of pendingPayments) {
      try {
        const result = await paymentService.processSuccessfulPayment({ reference: p.reference });
        if (result.success && !result.alreadyProcessed) {
          newlyCreditedCount++;
        }
        results.push({ reference: p.reference, ...result });
      } catch (err) {
        results.push({ reference: p.reference, success: false, error: err.message });
      }
    }

    const availableBalance = await getAvailableBalance(req.user.id);

    res.json({
      success: true,
      newlyCreditedCount,
      results,
      balance: availableBalance,
    });
  } catch (error) {
    next(error);
  }
});



// ======================================================
// PAYMENT HISTORY
// ======================================================
router.get("/history", async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const history = await db.query(
      `SELECT id, reference, amount, amount_kobo, currency, exchange_rate, purpose, provider, status, created_at
       FROM payments
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    res.json({
      history,
      page,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
