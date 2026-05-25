import { Request, Response } from 'express';
import { createHash } from 'crypto';
import prisma from '../config/db';

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

    // ── Path 1: Super Admin (hardcoded) ──────────────────────────────────────
    const ADMIN_EMAIL = 'admin@gmail.com';
    const ADMIN_PASSWORD = 'admin123';

    if (trimmedEmail === ADMIN_EMAIL && trimmedPassword === ADMIN_PASSWORD) {
      console.log('[Auth] Super Admin login successful');
      return res.status(200).json({
        message: 'Login successful',
        token: 'dummy-jwt-token',
        user: {
          id: 'admin-1',
          name: 'ERP Admin',
          email: ADMIN_EMAIL,
          role: 'admin',
          roleName: 'Super Admin',
          permissions: [],   // Super Admin bypasses all checks on the frontend
        },
      });
    }

    // ── Path 2: DB user ───────────────────────────────────────────────────────
    console.log(`[Auth] Attempting to authenticate user: ${trimmedEmail}`);
    
    let dbUsers: any[] = [];
    try {
      dbUsers = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id, name, email, password, role, status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
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

    // Verify password — stored as SHA-256 hash
    const hashedInput = hashPassword(trimmedPassword);
    console.log(`[Auth] Comparing hashes for user ${trimmedEmail}:`);
    console.log(`  - Input hash: ${hashedInput.substring(0, 16)}...`);
    console.log(`  - Stored hash: ${dbUser.password.substring(0, 16)}...`);
    
    if (dbUser.password !== hashedInput) {
      console.warn(`[Auth] Password mismatch for user: ${trimmedEmail}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log(`[Auth] Password verification successful for user: ${trimmedEmail}`);

    // Fetch the role's permissions so the frontend can enforce RBAC
    const roleName = dbUser.role ? String(dbUser.role).split(',')[0].trim() : 'User';
    let permissions: string[] = [];

    try {
      const roleRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
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
      },
    });
  } catch (error: any) {
    console.error('[Auth] Unexpected login error:', error.message || error);
    return res.status(500).json({ error: 'An unexpected internal authentication error occurred' });
  }
};
