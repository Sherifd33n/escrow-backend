import crypto from "crypto";
import db from "../config/db.js";

/**
 * Service to manage developer API Keys for external B2B platform integrations.
 */

export function generateKeyStrings(environment = "test") {
  const prefix = environment === "live" ? "lmb_live" : "lmb_test";
  const secretPrefix = environment === "live" ? "sk_live" : "sk_test";
  
  const publicKey = `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
  const secretKey = `${secretPrefix}_${crypto.randomBytes(24).toString("hex")}`;
  const webhookSecret = `whsec_${crypto.randomBytes(20).toString("hex")}`;
  
  return { publicKey, secretKey, webhookSecret };
}

export async function createApiKey(userId, { name = "Default App", environment = "test" }) {
  const { publicKey, secretKey, webhookSecret } = generateKeyStrings(environment);

  const result = await db.query(
    `INSERT INTO api_keys (user_id, name, public_key, secret_key, environment, webhook_secret, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [userId, name, publicKey, secretKey, environment, webhookSecret]
  );

  return {
    id: result.insertId,
    name,
    environment,
    publicKey,
    secretKey, // Returned in full only on creation
    webhookSecret,
    createdAt: new Date(),
  };
}

export async function listApiKeys(userId) {
  const rows = await db.query(
    `SELECT id, name, public_key, environment, webhook_url, webhook_secret, is_active, rate_limit_per_min, last_used_at, created_at
     FROM api_keys
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId]
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    publicKey: r.public_key,
    environment: r.environment,
    webhookUrl: r.webhook_url,
    webhookSecret: r.webhook_secret,
    isActive: !!r.is_active,
    rateLimitPerMin: r.rate_limit_per_min,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

export async function revokeApiKey(userId, keyId) {
  const rows = await db.query(
    "SELECT id FROM api_keys WHERE id = ? AND user_id = ?",
    [keyId, userId]
  );
  if (!rows || rows.length === 0) {
    throw new Error("API Key not found or unauthorized.");
  }

  await db.query("DELETE FROM api_keys WHERE id = ?", [keyId]);
  return { success: true, message: "API Key revoked successfully." };
}

export async function updateWebhookConfig(userId, keyId, { webhookUrl }) {
  const rows = await db.query(
    "SELECT id, webhook_secret FROM api_keys WHERE id = ? AND user_id = ?",
    [keyId, userId]
  );
  if (!rows || rows.length === 0) {
    throw new Error("API Key not found or unauthorized.");
  }

  let secret = rows[0].webhook_secret;
  if (!secret) {
    secret = `whsec_${crypto.randomBytes(20).toString("hex")}`;
  }

  await db.query(
    "UPDATE api_keys SET webhook_url = ?, webhook_secret = ? WHERE id = ?",
    [webhookUrl || null, secret, keyId]
  );

  return {
    success: true,
    webhookUrl: webhookUrl || null,
    webhookSecret: secret,
  };
}

export async function getApiKeyDetails(keyString) {
  if (!keyString || typeof keyString !== "string") return null;

  const cleanKey = keyString.trim();
  const rows = await db.query(
    `SELECT ak.*, u.id as owner_id, u.name as owner_name, u.email as owner_email, u.role as owner_role
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE (ak.public_key = ? OR ak.secret_key = ?) AND ak.is_active = 1`,
    [cleanKey, cleanKey]
  );

  if (!rows || rows.length === 0) return null;

  const record = rows[0];

  // Asynchronously bump last_used_at
  db.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = ?", [record.id]).catch(() => {});

  return {
    keyId: record.id,
    name: record.name,
    publicKey: record.public_key,
    environment: record.environment,
    webhookUrl: record.webhook_url,
    webhookSecret: record.webhook_secret,
    rateLimitPerMin: record.rate_limit_per_min,
    owner: {
      id: record.owner_id,
      name: record.owner_name,
      email: record.owner_email,
      role: record.owner_role,
    },
  };
}

export default {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateWebhookConfig,
  getApiKeyDetails,
};
