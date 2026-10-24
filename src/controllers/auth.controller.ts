import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import prisma from '../config/db.js';
import { issueToken } from '../utils/authToken.js';
import { EXTERNAL_ROLE, isExternalUser } from '../utils/roles.js';
import { isVisibleUserStatus } from '../services/userLookup.service.js';

/** SHA-256 hash — same algorithm used when storing passwords */
function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** Checks a plain password against a stored bcrypt or legacy SHA-256 hash. */
async function passwordMatches(plain: string, stored: string): Promise<boolean> {
  const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
  return isBcrypt ? bcrypt.compare(plain, stored) : stored === hashPassword(plain);
}

/** Password strength rule shared by change-password and self sign-up. Returns the problem, or null. */
function passwordProblem(pwd: string): string | null {
  if (pwd.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pwd)) return 'Password must contain uppercase letters';
  if (!/[a-z]/.test(pwd)) return 'Password must contain lowercase letters';
  if (!/[0-9]/.test(pwd)) return 'Password must contain numbers';
  if (!/[^A-Za-z0-9]/.test(pwd)) return 'Password must contain special characters';
  return null;
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
    if (!isVisibleUserStatus(dbUser.status)) {
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

    // Fetch permissions for ALL roles assigned to the user (comma-separated)
    const roleNames = dbUser.role ? String(dbUser.role).split(',').map(r => r.trim()).filter(Boolean) : ['User'];
    const roleName = roleNames[0] || 'User'; // Keep roleName for backwards compatibility
    let permissions: string[] = [];

    try {
      const allPerms = new Set<string>();
      for (const rName of roleNames) {
        let roleRows = await prisma.$queryRawUnsafe<any[]>(
          'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
          rName
        );
        if (roleRows.length === 0) {
          roleRows = await prisma.$queryRawUnsafe<any[]>(
            'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
            rName
          );
        }
        if (roleRows.length > 0 && roleRows[0].permissions) {
          const raw = roleRows[0].permissions;
          const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
          if (Array.isArray(parsed)) {
            parsed.forEach(p => allPerms.add(p));
          }
        }
      }
      permissions = Array.from(allPerms);
    } catch (roleErr) {
      console.warn(`[Auth] Could not fetch role permissions for roles: ${roleNames.join(', ')}`, roleErr);
    }

    console.log(`[Auth] Login successful for user: ${trimmedEmail} (Role: ${roleName})`);

    return res.status(200).json({
      message: 'Login successful',
      token: issueToken(dbUser.id),
      user: {
        id: String(dbUser.id),
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        roleName,
        permissions,
        mustChangePassword: dbUser.must_change_password || false,
        // 'external' = self-signed-up app user: show ONLY My Tasks.
        accountType: isExternalUser(roleNames) ? 'external' : 'company',
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
    if (!isVisibleUserStatus(dbUser.status)) {
      return res.status(403).json({ error: 'Your account is inactive. Contact an administrator.' });
    }

    const roleNames = dbUser.role ? String(dbUser.role).split(',').map(r => r.trim()).filter(Boolean) : ['User'];
    const roleName = roleNames[0] || 'User'; // Keep roleName for backwards compatibility
    let permissions: string[] = [];

    try {
      const allPerms = new Set<string>();
      for (const rName of roleNames) {
        let roleRows = await prisma.$queryRawUnsafe<any[]>(
          'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
          rName
        );
        if (roleRows.length === 0) {
          roleRows = await prisma.$queryRawUnsafe<any[]>(
            'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
            rName
          );
        }
        if (roleRows.length > 0 && roleRows[0].permissions) {
          const raw = roleRows[0].permissions;
          const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
          if (Array.isArray(parsed)) {
            parsed.forEach(p => allPerms.add(p));
          }
        }
      }
      permissions = Array.from(allPerms);
    } catch (roleErr) {
      console.warn(`[Auth] /me could not fetch permissions for roles: ${roleNames.join(', ')}`, roleErr);
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
        // 'external' = self-signed-up app user: show ONLY My Tasks.
        accountType: isExternalUser(roleNames) ? 'external' : 'company',
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
    const problem = passwordProblem(pwd);
    if (problem) return res.status(400).json({ error: problem });

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
    if (!(await passwordMatches(String(currentPassword), String(dbUser.password || '')))) {
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

/**
 * POST /api/auth/register  — self sign-up from the mobile app.
 *
 * For people who download the app themselves (or open a task invite) and were
 * never added in User Management. They always get the External role: My Tasks
 * they are invited to, nothing else (enforced in auth.middleware). Company
 * users are still created only by Admin/HR; an admin promotes an External user
 * by giving them a company role in User Management.
 *
 * Body: { name, email, password }  →  same shape as /login (token + user).
 */
export const register = async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '').trim();

    if (name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: 'Name must be 2–50 characters' });
    }
    if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    // Company users already have an account (created by Admin/HR) — they log in.
    const existing = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
      email,
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }

    // ponytail: no rate limit — app.ts sets no `trust proxy`, so an IP key would be
    // one shared bucket behind Render. Add one keyed on X-Forwarded-For if sign-up spam appears.
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO users (name, email, password, role, status, must_change_password)
       VALUES ($1, $2, $3, $4, 'active', false)
       RETURNING id, name, email, role;`,
      name, email, await bcrypt.hash(password, 10), EXTERNAL_ROLE,
    );
    const user = rows[0];

    return res.status(201).json({
      message: 'Account created',
      token: issueToken(user.id),
      user: {
        id: String(user.id),
        name: user.name,
        email: user.email,
        role: user.role,
        roleName: user.role,
        permissions: ['mytasks.edit', 'mytasks.create', 'mytasks.delete', 'mytasks.assign'],
        mustChangePassword: false,
        accountType: 'external',
      },
    });
  } catch (error: any) {
    // Two concurrent sign-ups with one email: the unique index decides.
    if (String(error?.message || '').includes('23505')) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }
    console.error('[Auth] Register error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to create account' });
  }
};

/**
 * DELETE /api/auth/account  — in-app account deletion (App Store / Play Store rule).
 *
 * Body: { password }. Only EXTERNAL (self-signed-up) accounts can delete themselves.
 * The account is ANONYMISED, not hard-deleted, so shared tasks keep their history:
 *  - personal data wiped: name → "Deleted user", email → deleted-<id>@deleted.invalid,
 *    phone/reset token cleared, password replaced with an unusable value,
 *    status → 'deleted' (auth middleware, login and socket reject it, so old
 *    tokens die and the account is hidden from pickers and rosters);
 *  - removed from every task's members and In-Charge, so tasks fall back to
 *    their creator; their OWN tasks, reads, invites, DMs and notifications are
 *    deleted;
 *  - messages and attachments they left on OTHER people's tasks stay, shown
 *    as "Deleted user".
 * Company accounts are owned by the organisation (and are linked to leads,
 * deals, customers…) — they get 403 and must ask an admin.
 */
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const password = String(req.body?.password ?? '').trim();
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });

    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, email, password, role FROM users WHERE id = $1 LIMIT 1;',
      userId,
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!isExternalUser(user.role)) {
      return res.status(403).json({
        error: 'This account is managed by your organisation. Please contact your administrator to delete it.',
        managedAccount: true,
      });
    }
    // 400, not 401 — a 401 would trip the app's global "session expired" logout.
    if (!(await passwordMatches(password, String(user.password || '')))) {
      return res.status(400).json({ error: 'Password is incorrect' });
    }

    const id = user.id;
    await prisma.$transaction([
      // Their own tasks (External users can only create tasks for themselves).
      prisma.$executeRawUnsafe('DELETE FROM my_tasks WHERE created_by = $1;', id),
      // Off every other task: no longer a member or In-Charge → back to the creator.
      prisma.$executeRawUnsafe('DELETE FROM my_task_members WHERE user_id = $1;', id),
      prisma.$executeRawUnsafe('UPDATE my_tasks SET in_charge_id = NULL WHERE in_charge_id = $1;', id),
      prisma.$executeRawUnsafe('DELETE FROM my_task_reads WHERE user_id = $1;', id),
      prisma.$executeRawUnsafe('DELETE FROM my_task_invites WHERE accepted_by = $1;', id),
      prisma.$executeRawUnsafe('DELETE FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1;', id),
      prisma.$executeRawUnsafe('DELETE FROM notifications WHERE user_id = $1;', id),
      // Anonymise. The password is not a bcrypt/SHA-256 hash, so nothing can match it.
      prisma.$executeRawUnsafe(
        `UPDATE users SET name = 'Deleted user', email = $2, phone = NULL, phone_verified = false,
           password = $3, status = 'deleted', "resetPasswordToken" = NULL, "resetPasswordExpires" = NULL
         WHERE id = $1;`,
        id, `deleted-${id}@deleted.invalid`, `disabled:${randomBytes(24).toString('hex')}`,
      ),
    ]);
    console.log(`[Auth] External account ${id} deleted (anonymised)`);
    return res.status(200).json({ success: true, message: 'Your account has been deleted' });
  } catch (error: any) {
    console.error('[Auth] Delete account error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
};
