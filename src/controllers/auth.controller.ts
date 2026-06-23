import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import prisma from '../config/db.js';

/** SHA-256 hash — same algorithm used when storing passwords */
function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * POST /api/auth/login
 *
 * Supports two login paths:
 *  1. Hardcoded Super Admin  (admin@gmail.com / admin123)
 *  2. Any user created via the User Management module
 *     — looks up the user in the DB, verifies hashed password,
 *       then fetches their role's permissions so the frontend
 *       can enforce RBAC immediately after login.
 */
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // ✓ Trim whitespace from email and password
    const trimmedEmail = email ? String(email).trim().toLowerCase() : '';
    const trimmedPassword = password ? String(password).trim() : '';

    if (!trimmedEmail || !trimmedPassword) {
      console.warn('[Auth] Missing email or password in request');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // ── DB Authentication ─────────────────────────────────────────────────────

    console.log(`[Auth] Attempting to authenticate user: ${trimmedEmail}`);

    let dbUsers: any[] = [];
    try {
      dbUsers = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id, name, email, password, role, status, must_change_password FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
        trimmedEmail
      );
    } catch (dbErr) {
      console.error('[Auth] Database lookup failed:', dbErr);
      return res.status(500).json({ error: 'Database error during authentication' });
    }

    if (dbUsers.length === 0) {
      console.warn(`[Auth] No user found with email: ${trimmedEmail}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const dbUser = dbUsers[0];
    console.log(`[Auth] User found in database: ${dbUser.email} (ID: ${dbUser.id}, Status: ${dbUser.status})`);

    // Check account status
    if (String(dbUser.status).toLowerCase() === 'inactive') {
      console.warn(`[Auth] Login attempt by inactive user: ${trimmedEmail}`);
      return res.status(403).json({ error: 'Your account is inactive. Contact an administrator.' });
    }

    // Verify password — handle both bcrypt and legacy SHA-256
    let isMatch = false;
    if (dbUser.password.startsWith('$2b$') || dbUser.password.startsWith('$2a$')) {
      isMatch = await bcrypt.compare(trimmedPassword, dbUser.password);
    } else {
      const hashedInput = hashPassword(trimmedPassword);
      console.log(`[Auth] Comparing hashes for user ${trimmedEmail}:`);
      console.log(`  - Input hash: ${hashedInput.substring(0, 16)}...`);
      console.log(`  - Stored hash: ${dbUser.password.substring(0, 16)}...`);
      isMatch = (dbUser.password === hashedInput);
    }

    if (!isMatch) {
      console.warn(`[Auth] Password mismatch for user: ${trimmedEmail}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log(`[Auth] Password verification successful for user: ${trimmedEmail}`);

    // Fetch the role's permissions so the frontend can enforce RBAC
    const roleName = dbUser.role ? String(dbUser.role).split(',')[0].trim() : 'User';
    let permissions: string[] = [];

    try {
      const roleRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
        roleName
      );
      if (roleRows.length > 0 && roleRows[0].permissions) {
        const raw = roleRows[0].permissions;
        permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
      }
    } catch (roleErr) {
      console.warn(`[Auth] Could not fetch role permissions for role: ${roleName}`, roleErr);
    }

    console.log(`[Auth] Login successful for user: ${trimmedEmail} (Role: ${roleName})`);

    return res.status(200).json({
      message: 'Login successful',
      token: `user-token-${dbUser.id}`,
      user: {
        id: String(dbUser.id),
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        roleName,
        permissions,
        mustChangePassword: dbUser.must_change_password || false,
      },
    });
  } catch (error: any) {
    console.error('[Auth] Unexpected login error:', error.message || error);
    return res.status(500).json({ error: 'An unexpected internal authentication error occurred' });
  }
};

/**
 * GET /api/auth/me
 *
 * Returns the authenticated user with their CURRENT role + permissions read
 * fresh from the database. The frontend calls this on mount / window focus to
 * keep RBAC in sync WITHOUT a re-login: when an admin changes a role's
 * permissions, the next /me refresh collapses or expands the user's UI access.
 * (`authenticate` has already populated req.userId.)
 */
export const getMe = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, email, role, status, must_change_password FROM users WHERE id = $1 LIMIT 1;',
      userId
    );
    if (rows.length === 0) return res.status(401).json({ error: 'User not found' });

    const dbUser = rows[0];
    if (String(dbUser.status).toLowerCase() === 'inactive') {
      return res.status(403).json({ error: 'Your account is inactive. Contact an administrator.' });
    }

    const roleName = dbUser.role ? String(dbUser.role).split(',')[0].trim() : 'User';
    let permissions: string[] = [];
    try {
      const roleRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
        roleName
      );
      if (roleRows.length > 0 && roleRows[0].permissions) {
        const raw = roleRows[0].permissions;
        permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
      }
    } catch (roleErr) {
      console.warn(`[Auth] /me could not fetch permissions for role: ${roleName}`, roleErr);
    }

    return res.status(200).json({
      user: {
        id: String(dbUser.id),
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        roleName,
        permissions,
        mustChangePassword: dbUser.must_change_password || false,
      },
    });
  } catch (error: any) {
    console.error('[Auth] /me error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load current user' });
  }
};

/**
 * POST /api/auth/change-password
 * Allows a user to change their password, specifically needed for first login.
 */
export const changePassword = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { currentPassword, newPassword } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Validate new password strength
    const pwd = String(newPassword);
    if (pwd.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(pwd)) return res.status(400).json({ error: 'Password must contain uppercase letters' });
    if (!/[a-z]/.test(pwd)) return res.status(400).json({ error: 'Password must contain lowercase letters' });
    if (!/[0-9]/.test(pwd)) return res.status(400).json({ error: 'Password must contain numbers' });
    if (!/[^A-Za-z0-9]/.test(pwd)) return res.status(400).json({ error: 'Password must contain special characters' });

    // Fetch user
    const dbUsers = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, password FROM users WHERE id = $1 LIMIT 1;',
      userId
    );

    if (dbUsers.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const dbUser = dbUsers[0];

    // Verify current password — supports BOTH bcrypt and legacy SHA-256 hashes
    // (older/seeded accounts may still be SHA-256), mirroring the login flow.
    const stored = String(dbUser.password || '');
    const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
    const currentMatches = isBcrypt
      ? await bcrypt.compare(String(currentPassword), stored)
      : stored === hashPassword(String(currentPassword));
    if (!currentMatches) {
      // 400 (not 401): a wrong CURRENT password is a validation failure, not an
      // expired session — the frontend's global 401 handler would otherwise log
      // the user out and redirect to /login instead of showing this message.
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    // New password must differ from the current one.
    if (String(currentPassword) === pwd) {
      return res.status(400).json({ error: 'New password must be different from the current password.' });
    }

    // Hash the new password with bcrypt (never store plain text or weak hashes).
    // This also migrates legacy SHA-256 accounts to bcrypt on first change.
    const newHashedPassword = await bcrypt.hash(pwd, 10);

    // Update DB
    await prisma.$executeRawUnsafe(
      'UPDATE users SET password = $1, must_change_password = false WHERE id = $2;',
      newHashedPassword,
      userId
    );

    // Log Activity
    import('../services/activity.service.js').then(({ activityService }) => {
      activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'password_changed',
        description: 'User changed their password'
      });
    });

    return res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    console.error('[Auth] Error changing password:', error.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
