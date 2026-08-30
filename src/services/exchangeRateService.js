const API_KEY = process.env.EXCHANGE_RATE_API_KEY;

let cachedRate = null;
let lastFetched = 0;

const CACHE_TIME = 30 * 60 * 1000; // 30 minutes

export const getUsdToNgnRate = async () => {
  const now = Date.now();

  // Return cached rate if still valid
  if (cachedRate && now - lastFetched < CACHE_TIME) {
    return cachedRate;
  }

  try {
    const response = await fetch(
      `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/USD`,
    );

    const data = await response.json();

    if (data.result !== "success") {
      throw new Error(data["error-type"] || "Exchange rate lookup failed");
    }

    cachedRate = data.conversion_rates.NGN;
    lastFetched = now;

    return cachedRate;
  } catch (err) {
    console.error("Exchange Rate Error:", err.message);

    // If we already have a cached value, use it
    if (cachedRate) {
      return cachedRate;
    }

    throw err;
  }
};
