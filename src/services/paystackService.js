import axios from "axios";
import crypto from "crypto";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured in backend environment.");
  }
  return key;
}

function getClient() {
  return axios.create({
    baseURL: PAYSTACK_BASE_URL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Initialize a Paystack transaction (wallet funding)
 */
export async function initializeTransaction({
  email,
  amountKobo,
  reference,
  callbackUrl,
  metadata = {},
}) {
  try {
    const client = getClient();
    const payload = {
      email,
      amount: Math.round(amountKobo),
      reference,
      callback_url: callbackUrl || process.env.PAYSTACK_CALLBACK_URL,
      metadata,
    };

    const response = await client.post("/transaction/initialize", payload);
    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Paystack initialization failed.");
    }

    return response.data.data; // { authorization_url, access_code, reference }
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] initializeTransaction error:", msg);
    throw new Error(`Paystack initialization failed: ${msg}`);
  }
}

/**
 * Verify a Paystack transaction by reference
 */
export async function verifyTransaction(reference) {
  try {
    const client = getClient();
    const response = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);

    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Paystack transaction verification failed.");
    }

    return response.data.data; // Full transaction data object
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] verifyTransaction error:", msg);
    throw new Error(`Paystack verification failed: ${msg}`);
  }
}

/**
 * Get list of supported banks
 */
export async function getBanks(country = "nigeria") {
  try {
    const client = getClient();
    const response = await client.get(`/bank?country=${encodeURIComponent(country)}&use_cursor=true&perPage=100`);

    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Failed to fetch bank list.");
    }

    return response.data.data; // Array of bank objects
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] getBanks error:", msg);
    throw new Error(`Failed to fetch bank list: ${msg}`);
  }
}

/**
 * Resolve bank account number to verify account holder name
 */
export async function resolveAccount({ accountNumber, bankCode }) {
  try {
    const client = getClient();
    const response = await client.get(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
    );

    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Account resolution failed.");
    }

    return response.data.data; // { account_number, account_name, bank_id }
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] resolveAccount error:", msg);
    throw new Error(`Account resolution failed: ${msg}`);
  }
}

/**
 * Create a Paystack transfer recipient for bank payouts
 */
export async function createTransferRecipient({
  type = "nuban",
  name,
  accountNumber,
  bankCode,
  currency = "NGN",
}) {
  try {
    const client = getClient();
    const payload = {
      type,
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency,
    };

    const response = await client.post("/transferrecipient", payload);
    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Failed to create transfer recipient.");
    }

    return response.data.data; // { recipient_code, details, etc. }
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] createTransferRecipient error:", msg);
    throw new Error(`Failed to create transfer recipient: ${msg}`);
  }
}

/**
 * Initiate a bank transfer via Paystack
 */
export async function initiateTransfer({
  source = "balance",
  amountKobo,
  recipientCode,
  reference,
  reason = "Wallet Withdrawal",
}) {
  try {
    const client = getClient();
    const payload = {
      source,
      amount: Math.round(amountKobo),
      recipient: recipientCode,
      reference,
      reason,
    };

    const response = await client.post("/transfer", payload);
    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Transfer initiation failed.");
    }

    return response.data.data; // { transfer_code, status, reference, etc. }
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] initiateTransfer error:", msg);
    throw new Error(`Transfer initiation failed: ${msg}`);
  }
}

/**
 * Verify a transfer status by reference/code
 */
export async function verifyTransfer(reference) {
  try {
    const client = getClient();
    const response = await client.get(`/transfer/verify/${encodeURIComponent(reference)}`);

    if (!response.data || !response.data.status) {
      throw new Error(response.data?.message || "Transfer verification failed.");
    }

    return response.data.data;
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error("[PaystackService] verifyTransfer error:", msg);
    throw new Error(`Transfer verification failed: ${msg}`);
  }
}

/**
 * Verify Paystack webhook signature (HMAC SHA512)
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const bodyStr = typeof rawBody === "string" ? rawBody : (Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody));

  const hash = crypto
    .createHmac("sha512", secret)
    .update(bodyStr)
    .digest("hex");

  return hash === signature;
}

export default {
  initializeTransaction,
  verifyTransaction,
  getBanks,
  resolveAccount,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
  verifyWebhookSignature,
};
