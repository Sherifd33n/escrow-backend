export async function logTransactionEvent({
  conn,
  transactionId,
  userId,
  action,
  fromStatus = null,
  toStatus = null,
  note = null,
  metadata = null,
}) {
  await conn.query(
    `
    INSERT INTO transaction_events
    (
      transaction_id,
      user_id,
      action,
      from_status,
      to_status,
      note,
      metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      transactionId,
      userId,
      action,
      fromStatus,
      toStatus,
      note,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}
