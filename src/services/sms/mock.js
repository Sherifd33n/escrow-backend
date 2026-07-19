export async function sendSMS(phone, message) {
    // Extract the OTP from the message for clarity in development logs
    const otpMatch = message.match(/\b(\d{6})\b/);
    const otp = otpMatch ? otpMatch[1] : "N/A";

    console.log("\n╔══════════════════════════════════════╗");
    console.log("║         📱 MOCK SMS — KYC OTP        ║");
    console.log("╠══════════════════════════════════════╣");
    console.log(`║  To   : ${phone.padEnd(29)}║`);
    console.log(`║  OTP  : ${otp.padEnd(29)}║`);
    console.log("╠══════════════════════════════════════╣");
    console.log(`║  Msg  : ${message.slice(0, 29)}║`);
    console.log("╚══════════════════════════════════════╝\n");

    return {
        success: true,
        provider: "mock"
    };
}