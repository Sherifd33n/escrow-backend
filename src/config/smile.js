const sandbox = "https://testapi.smileidentity.com";
const production = "https://api.smileidentity.com";

export default {
  environment: process.env.SMILE_ENV || "sandbox",

  baseURL: process.env.SMILE_ENV === "production" ? production : sandbox,

  partnerId: process.env.SMILE_PARTNER_ID,

  apiKey: process.env.SMILE_API_KEY,

  callbackUrl: process.env.SMILE_CALLBACK_URL,
};
