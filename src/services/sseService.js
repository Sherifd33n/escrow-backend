/**
 * services/sseService.js
 *
 * Simple Server-Sent Events (SSE) connection manager.
 *
 * Responsibilities:
 * - Track connected users.
 * - Register new SSE connections.
 * - Remove disconnected users.
 * * Send realtime events to one user.
 * - Broadcast events if needed.
 */

const clients = new Map();

/**
 * Register a user's SSE connection.
 *
 * @param {number|string} userId
 * @param {Response} res
 */
export function connect(userId, res) {
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }

  clients.get(userId).add(res);

  console.log(
    `[SSE] User ${userId} connected (${clients.get(userId).size} connection(s))`,
  );
}

/**
 * Remove a user's SSE connection.
 *
 * @param {number|string} userId
 * @param {Response} res
 */
export function disconnect(userId, res) {
  if (!clients.has(userId)) return;

  clients.get(userId).delete(res);

  if (clients.get(userId).size === 0) {
    clients.delete(userId);
  }

  console.log(`[SSE] User ${userId} disconnected`);
}

/**
 * Send an event to one connected user.
 *
 * @param {number|string} userId
 * @param {object} payload
 */
export function sendEvent(userId, payload) {
  const connections = clients.get(userId);

  if (!connections) return;

  const data = `event: notification\n` + `data: ${JSON.stringify(payload)}\n\n`;

  for (const res of connections) {
    try {
      res.write(data);
    } catch (err) {
      console.error("[SSE] Failed to send event:", err.message);
    }
  }
}

/**
 * Broadcast to every connected user.
 * Useful for future admin announcements.
 *
 * @param {object} payload
 */
export function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;

  for (const connections of clients.values()) {
    for (const res of connections) {
      try {
        res.write(data);
      } catch (err) {
        console.error("[SSE] Broadcast error:", err.message);
      }
    }
  }
}

/**
 * Number of connected users.
 */
export function connectedUsers() {
  return clients.size;
}
