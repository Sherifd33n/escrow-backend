import express from "express";
import { getUsdToNgnRate } from "../services/exchangeRateService.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const rate = await getUsdToNgnRate();

    res.json({
      success: true,
      usdToNgn: rate,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "Unable to fetch exchange rate.",
    });
  }
});

export default router;
