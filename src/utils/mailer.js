import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

let transporter;

// Create SMTP transporter
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // Verify SMTP connection once when the server starts
  transporter
    .verify()
    .then(() => {
      console.log("Brevo SMTP connected successfully.");
    })
    .catch((error) => {
      console.error("Failed to connect to Brevo SMTP:", error);
    });
}

export async function sendOTPEmail(email, code, type = "signup") {
  if (!process.env.SMTP_FROM) {
    throw new Error("SMTP_FROM is missing from the environment variables.");
  }

  if (!transporter) {
    throw new Error("SMTP transporter is not configured.");
  }

  const subject =
    type === "signup"
      ? "Escrow — Verify Your Account"
      : "Escrow — Reset Your Password";

  const body = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${subject}</title>
</head>

<body style="
margin:0;
padding:40px;
background:#f5f7fb;
font-family:Arial,Helvetica,sans-serif;
">

<table
style="
max-width:600px;
margin:auto;
background:#ffffff;
border-radius:12px;
overflow:hidden;
box-shadow:0 10px 30px rgba(0,0,0,.08);
">

<tr>
<td
style="
background:#001637;
padding:24px;
text-align:center;
color:#ffffff;
font-size:28px;
font-weight:bold;
letter-spacing:1px;
">

ESCROW

</td>
</tr>

<tr>
<td style="padding:40px;">

<h2
style="
margin-top:0;
margin-bottom:20px;
color:#001637;
">

${type === "signup" ? "Verify Your Email" : "Reset Your Password"}

</h2>

<p
style="
font-size:16px;
color:#555;
line-height:1.8;
margin-bottom:30px;
">

Use the verification code below to continue.

</p>

<div
style="
margin:35px 0;
text-align:center;
">

<div
style="
display:inline-block;
padding:18px 35px;
background:#eef3fb;
border-radius:8px;
font-size:36px;
font-weight:bold;
letter-spacing:8px;
color:#001637;
">

${code}

</div>

</div>

<p
style="
color:#666;
font-size:15px;
line-height:1.8;
">

This code expires in
<strong>${process.env.OTP_EXPIRY_MINUTES || 10} minutes.</strong>

</p>

<p
style="
font-size:14px;
color:#999;
line-height:1.8;
">

If you didn't request this email, you can safely ignore it.
No changes will be made to your account.

</p>

</td>
</tr>

<tr>

<td
style="
padding:20px;
background:#f7f7f7;
text-align:center;
font-size:13px;
color:#999;
">

© ${new Date().getFullYear()} Escrow. All rights reserved.

</td>

</tr>

</table>

</body>
</html>
`;

  // Log OTP only during development
  if (process.env.NODE_ENV !== "production") {
    console.log("\n======================================");
    console.log(`EMAIL: ${email}`);
    console.log(`SUBJECT: ${subject}`);
    console.log(`OTP: ${code}`);
    console.log("======================================\n");
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject,
      html: body,
    });

    console.log(`OTP email sent successfully to ${email}`);
  } catch (error) {
    console.error("Email sending failed:", error);
    throw error;
  }
}

export async function sendPasswordResetLink(email, resetLink, expiryMinutes = 30) {
  if (!process.env.SMTP_FROM) {
    throw new Error("SMTP_FROM is missing from the environment variables.");
  }
  if (!transporter) {
    throw new Error("SMTP transporter is not configured.");
  }

  const subject = "Escrow — Reset Your Password";

  // Log in development
  if (process.env.NODE_ENV !== "production") {
    console.log("\n======================================");
    console.log(`EMAIL: ${email}`);
    console.log(`SUBJECT: ${subject}`);
    console.log(`RESET LINK: ${resetLink}`);
    console.log("======================================\n");
  }

  const body = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${subject}</title>
</head>

<body style="
margin:0;
padding:40px;
background:#f5f7fb;
font-family:Arial,Helvetica,sans-serif;
">

<table
style="
max-width:600px;
margin:auto;
background:#ffffff;
border-radius:12px;
overflow:hidden;
box-shadow:0 10px 30px rgba(0,0,0,.08);
">

<tr>
<td
style="
background:#001637;
padding:24px;
text-align:center;
color:#ffffff;
font-size:28px;
font-weight:bold;
letter-spacing:1px;
">
ESCROW
</td>
</tr>

<tr>
<td style="padding:40px;">

<h2
style="
margin-top:0;
margin-bottom:12px;
color:#001637;
">
Reset Your Password
</h2>

<p
style="
font-size:16px;
color:#555;
line-height:1.8;
margin-bottom:30px;
">
We received a request to reset the password for your Escrow account. Click the button below to create a new password. This link will expire in <strong>${expiryMinutes} minutes</strong>.
</p>

<div style="text-align:center;margin:35px 0;">
<a
href="${resetLink}"
style="
display:inline-block;
padding:16px 40px;
background:#001637;
color:#ffffff;
text-decoration:none;
border-radius:8px;
font-size:16px;
font-weight:bold;
letter-spacing:.5px;
"
>
Reset Password
</a>
</div>

<p
style="
color:#666;
font-size:14px;
line-height:1.8;
margin-bottom:12px;
">
Or copy and paste this link into your browser:
</p>
<p
style="
color:#1a56a0;
font-size:13px;
word-break:break-all;
line-height:1.6;
">
${resetLink}
</p>

<p
style="
font-size:14px;
color:#999;
line-height:1.8;
margin-top:24px;
">
If you did not request a password reset, you can safely ignore this email.
Your password will not be changed.
</p>

</td>
</tr>

<tr>
<td
style="
padding:20px;
background:#f7f7f7;
text-align:center;
font-size:13px;
color:#999;
">
© ${new Date().getFullYear()} Escrow. All rights reserved.
</td>
</tr>

</table>

</body>
</html>
`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject,
      html: body,
    });
    console.log(`Password reset link sent successfully to ${email}`);
  } catch (error) {
    console.error("Password reset email sending failed:", error);
    throw error;
  }
}
