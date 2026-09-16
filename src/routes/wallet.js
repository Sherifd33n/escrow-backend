import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/auth.js";
import crypto from "crypto";
import { createRequire } from "module";
import { notify } from "../services/notificationService.js";
import { NOTIFICATION_TYPE } from "../constants/notificationTypes.js";
import { getUsdToNgnRate } from "../services/exchangeRateService.js";
import { getAvailableBalance } from "../services/walletService.js";

const require = createRequire(import.meta.url);

const router = express.Router();

// Apply auth middleware to all routes in this router
router.use(authMiddleware);

// Helper to get or create wallet for user
async function getOrCreateWallet(userId, conn = db, lock = false) {
  const sql = lock
    ? "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE"
    : "SELECT * FROM wallets WHERE user_id = ?";

  let results;

  if (conn.getPool) {
    results = await conn.query(sql, [userId]);
  } else {
    const [rows] = await conn.query(sql, [userId]);
    results = rows;
  }

  if (results && results.length > 0) {
    return results[0];
  }

  // Create wallet if it doesn't exist
  await conn.query("INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)", [
    userId,
  ]);

  if (conn.getPool) {
    results = await conn.query(sql, [userId]);
  } else {
    const [rows] = await conn.query(sql, [userId]);
    results = rows;
  }

  return results[0];
}

// ======================================================
// GET WALLET
// ======================================================

router.get("/", async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    const availableBalance = await getAvailableBalance(req.user.id);

    res.json({
      ...wallet,
      available_balance: availableBalance,
    });
  } catch (error) {
    next(error);
  }
});


// ======================================================
// DEPOSIT (Deprecation directive for Paystack security)
// Direct unverified deposits are strictly prohibited.
// ======================================================

router.post("/deposit", async (req, res) => {
  return res.status(400).json({
    error: "Direct unverified wallet deposits are disabled for security. Please use POST /api/payments/initialize to fund your wallet via Paystack.",
    redirectTo: "/api/payments/initialize",
  });
});


// ======================================================
// WITHDRAW (Deprecation directive for Paystack bank payouts)
// Unverified mock withdrawals are strictly prohibited.
// ======================================================

router.post("/withdraw", async (req, res) => {
  return res.status(400).json({
    error: "Direct unverified withdrawals are disabled for security. Please use POST /api/withdrawals to request bank transfer payouts via Paystack.",
    redirectTo: "/api/withdrawals",
  });
});


// ======================================================
// TRANSFER
// ======================================================

