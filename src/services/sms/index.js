import { sendSMS as mock } from "./mock.js";

const provider = process.env.SMS_PROVIDER || "mock";

export async function sendSMS(phone, message) {
    switch (provider) {
        case "mock":
        default:
            return mock(phone, message);
    }
}