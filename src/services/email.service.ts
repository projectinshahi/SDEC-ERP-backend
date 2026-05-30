import nodemailer, { Transporter } from 'nodemailer';

/**
 * Email Service
 *
 * Wraps nodemailer with proper error handling.
 * sendPasswordResetEmail returns false on ANY failure — the controller
 * uses this to decide whether to return success or error to the frontend.
 */

// Build transporter from env vars
function createTransporter(): Transporter {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true', // true = port 465, false = 587 with STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false
    },
    // Increase timeout for slow SMTP servers
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

const transporter = createTransporter();

// ─────────────────────────────────────────────────────────────────────────────
// HTML template
// ─────────────────────────────────────────────────────────────────────────────
function getPasswordResetTemplate(userName: string, resetLink: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Password Reset — SDEC ERP</title>
  <style>
    body { margin:0; padding:20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0d0d0d; }
    .wrap { max-width:600px; margin:0 auto; background:#1a1a1a; border:1px solid #d4af37; border-radius:12px; overflow:hidden; }
    .hdr  { background:#000; border-bottom:2px solid #d4af37; padding:30px; text-align:center; }
    .hdr h1 { color:#d4af37; font-size:26px; margin:0 0 4px; letter-spacing:2px; }
    .hdr p  { color:#888; font-size:13px; margin:0; }
    .body { padding:36px 30px; color:#e0e0e0; }
    .greeting { font-size:16px; color:#d4af37; margin-bottom:16px; }
    .msg  { font-size:14px; line-height:1.8; color:#b0b0b0; margin-bottom:28px; }
    .btn-wrap { text-align:center; margin:36px 0; }
    .btn  { display:inline-block; background:linear-gradient(135deg,#d4af37,#f1d85a); color:#000; padding:14px 40px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; letter-spacing:1px; }
    .link-box { background:rgba(0,0,0,.3); border-radius:6px; padding:10px 14px; word-break:break-all; font-size:12px; color:#aaa; margin-top:12px; text-align:center; }
    .warn { background:rgba(212,175,55,.1); border-left:4px solid #d4af37; padding:14px; margin:24px 0; border-radius:4px; font-size:13px; color:#d4af37; }
    .sec  { background:rgba(255,107,107,.1); border-left:4px solid #ff6b6b; padding:14px; margin:16px 0; border-radius:4px; font-size:12px; color:#ff9999; }
    .ftr  { background:rgba(0,0,0,.5); border-top:1px solid #d4af37; padding:18px 30px; text-align:center; font-size:12px; color:#888; }
    .ftr a { color:#d4af37; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <h1>🔐 PASSWORD RESET</h1>
      <p>SDEC ERP System</p>
    </div>
    <div class="body">
      <div class="greeting">Hello <strong>${userName}</strong>,</div>
      <div class="msg">
        We received a request to reset the password for your SDEC ERP account.
        Click the button below to choose a new password.
      </div>
      <div class="btn-wrap">
        <a href="${resetLink}" class="btn">RESET MY PASSWORD</a>
      </div>
      <div class="link-box">
        Or paste this link in your browser:<br/>
        <span style="color:#d4af37">${resetLink}</span>
      </div>
      <div class="warn">
        ⏰ <strong>This link expires in 15 minutes.</strong>
        If you didn't request a password reset, you can safely ignore this email.
      </div>
      <div class="sec">
        🛡️ Never share this link with anyone. Our team will never ask for your password.
      </div>
    </div>
    <div class="ftr">
      <p>© ${new Date().getFullYear()} SDEC ERP System. All rights reserved.</p>
      <p><a href="${process.env.FRONTEND_URL}">Visit Site</a></p>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendPasswordResetEmail
// Returns true  → email delivered to SMTP server
// Returns false → any failure (auth, network, invalid address, etc.)
// ─────────────────────────────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (
  toEmail: string,
  userName: string,
  resetToken: string
): Promise<boolean> => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: `"SDEC ERP" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: toEmail,                          // ← always the user's email entered in the form
    subject: '🔐 Password Reset Request — SDEC ERP',
    html: getPasswordResetTemplate(userName || 'User', resetLink),
  };

  console.log(`[Email] Attempting to send reset email TO: ${toEmail}`);
  console.log(`[Email] FROM: ${mailOptions.from}`);

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email] ✅ EMAIL SENT SUCCESSFULLY — Message ID: ${info.messageId}`);
    return true;
  } catch (error: any) {
    console.error(`[Email] ❌ EMAIL ERROR:`, error.message || error);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// verifySMTPConnection — call on server startup
// ─────────────────────────────────────────────────────────────────────────────
export const verifySMTPConnection = async (): Promise<boolean> => {
  try {
    console.log('[Email] Verifying SMTP connection...');
    await transporter.verify();
    console.log('[Email] ✅ SMTP connected successfully');
    return true;
  } catch (error: any) {
    console.error('[Email] ❌ SMTP connection FAILED:', error.message || error);
    console.error('[Email] Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
    return false;
  }
};