router.post("/transfer", async (req, res, next) => {
  const { amount, recipientEmail, note } = req.body;

  const userId = req.user.id;

  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  if (!recipientEmail) {
    return res.status(400).json({ error: "Recipient email is required." });
  }

  const conn = await db.getPool().getConnection();

  try {
    await conn.beginTransaction();

    const senderWallet = await getOrCreateWallet(userId, conn, true);

    const transferAmt = parseFloat(amount);

    const senderBalance = parseFloat(senderWallet.balance);

    if (senderBalance < transferAmt) {
      await conn.rollback();

      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    const [recipients] = await conn.query(
      "SELECT id, name FROM users WHERE email = ?",
      [recipientEmail.trim().toLowerCase()],
    );

    if (recipients.length === 0) {
      await conn.rollback();

      return res.status(404).json({
        error: `Recipient with email "${recipientEmail}" not found.`,
      });
    }

    const recipientId = recipients[0].id;

    if (recipientId === userId) {
      await conn.rollback();

      return res
        .status(400)
        .json({ error: "Cannot transfer money to yourself." });
    }

    const recipientWallet = await getOrCreateWallet(recipientId, conn, true);

    const senderCurrency = senderWallet.currency || "USD";
    const recipientCurrency = recipientWallet.currency || "USD";

    if (senderCurrency.toUpperCase() !== recipientCurrency.toUpperCase()) {
      await conn.rollback();
      return res.status(400).json({
        error: `Currency mismatch: sender wallet is ${senderCurrency} but recipient wallet is ${recipientCurrency}. Direct cross-currency transfer is not permitted.`,
      });
    }

    const newSenderBalance = senderBalance - transferAmt;

    const newRecipientBalance =
      parseFloat(recipientWallet.balance) + transferAmt;

    await conn.query("UPDATE wallets SET balance = balance - ? WHERE id = ?", [
      transferAmt,
      senderWallet.id,
    ]);

    await conn.query("UPDATE wallets SET balance = balance + ? WHERE id = ?", [
      transferAmt,
      recipientWallet.id,
    ]);

    const reference = `REF-TRF-${crypto.randomInt(100000, 999999)}`;

    const transferNote = note ? ` (${note})` : "";

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status)
      VALUES (?, 'withdrawal', ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        senderWallet.id,
        transferAmt,
        senderCurrency,
        `Transfer to ${recipients[0].name}${transferNote}`,
        reference,
        parseFloat(senderWallet.balance) || 0,
        newSenderBalance,
        JSON.stringify({
          recipient_id: recipientId,
          recipient_name: recipients[0].name,
          recipient_email: recipients[0].email,
          note: note || null,
        }),
      ],
    );

    await conn.query(
      `INSERT INTO wallet_transactions
      (wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status)
      VALUES (?, 'deposit', ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        recipientWallet.id,
        transferAmt,
        recipientCurrency,
        `Transfer from ${req.user.name}${transferNote}`,
        `REF-REC-${crypto.randomInt(100000, 999999)}`,
        parseFloat(recipientWallet.balance) || 0,
        newRecipientBalance,
        JSON.stringify({
          sender_id: userId,
          sender_name: req.user.name,
          sender_email: req.user.email,
          note: note || null,
        }),
      ],
    );

    await conn.commit();

    notify({
      userId,
      type: NOTIFICATION_TYPE.WALLET_WITHDRAWN,
      data: {
        amount: transferAmt.toFixed(2),
        balance: newSenderBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Withdrawn notification for sender:", err));

    notify({
      userId: recipientId,
      type: NOTIFICATION_TYPE.WALLET_FUNDED,
      data: {
        amount: transferAmt.toFixed(2),
        balance: newRecipientBalance.toFixed(2),
      },
      email: true,
      sms: true,
      push: true,
    }).catch((err) => console.error("Failed to trigger Wallet Funded notification for recipient:", err));

    res.json({
      message: "Transfer completed successfully.",
      balance: newSenderBalance,
      reference,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ======================================================
// HISTORY
// ======================================================

router.get("/history", async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const wallet = await getOrCreateWallet(req.user.id);

    const history = await db.query(
      `SELECT id, wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status, created_at
       FROM wallet_transactions
       WHERE wallet_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [wallet.id, limit, offset],
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

// ======================================================
// STATEMENT GENERATION
// ======================================================

router.get("/statement", async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params = [wallet.id];

    if (startDate && endDate) {
      dateFilter = "AND created_at >= ? AND created_at <= ?";
      params.push(new Date(startDate), new Date(`${endDate} 23:59:59`));
    } else if (startDate) {
      dateFilter = "AND created_at >= ?";
      params.push(new Date(startDate));
    }

    const rows = await db.query(
      `SELECT id, wallet_id, type, amount, currency, description, reference, balance_before, balance_after, metadata, status, created_at
       FROM wallet_transactions
       WHERE wallet_id = ? ${dateFilter}
       ORDER BY created_at ASC`,
      params,
    );

    let totalCredits = 0;
    let totalDebits = 0;

    const creditTypes = ["deposit", "escrow_release", "escrow_refund"];
    const items = rows.map((r) => {
      const amt = parseFloat(r.amount) || 0;
      const isCredit = creditTypes.includes(r.type);
      if (isCredit) {
        totalCredits += amt;
      } else {
        totalDebits += amt;
      }
      let parsedMeta = null;
      if (r.metadata) {
        try {
          parsedMeta = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
        } catch (e) {}
      }
      return {
        ...r,
        metadata: parsedMeta,
        isCredit,
      };
    });

    const currentBalance = parseFloat(wallet.balance) || 0;
    const openingBalance = rows.length > 0 && rows[0].balance_before !== null
      ? parseFloat(rows[0].balance_before)
      : Math.max(0, currentBalance - totalCredits + totalDebits);

    const closingBalance = rows.length > 0 && rows[rows.length - 1].balance_after !== null
      ? parseFloat(rows[rows.length - 1].balance_after)
      : currentBalance;

    res.json({
      wallet: {
        id: wallet.id,
        currency: wallet.currency || "USD",
        currentBalance,
      },
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
      },
      period: {
        startDate: startDate || (rows.length > 0 ? rows[0].created_at : new Date()),
        endDate: endDate || new Date(),
      },
      summary: {
        openingBalance: Number(openingBalance.toFixed(2)),
        closingBalance: Number(closingBalance.toFixed(2)),
        totalCredits: Number(totalCredits.toFixed(2)),
        totalDebits: Number(totalDebits.toFixed(2)),
        transactionCount: items.length,
      },
      items,
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// PDF EXPORT
// ======================================================

router.get("/export", async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params = [wallet.id];

    if (startDate && endDate) {
      dateFilter = "AND created_at >= ? AND created_at <= ?";
      params.push(new Date(startDate), new Date(`${endDate} 23:59:59`));
    }

    const rows = await db.query(
      `SELECT id, type, amount, currency, description, reference, balance_before, balance_after, status, created_at
       FROM wallet_transactions
       WHERE wallet_id = ? ${dateFilter}
       ORDER BY created_at ASC`,
      params,
    );

    // Calculate summary
    const creditTypes = ["deposit", "escrow_release", "escrow_refund"];
    let totalCredits = 0;
    let totalDebits = 0;
    rows.forEach((r) => {
      const amt = parseFloat(r.amount) || 0;
      if (creditTypes.includes(r.type)) totalCredits += amt;
      else totalDebits += amt;
    });

    const currentBalance = parseFloat(wallet.balance) || 0;
    const openingBalance = rows.length > 0 && rows[0].balance_before !== null
      ? parseFloat(rows[0].balance_before)
      : Math.max(0, currentBalance - totalCredits + totalDebits);
    const closingBalance = rows.length > 0 && rows[rows.length - 1].balance_after !== null
      ? parseFloat(rows[rows.length - 1].balance_after)
      : currentBalance;

    const currency = wallet.currency || "USD";
    const periodLabel = startDate && endDate
      ? `${new Date(startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – ${new Date(endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "All Time";

    // --- Build PDF ---
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });

    // Pipe to response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="lumbrr-wallet-statement-${Date.now()}.pdf"`
    );
    doc.pipe(res);

    // --- Colors ---
    const navy = "#001637";
    const green = "#006c47";
    const red = "#ba1a1a";
    const gray = "#75777f";
    const lightBg = "#f8f9fa";
    const borderColor = "#e0e0e0";

    // --- Header ---
    doc
      .rect(0, 0, doc.page.width, 70)
      .fill(navy);
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("Lumbrr", 40, 20);
    doc
      .fillColor("#a8c8ff")
      .font("Helvetica")
      .fontSize(9)
      .text("Escrow Financial Statement", 40, 42);
    doc
      .fillColor("#ffffff")
      .font("Helvetica")
      .fontSize(8)
      .text(`Generated: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`, 350, 28, { align: "right", width: 200 });

    let y = 90;

    // --- Account Info Grid ---
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(9).text("ACCOUNT HOLDER", 40, y);
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(11).text(req.user.name, 40, y + 14);
    doc.fillColor(gray).font("Helvetica").fontSize(8.5).text(req.user.email, 40, y + 28);

    doc.fillColor(navy).font("Helvetica-Bold").fontSize(9).text("STATEMENT PERIOD", 250, y);
    doc.fillColor(navy).font("Helvetica").fontSize(10).text(periodLabel, 250, y + 14);
    doc.fillColor(gray).font("Helvetica").fontSize(8.5).text(`${rows.length} Transactions`, 250, y + 28);

    doc.fillColor(navy).font("Helvetica-Bold").fontSize(9).text("CLOSING BALANCE", 430, y);
    doc.fillColor(green).font("Helvetica-Bold").fontSize(14).text(`$${closingBalance.toFixed(2)}`, 430, y + 13);
    doc.fillColor(gray).font("Helvetica").fontSize(8.5).text(currency, 430, y + 30);

    y += 55;
    doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(borderColor).stroke();
    y += 14;

    // --- Summary Boxes ---
    const boxW = (doc.page.width - 80 - 30) / 4;
    const summaryData = [
      { label: "Opening Balance", value: `$${openingBalance.toFixed(2)}`, color: navy },
      { label: "Total Inflows", value: `+$${totalCredits.toFixed(2)}`, color: green },
      { label: "Total Outflows", value: `-$${totalDebits.toFixed(2)}`, color: red },
      { label: "Closing Balance", value: `$${closingBalance.toFixed(2)}`, color: navy },
    ];

    summaryData.forEach((item, i) => {
      const bx = 40 + i * (boxW + 10);
      doc.rect(bx, y, boxW, 40).fillAndStroke(lightBg, borderColor);
      doc.fillColor(gray).font("Helvetica").fontSize(7.5).text(item.label, bx + 8, y + 7, { width: boxW - 16 });
      doc.fillColor(item.color).font("Helvetica-Bold").fontSize(11).text(item.value, bx + 8, y + 21, { width: boxW - 16 });
    });

    y += 56;

    // --- Transaction Table ---
    const colWidths = [68, 90, 175, 75, 75];
    const headers = ["Date", "Reference", "Description", "Amount", "Balance"];
    const tableLeft = 40;

    // Table header
    doc.rect(tableLeft, y, doc.page.width - 80, 22).fill("#e9ecef");
    let hx = tableLeft;
    headers.forEach((h, i) => {
      const align = i >= 3 ? "right" : "left";
      doc.fillColor("#44474e").font("Helvetica-Bold").fontSize(8).text(h, hx + 6, y + 7, { width: colWidths[i] - 12, align });
      hx += colWidths[i];
    });
    y += 22;

    // Table rows
    rows.forEach((r, idx) => {
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = 40;
      }

      const rowBg = idx % 2 === 0 ? "#ffffff" : "#fafbfc";
      doc.rect(tableLeft, y, doc.page.width - 80, 20).fill(rowBg);

      const amt = parseFloat(r.amount) || 0;
      const isCredit = creditTypes.includes(r.type);
      const dateStr = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
      const ref = r.reference || "—";
      const desc = r.description || "—";
      const amountStr = `${isCredit ? "+" : "-"}$${amt.toFixed(2)}`;
      const balStr = r.balance_after !== null ? `$${parseFloat(r.balance_after).toFixed(2)}` : "—";

      let cx = tableLeft;
      doc.fillColor(gray).font("Helvetica").fontSize(7.5).text(dateStr, cx + 6, y + 6, { width: colWidths[0] - 12 });
      cx += colWidths[0];
      doc.fillColor(navy).font("Helvetica").fontSize(7).text(ref, cx + 6, y + 6, { width: colWidths[1] - 12 });
      cx += colWidths[1];
      doc.fillColor(navy).font("Helvetica").fontSize(7.5).text(desc, cx + 6, y + 6, { width: colWidths[2] - 12, lineBreak: false });
      cx += colWidths[2];
      doc.fillColor(isCredit ? green : red).font("Helvetica-Bold").fontSize(8).text(amountStr, cx + 6, y + 6, { width: colWidths[3] - 12, align: "right" });
      cx += colWidths[3];
      doc.fillColor("#44474e").font("Helvetica").fontSize(8).text(balStr, cx + 6, y + 6, { width: colWidths[4] - 12, align: "right" });

      y += 20;
    });

    if (rows.length === 0) {
      doc.fillColor(gray).font("Helvetica").fontSize(10).text("No transactions found in this period.", tableLeft, y + 10, { width: doc.page.width - 80, align: "center" });
      y += 30;
    }

    // --- Footer ---
    y += 20;
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }
    doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(borderColor).stroke();
    y += 10;
    doc.fillColor(gray).font("Helvetica").fontSize(7)
      .text("This statement is auto-generated by Lumbrr Escrow. For questions, contact support@lumbrr.com.", 40, y, { width: doc.page.width - 80, align: "center" });

    doc.end();
  } catch (error) {
    next(error);
  }
});

export default router;
