export function canOpenDispute(transaction, userId) {
  // Only buyer or seller can open a dispute
  if (transaction.buyer_id !== userId && transaction.seller_id !== userId) {
    return {
      valid: false,
      message: "You are not part of this transaction.",
    };
  }

  // Prevent duplicate disputes
  if (transaction.status === "disputed") {
    return {
      valid: false,
      message: "A dispute has already been opened.",
    };
  }

  // Only allow disputes after work has started
  const allowedStatuses = [
    "funded",
    "inprogress",
    "inspection",
    "revision",
    "audit",
    "approved",
  ];

  if (!allowedStatuses.includes(transaction.status)) {
    return {
      valid: false,
      message: `Cannot open a dispute while transaction is "${transaction.status}".`,
    };
  }

  return {
    valid: true,
  };
}

export function canSendMessage(dispute, userId, transaction) {
  if (transaction.buyer_id !== userId && transaction.seller_id !== userId) {
    return {
      valid: false,
      message: "You are not part of this dispute.",
    };
  }

  if (dispute.status === "closed") {
    return {
      valid: false,
      message: "This dispute has already been closed.",
    };
  }

  return {
    valid: true,
  };
}

export function canResolveDispute(dispute) {
  if (dispute.status === "resolved") {
    return {
      valid: false,
      message: "This dispute has already been resolved.",
    };
  }

  if (dispute.status === "closed") {
    return {
      valid: false,
      message: "This dispute has already been closed.",
    };
  }

  return {
    valid: true,
  };
}
