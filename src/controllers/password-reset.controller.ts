import { Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import prisma from '../config/db.js';
import { sendPasswordResetEmail } from '../services/email.service.js';

/**
 * Hash a password or token using SHA-256.
 * Consistent with auth.controller.ts so login still works after a reset.
 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    console.log('[ForgotPassword] REQUEST received:', email);

    // ── Input validation ────────────────────────────────────────────────────
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // ── Look up user ────────────────────────────────────────────────────────
    let users: any[] = [];
    try {
      users = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id, name, email FROM users WHERE LOWER(email) = $1 LIMIT 1;',
        trimmedEmail
      );
    } catch (dbErr) {
      console.error('[ForgotPassword] DB lookup error:', dbErr);
      return res.status(500).json({
        success: false,
        message: 'Database error. Please try again later.',
      });
    }

    console.log('[ForgotPassword] USER FOUND:', users.length > 0 ? users[0].email : 'none');

    if (users.length === 0) {
      // Security: don't reveal whether the email exists
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    }

    const user = users[0];

    // ── Generate reset token ────────────────────────────────────────────────
    const resetToken = randomBytes(32).toString('hex');   // plain token → sent in email
    const hashedToken = sha256(resetToken);               // hashed token → stored in DB

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // ── Persist token to DB ─────────────────────────────────────────────────
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE users
         SET "resetPasswordToken" = $1, "resetPasswordExpires" = $2
         WHERE id = $3;`,
        hashedToken,
        expiresAt,
        user.id
      );
    } catch (dbErr) {
      console.error('[ForgotPassword] Failed to store reset token:', dbErr);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate reset token. Please try again.',
      });
    }

    // ── Send email in background to prevent request hanging ─────────────────
    console.log('[ForgotPassword] Triggering email in background to:', user.email);

    sendPasswordResetEmail(user.email, user.name, resetToken)
      .then(async (emailSent) => {
        if (!emailSent) {
          console.error('[ForgotPassword] EMAIL FAILED in background for:', user.email);
          // Clear the token so it can't be used
          await prisma.$executeRawUnsafe(
            `UPDATE users SET "resetPasswordToken" = NULL, "resetPasswordExpires" = NULL WHERE id = $1;`,
            user.id
          ).catch((e) => console.error('[ForgotPassword] Failed to clear token:', e));
        } else {
          console.log('[ForgotPassword] EMAIL SENT SUCCESSFULLY in background to:', user.email);
        }
      })
      .catch((err) => console.error('[ForgotPassword] Background email error:', err));

    // Return immediately (do not wait for SMTP server)
    return res.status(200).json({
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (error) {
    console.error('[ForgotPassword] Unexpected error:', error);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred. Please try again later.',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/validate-reset-token
// ─────────────────────────────────────────────────────────────────────────────
export const validateResetToken = async (req: Request, res: Response) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }

    console.log('[ValidateToken] Checking token...');

    const hashedToken = sha256(token);

    const users = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, email FROM users
       WHERE "resetPasswordToken" = $1
         AND "resetPasswordExpires" > NOW()
       LIMIT 1;`,
      hashedToken
    );

    if (users.length === 0) {
      console.warn('[ValidateToken] Invalid or expired token');
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid or has expired. Please request a new one.',
      });
    }

    console.log('[ValidateToken] Token valid for:', users[0].email);

    return res.status(200).json({ success: true, message: 'Token is valid' });
  } catch (error) {
    console.error('[ValidateToken] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while validating the token.',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password, confirmPassword } = req.body;

    // ── Input validation ────────────────────────────────────────────────────
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'Reset token is missing' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }
    if (!confirmPassword || password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ success: false, message: 'Password must contain at least one uppercase letter' });
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ success: false, message: 'Password must contain at least one lowercase letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ success: false, message: 'Password must contain at least one number' });
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      return res.status(400).json({ success: false, message: 'Password must contain at least one special character' });
    }

    console.log('[ResetPassword] Request received');

    const hashedToken = sha256(token);

    // ── Find user with valid token ───────────────────────────────────────────
    const users = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, email FROM users
       WHERE "resetPasswordToken" = $1
         AND "resetPasswordExpires" > NOW()
       LIMIT 1;`,
      hashedToken
    );

    if (users.length === 0) {
      console.warn('[ResetPassword] Invalid or expired token');
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid or has expired. Please request a new one.',
      });
    }

    const user = users[0];
    console.log('[ResetPassword] Valid token for user:', user.email);

    // ── Hash new password with SHA-256 (consistent with login) ──────────────
    const hashedPassword = sha256(password);

    // ── Update password and clear token ─────────────────────────────────────
    await prisma.$executeRawUnsafe(
      `UPDATE users
       SET password = $1, "resetPasswordToken" = NULL, "resetPasswordExpires" = NULL
       WHERE id = $2;`,
      hashedPassword,
      user.id
    );

    console.log('[ResetPassword] Password updated successfully for:', user.email);

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    console.error('[ResetPassword] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while resetting your password. Please try again.',
    });
  }
};
