import { Request, Response, NextFunction } from 'express';
import prisma from '../config/db';

/**
 * Middleware to enforce Role-Based Access Control (RBAC).
 * Expects a dummy token in the format `Bearer user-token-[id]`.
 * 
 * @param requiredPermission The specific permission key required (e.g., 'task.column.create')
 */
export const checkPermission = (requiredPermission: string) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer user-token-')) {
        res.status(401).json({ error: 'Unauthorized: No valid token provided' });
        return;
      }

      // Extract user ID from the dummy token
      const tokenParts = authHeader.split('user-token-');
      const userIdStr = tokenParts[1];
      const userId = parseInt(userIdStr, 10);

      if (isNaN(userId)) {
        res.status(401).json({ error: 'Unauthorized: Invalid token format' });
        return;
      }

      // Query database for user
      const users = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id, role, status FROM users WHERE id = $1 LIMIT 1;',
        userId
      );

      if (users.length === 0) {
        res.status(401).json({ error: 'Unauthorized: User not found' });
        return;
      }

      const user = users[0];

      // Check if user is active
      if (String(user.status).toLowerCase() === 'inactive') {
        res.status(403).json({ error: 'Forbidden: Account is inactive' });
        return;
      }

      // Extract role name
      const roleName = user.role ? String(user.role).split(',')[0].trim() : 'User';

      // Super Admin bypasses all checks
      if (roleName.toLowerCase() === 'super admin' || roleName.toLowerCase() === 'admin') {
        return next();
      }

      // Query database for role permissions
      const roles = await prisma.$queryRawUnsafe<any[]>(
        'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
        roleName
      );

      let permissions: string[] = [];
      if (roles.length > 0 && roles[0].permissions) {
        const raw = roles[0].permissions;
        permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
      }

      // Check if required permission exists in the array
      if (!permissions.includes(requiredPermission)) {
        console.warn(`[Auth] User ${userId} denied access to ${requiredPermission}`);
        res.status(403).json({ error: `Forbidden: Missing required permission '${requiredPermission}'` });
        return;
      }

      // Access granted
      next();
    } catch (error) {
      console.error('[Auth Middleware] Error:', error);
      res.status(500).json({ error: 'Internal Server Error during authorization' });
      return;
    }
  };
};
