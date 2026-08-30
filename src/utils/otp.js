export function generateOTP(length = 6) {
  let otp = "";

  for (let i = 0; i < length; i++) {
    otp += Math.floor(Math.random() * 10);
  }

  return otp;
}

export function getOTPExpiry(minutes = 10) {
  const expires = new Date();

  expires.setMinutes(expires.getMinutes() + minutes);

  return expires;
}
