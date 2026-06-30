import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';

export const getActivityFeed = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Global admins (Founder / Super Admin) get the org-wide recent activity
    // feed (unrestricted read). Everyone else is scoped to activity they acted
    // on / were targeted by / belongs to a project they're a member of — so a
    // Founder, who is a member of no projects, still sees a populated feed.
    let where: any;
    if (isGlobalAdmin((req as any).userRole)) {
      where = {};
    } else {
      const userProjects = await prisma.project_members.findMany({
        where: { user_id: userId },
        select: { project_id: true },
      });
      const projectIds = userProjects.map((p: any) => p.project_id);
      where = {
        OR: [
          { actor_user_id: userId },
          { target_user_id: userId },
          { project_id: { in: projectIds } },
        ],
      };
    }

    const activities = await prisma.activity_logs.findMany({
      where,
      include: {
        actor: {
          select: { id: true, name: true, role: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 20
    });

    res.status(200).json(activities);
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res.status(500).json({ error: 'Failed to fetch activity feed' });
  }
};

export const clearActivityFeed = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // We only clear activities where the user is the target or actor, 
    // or those that are strictly project activities the user could see.
    // However, project activities are shared. 
    // Usually, "clearing" a feed means we just hide it for the user, but since we don't have a user-specific "read/hidden" state table,
    // deleting them might delete them for everyone if it's a project activity.
    // Instead of full deletion of shared logs, we can just delete logs specifically targeted to them or where they are the actor.
    // Or we delete all logs where they are the actor or target. 
    await prisma.activity_logs.deleteMany({
      where: {
        OR: [
          { actor_user_id: userId },
          { target_user_id: userId }
        ]
      }
    });

    res.status(200).json({ success: true, message: 'Activity feed cleared' });
  } catch (error) {
    console.error('Error clearing activity feed:', error);
    res.status(500).json({ error: 'Failed to clear activity feed' });
  }
};
