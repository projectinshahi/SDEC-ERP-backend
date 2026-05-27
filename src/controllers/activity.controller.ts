import { Request, Response } from 'express';
import prisma from '../config/db.js';

export const getActivityFeed = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Find all projects where the user is a member
    const userProjects = await prisma.project_members.findMany({
      where: { user_id: userId },
      select: { project_id: true }
    });
    
    const projectIds = userProjects.map(p => p.project_id);

    // Fetch activities that are:
    // 1. Performed by the user (actor)
    // 2. Targeted to the user (target)
    // 3. Belong to a project the user is a member of
    const activities = await prisma.activity_logs.findMany({
      where: {
        OR: [
          { actor_user_id: userId },
          { target_user_id: userId },
          { project_id: { in: projectIds } }
        ]
      },
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
