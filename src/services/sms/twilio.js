import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

/**
 * Send verification code
 * @param {string} phone - Phone number in E.164 format (+2348012345678)
 */
export const sendVerificationCode = async (phone) => {
  try {
    const response = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    return {
      success: true,
      sid: response.sid,
      status: response.status,
    };
  } catch (error) {
    console.error("Twilio Send OTP Error:", error);

    return {
      success: false,
      message: error.message,
    };
  }
};

/**
 * Verify OTP code
 * @param {string} phone
 * @param {string} code
 */
export const verifyCode = async (phone, code) => {
  try {
    const response = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: phone,
        code,
      });

    return {
      success: response.status === "approved",
      status: response.status,
    };
  } catch (error) {
    console.error("Twilio Verify Error:", error);

    return {
      success: false,
      message: error.message,
    };
  }
};