import { Request, Response, NextFunction } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';
import { permissionGranted } from '../utils/salesPermissions.js';

/**
 * Basic authentication middleware to extract userId and role.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      'SELECT id, role, status, must_change_password FROM users WHERE id = $1 LIMIT 1;',
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

    // Force password change check
    if (user.must_change_password) {
      const path = req.originalUrl || req.path;
      // Allow them to hit the auth change password, OR the profile endpoints so they can load the profile page to change it there.
      if (!path.includes('/api/auth/change-password') && !path.includes('/api/profile')) {
        res.status(403).json({ error: 'Forbidden: You must change your password before accessing the system.', mustChangePassword: true });
        return;
      }
    }

    // Attach to request
    (req as any).userId = userId;
    (req as any).userRole = user.role ? String(user.role).split(',')[0].trim() : 'User';

    next();
  } catch (error) {
    console.error('[Auth Middleware] Error:', error);
    res.status(500).json({ error: 'Internal Server Error during authentication' });
    return;
  }
};

/**
 * Middleware to enforce Role-Based Access Control (RBAC).
 * Expects a dummy token in the format `Bearer user-token-[id]`.
 * 
 * @param requiredPermission The specific permission key required (e.g., 'task.column.create')
 */
export const checkPermission = (requiredPermission: string) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Re-use authenticate to ensure req.userId and req.userRole are populated
    await authenticate(req, res, async () => {
      try {
        const userId = (req as any).userId;
        const roleName = (req as any).userRole;

        // Super Admin bypasses all checks
        if (isGlobalAdmin(roleName)) {
          return next();
        }

        // Query database for role permissions
        let roles = await prisma.$queryRawUnsafe<any[]>(
          'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
          roleName
        );
        if (roles.length === 0) {
          roles = await prisma.$queryRawUnsafe<any[]>(
            'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
            roleName
          );
        }

        let permissions: string[] = [];
        if (roles.length > 0 && roles[0].permissions) {
          const raw = roles[0].permissions;
          permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
        }

        // Check the permission (exact match, or via the Sales coarse→granular
        // bridge so a coarse/master-key role still satisfies a granular route).
        if (!permissionGranted(permissions, requiredPermission)) {
          console.warn(`[Auth] User ${userId} denied access to ${requiredPermission}`);
          res.status(403).json({ error: `Forbidden: Missing required permission '${requiredPermission}'` });
          return;
        }

        // Access granted
        next();
      } catch (error) {
        console.error('[Auth Middleware Permission Check] Error:', error);
        res.status(500).json({ error: 'Internal Server Error during authorization' });
        return;
      }
    });
  };
};

/**
 * Like checkPermission but passes if the user holds ANY of the given keys
 * (each evaluated through the Sales coarse→granular bridge). Used for shared
 * endpoints reachable by several roles (e.g. the assignable-users picklist).
 */
export const checkAnyPermission = (requiredAny: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await authenticate(req, res, async () => {
      try {
        const roleName = (req as any).userRole;
        if (isGlobalAdmin(roleName)) {
          return next();
        }
        let roles = await prisma.$queryRawUnsafe<any[]>(
          'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
          roleName,
        );
        if (roles.length === 0) {
          roles = await prisma.$queryRawUnsafe<any[]>(
            'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
            roleName,
          );
        }
        let permissions: string[] = [];
        if (roles.length > 0 && roles[0].permissions) {
          const raw = roles[0].permissions;
          permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
        }
        if (requiredAny.some((k) => permissionGranted(permissions, k))) {
          return next();
        }
        res.status(403).json({ error: 'Forbidden: missing required permission' });
      } catch (error) {
        console.error('[Auth Middleware Any-Permission Check] Error:', error);
        res.status(500).json({ error: 'Internal Server Error during authorization' });
      }
    });
  };
};

/**
 * Middleware that restricts a route to global admins (SuperAdmin / Admin).
 * Used for organization-wide endpoints (e.g. the Master Dashboard) so they can
 * never be reached by a regular authenticated user, independent of the
 * controller's own checks. Mirrors the frontend master-module gate.
 */
export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction): void => {
  authenticate(req, res, async () => {
    const roleName = (req as any).userRole;
    if (!isGlobalAdmin(roleName)) {
      res.status(403).json({ error: 'Forbidden: SuperAdmin access required' });
      return;
    }
    next();
  });
};

/**
 * Middleware to enforce Project-level Role-Based Access Control.
 * Assumes the project ID is in req.params.id.
 *
 * @param allowedRoles Array of allowed roles (e.g., ['admin', 'editor'])
 */
export const checkProjectRole = (allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Re-use authenticate to ensure req.userId and req.userRole are populated
    await authenticate(req, res, async () => {
      try {
        const userId = (req as any).userId;
        const userRole = ((req as any).userRole || '').toLowerCase();

        // Global Admins bypass
        if (isGlobalAdmin(userRole)) {
          return next();
        }

        let projectId = req.params.id;
        if (Array.isArray(projectId)) {
          projectId = projectId[0];
        }

        if (!projectId || typeof projectId !== 'string') {
          res.status(400).json({ error: 'Project ID is required in URL parameters' });
          return;
        }

        // Fetch user's role in this specific project
        const member = await prisma.project_members.findUnique({
          where: {
            project_id_user_id: { project_id: projectId, user_id: userId }
          }
        });

        if (!member) {
          res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
          return;
        }

        if (!allowedRoles.includes(member.role)) {
          res.status(403).json({ error: `Forbidden: Project role '${member.role}' is not authorized for this action` });
          return;
        }

        next();
      } catch (error) {
        console.error('[Project Auth Middleware] Error:', error);
        res.status(500).json({ error: 'Internal Server Error during project authorization' });
        return;
      }
    });
  };
};
