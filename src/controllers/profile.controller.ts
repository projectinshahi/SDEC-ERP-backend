import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';

// Fallback for verifying old SHA-256 hashes
function hashPasswordSha256(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * GET /api/profile
 * Fetch the authenticated user's profile
 */
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const users = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, email, phone, role, status, "createdAt" FROM users WHERE id = $1 LIMIT 1;',
      userId
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    return res.status(200).json({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    });
  } catch (error: any) {
    console.error('[Profile] Error fetching profile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /api/profile
 * Update the authenticated user's profile
 */
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { name, phone } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Update the database
    await prisma.$executeRawUnsafe(
      'UPDATE users SET name = $1, phone = $2 WHERE id = $3;',
      String(name).trim(),
      phone ? String(phone).trim() : null,
      userId
    );

    // Log Activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: undefined,
      type: 'user_updated',
      description: 'User updated their profile information'
    });

    return res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error: any) {
    console.error('[Profile] Error updating profile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/profile/change-password
 * Change the authenticated user's password
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

    // Validate new password
    const pwd = String(newPassword);
    if (pwd.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(pwd)) return res.status(400).json({ error: 'Password must contain uppercase letters' });
    if (!/[a-z]/.test(pwd)) return res.status(400).json({ error: 'Password must contain lowercase letters' });
    if (!/[0-9]/.test(pwd)) return res.status(400).json({ error: 'Password must contain numbers' });
    if (!/[^A-Za-z0-9]/.test(pwd)) return res.status(400).json({ error: 'Password must contain special characters' });

    // Fetch user's current password hash
    const dbUsers = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, password FROM users WHERE id = $1 LIMIT 1;',
      userId
    );

    if (dbUsers.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const dbUser = dbUsers[0];
    const storedHash = dbUser.password;

    // Verify current password (handle both bcrypt and legacy SHA-256)
    let isMatch = false;
    if (storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$')) {
      isMatch = await bcrypt.compare(String(currentPassword), storedHash);
    } else {
      // Legacy SHA-256 verification
      isMatch = hashPasswordSha256(String(currentPassword)) === storedHash;
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect current password' });
    }

    // Hash new password using bcrypt
    const saltRounds = 10;
    const newHashedPassword = await bcrypt.hash(pwd, saltRounds);

    // Update DB
    await prisma.$executeRawUnsafe(
      'UPDATE users SET password = $1, must_change_password = false WHERE id = $2;',
      newHashedPassword,
      userId
    );

    // Log Activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: undefined,
      type: 'password_changed',
      description: 'User changed their password'
    });

    return res.status(200).json({ message: 'Password changed successfully' });
  } catch (error: any) {
    console.error('[Profile] Error changing password:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
