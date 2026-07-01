import sgMail from '@sendgrid/mail';

/**
 * Email Service
 *
 * Wraps @sendgrid/mail with proper error handling.
 * sendPasswordResetEmail returns false on ANY failure — the controller
 * uses this to decide whether to return success or error to the frontend.
 */

// Initialize SendGrid with API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

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
      <p><a href="${resetLink.split('/reset-password')[0]}">Visit Site</a></p>
    </div>
  </div>
</body>
</html>`;
}

function getWelcomeTemplate(userName: string, loginEmail: string, tempPassword: string, frontendUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to ERP Portal</title>
  <style>
    body { margin:0; padding:20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f7f6; }
    .wrap { max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e0e6ed; border-radius:12px; overflow:hidden; }
    .hdr  { background:#0052cc; padding:30px; text-align:center; color:#ffffff; }
    .hdr h1 { margin:0 0 4px; font-size:24px; font-weight:600; }
    .body { padding:36px 30px; color:#333333; line-height: 1.6; }
    .greeting { font-size:18px; font-weight:600; margin-bottom:16px; }
    .box { background:#f4f5f7; border:1px solid #dfe1e6; border-radius:8px; padding:20px; margin:24px 0; }
    .box p { margin:0 0 10px; font-size: 14px; color:#5e6c84; }
    .box strong { color:#172b4d; font-size:16px; display:block; margin-bottom:8px; }
    .btn-wrap { text-align:center; margin:36px 0; }
    .btn  { display:inline-block; background:#0052cc; color:#ffffff; padding:14px 40px; border-radius:8px; text-decoration:none; font-weight:600; font-size:15px; }
    .warn { background:#fff0b3; border-left:4px solid #ff991f; padding:14px; margin:24px 0; border-radius:4px; font-size:14px; color:#172b4d; }
    .ftr  { background:#fafbfc; border-top:1px solid #dfe1e6; padding:18px 30px; text-align:center; font-size:12px; color:#7a869a; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <h1>Welcome to ERP Portal</h1>
    </div>
    <div class="body">
      <div class="greeting">Hello ${userName},</div>
      <p>An ERP account has been created for you by your administrator.</p>
      
      <div class="box">
        <p>Login Email:</p>
        <strong>${loginEmail}</strong>
        
        <p>Temporary Password:</p>
        <strong>${tempPassword}</strong>
      </div>

      <div class="warn">
        <strong>Important Security Notice:</strong><br/>
        For security reasons, you must change your password immediately after your first login.
      </div>

      <div class="btn-wrap">
        <a href="${frontendUrl}/login" class="btn">LOGIN TO ERP</a>
      </div>
      
      <p>Regards,<br/>ERP Team</p>
    </div>
    <div class="ftr">
      <p>© ${new Date().getFullYear()} SDEC ERP System. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendPasswordResetEmail
// Returns true  → email delivered successfully via SendGrid
// Returns false → any failure (auth, network, invalid address, etc.)
// ─────────────────────────────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (
  toEmail: string,
  userName: string,
  resetToken: string
): Promise<boolean> => {
  // Use Vercel deployment as default if FRONTEND_URL is missing
  const frontendUrl = process.env.FRONTEND_URL || 'https://sdec-erp.vercel.app';
  const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: process.env.EMAIL_FROM || 'noreply@sdec-erp.com',
    to: toEmail,
    subject: '🔐 Password Reset Request — SDEC ERP',
    html: getPasswordResetTemplate(userName || 'User', resetLink),
  };

  console.log(`[Email Debug] FRONTEND_URL resolved to: ${frontendUrl}`);
  console.log(`[Email Debug] Generated Reset URL: ${resetLink}`);
  console.log(`[Email Debug] Attempting to send reset email TO (Recipient): ${toEmail}`);
  console.log(`[Email Debug] FROM: ${mailOptions.from}`);

  try {
    await sgMail.send(mailOptions);
    console.log(`[Email] ✅ EMAIL SENT SUCCESSFULLY via SendGrid to: ${toEmail}`);
    return true;
  } catch (error: any) {
    console.error(`[Email] ❌ EMAIL ERROR:`, error.response?.body || error.message || error);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// sendWelcomeEmail
// ─────────────────────────────────────────────────────────────────────────────
export const sendWelcomeEmail = async (
  toEmail: string,
  userName: string,
  tempPassword: string
): Promise<boolean> => {
  // Re-initialize at call time to avoid module-load race with dotenv
  const apiKey = process.env.SENDGRID_API_KEY || '';
  if (!apiKey) {
    console.error('[Email] ❌ SENDGRID_API_KEY is missing or empty — cannot send email');
    return false;
  }
  sgMail.setApiKey(apiKey);

  const frontendUrl = process.env.FRONTEND_URL || 'https://sdec-erp.vercel.app';
  const fromAddr    = process.env.EMAIL_FROM    || 'noreply@sdec-erp.com';

  const mailOptions = {
    from: fromAddr,
    to: toEmail,
    subject: 'Welcome to ERP Portal — Your Login Credentials',
    html: getWelcomeTemplate(userName || 'User', toEmail, tempPassword, frontendUrl),
  };

  console.log('[Email Debug] sendWelcomeEmail called');
  console.log('[Email Debug] API key present:', !!apiKey);
  console.log('[Email Debug] FROM:', fromAddr);
  console.log('[Email Debug] TO:', toEmail);
  console.log('[Email Debug] FRONTEND_URL:', frontendUrl);

  try {
    const [response] = await sgMail.send(mailOptions);
    console.log('[Email] ✅ WELCOME EMAIL SENT SUCCESSFULLY via SendGrid to:', toEmail);
    console.log('[Email] SendGrid status code:', response?.statusCode);
    return true;
  } catch (error: any) {
    const body = error?.response?.body;
    console.error('[Email] ❌ WELCOME EMAIL ERROR — status:', error?.code || error?.response?.statusCode);
    console.error('[Email] ❌ SendGrid body:', JSON.stringify(body, null, 2));
    console.error('[Email] ❌ Message:', error?.message);
    // Surface detailed SendGrid error reason
    const reason = body?.errors?.[0]?.message || error?.message || 'Unknown SendGrid error';
    console.error('[Email] ❌ Root cause:', reason);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// verifySMTPConnection — call on server startup
// ─────────────────────────────────────────────────────────────────────────────
export const verifySMTPConnection = async (): Promise<boolean> => {
  try {
    console.log('[Email] Verifying SendGrid API Key...');
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error('SENDGRID_API_KEY is not defined in .env');
    }
    console.log('[Email] ✅ SendGrid API Key found');
    return true;
  } catch (error: any) {
    console.error('[Email] ❌ SendGrid Verification FAILED:', error.message || error);
    return false;
  }
};
