import { Request, Response, NextFunction } from 'express';
import prisma from '../config/db.js';
import { authenticate } from './auth.middleware.js';

/**
 * Middleware to enforce Project-level Role-Based Access Control for Blockers.
 * Assumes the blocker ID is in req.params.id.
 * 
 * @param allowedRoles Array of allowed project roles (e.g., ['admin', 'manager', 'member']). If omitted, allows any project member.
 */
export const checkBlockerProjectAccess = (allowedRoles?: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Re-use authenticate to ensure req.userId and req.userRole are populated
    await authenticate(req, res, async () => {
      try {
        const userId = (req as any).userId;
        const userRole = ((req as any).userRole || '').toLowerCase();
        
        // Global Admins bypass project-level checks
        if (userRole === 'super admin' || userRole === 'admin') {
          return next();
        }

        const blockerIdStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const blockerId = parseInt(blockerIdStr as string, 10);
        
        if (isNaN(blockerId)) {
          res.status(400).json({ error: 'Invalid blocker ID' });
          return;
        }

        // Fetch the blocker to get its projectId
        const blocker = await prisma.blocker.findUnique({
          where: { id: blockerId },
          select: { projectId: true }
        });

        if (!blocker) {
          res.status(404).json({ error: 'Blocker not found' });
          return;
        }

        // Fetch user's role in this specific project
        const member = await prisma.project_members.findUnique({
          where: {
            project_id_user_id: { project_id: blocker.projectId, user_id: userId }
          }
        });

        if (!member) {
          res.status(403).json({ error: 'Forbidden: You do not have access to this project\'s blockers' });
          return;
        }

        if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(member.role.toLowerCase())) {
          res.status(403).json({ error: `Forbidden: Project role '${member.role}' is not authorized for this action` });
          return;
        }

        // Store projectId and projectRole for downstream use if needed
        (req as any).projectId = blocker.projectId;
        (req as any).projectRole = member.role;

        next();
      } catch (error) {
        console.error('[Blocker Auth Middleware] Error:', error);
        res.status(500).json({ error: 'Internal Server Error during blocker authorization' });
        return;
      }
    });
  };
};
