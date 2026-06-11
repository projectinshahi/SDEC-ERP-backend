import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { io } from '../socket.js';

export const getBugs = async (req: Request, res: Response) => {
  try {
    const bugs = await prisma.bugs.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json({ success: true, data: bugs });
  } catch (error) {
    console.error('Error fetching bugs:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching bugs' });
  }
};

export const getBugById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid bug ID' });
    }

    const bug = await prisma.bugs.findUnique({
      where: { id },
    });

    if (!bug) {
      return res.status(404).json({ success: false, message: 'Bug not found' });
    }

    return res.status(200).json({ success: true, data: bug });
  } catch (error) {
    console.error('Error fetching bug:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching bug' });
  }
};

export const createBug = async (req: Request, res: Response) => {
  try {
    const { title, description, status, priority, severity, assignedTo, reportedBy, project_id } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const bug = await prisma.bugs.create({
      data: {
        title,
        description,
        status: status || 'open',
        priority: priority || 'medium',
        severity: severity || null,
        assignedTo: assignedTo || null,
        reportedBy: reportedBy || null,
        project_id: project_id || null,
      },
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: project_id || undefined,
        type: 'bug_created',
        description: `Logged a new Bug: ${title}`
      });
    }

    if (bug.project_id) {
      io.to(`project_${bug.project_id}`).emit('project_analytics_updated');
    }

    return res.status(201).json({ success: true, data: bug });
  } catch (error) {
    console.error('Error creating bug:', error);
    return res.status(500).json({ success: false, message: 'Server error creating bug' });
  }
};

export const updateBug = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid bug ID' });
    }

    const bug = await prisma.bugs.update({
      where: { id },
      data: req.body,
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: bug.project_id || undefined,
        type: 'bug_updated',
        description: `Updated Bug: ${bug.title}`
      });
    }

    if (bug.project_id) {
      io.to(`project_${bug.project_id}`).emit('project_analytics_updated');
    }

    return res.status(200).json({ success: true, data: bug });
  } catch (error) {
    console.error('Error updating bug:', error);
    return res.status(500).json({ success: false, message: 'Server error updating bug' });
  }
};

export const deleteBug = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid bug ID' });
    }

    const existingBug = await prisma.bugs.findUnique({ where: { id } });

    await prisma.bugs.delete({
      where: { id },
    });

    const userId = Number((req as any).userId);
    if (userId && existingBug) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: existingBug.project_id || undefined,
        type: 'bug_deleted',
        description: `Deleted Bug: ${existingBug.title}`
      });
    }

    if (existingBug?.project_id) {
      io.to(`project_${existingBug.project_id}`).emit('project_analytics_updated');
    }

    return res.status(200).json({ success: true, message: 'Bug deleted successfully' });
  } catch (error) {
    console.error('Error deleting bug:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting bug' });
  }
};

export const getBugAnalytics = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();
    const projectIdFilter = req.query.projectId as string | undefined;

    let projectIds: string[] = [];

    // If not super admin, fetch user's projects
    if (userRole !== 'super admin') {
      const userProjects = await prisma.project_members.findMany({
        where: { user_id: userId },
        select: { project_id: true }
      });
      projectIds = userProjects.map(p => p.project_id);

      if (projectIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            totalBugs: 0,
            openBugs: 0,
            inProgressBugs: 0,
            closedBugs: 0,
            reopenedBugs: 0,
            severityDistribution: [],
            priorityDistribution: [],
            statusDistribution: [],
            projectDistribution: [],
            assigneeAnalytics: [],
            resolutionTimeAvgDays: 0,
            trendAnalytics: [],
            reopenRate: 0
          }
        });
      }
    }

    // Build Where clause
    const whereClause: any = {};
    if (userRole !== 'super admin') {
      whereClause.project_id = { in: projectIds };
    }
    
    if (projectIdFilter) {
      if (userRole !== 'super admin') {
        if (!projectIds.includes(projectIdFilter)) {
          return res.status(403).json({ success: false, message: 'Forbidden: No access to this project' });
        }
      }
      whereClause.project_id = projectIdFilter;
    }

    // Fetch bugs
    const bugs = await prisma.bugs.findMany({
      where: whereClause,
      include: {
        project: { select: { name: true } }
      }
    });

    const totalBugs = bugs.length;
    let openBugs = 0;
    let inProgressBugs = 0;
    let closedBugs = 0;
    let reopenedBugs = 0;
    
    const severityMap: Record<string, number> = {};
    const priorityMap: Record<string, number> = {};
    const statusMap: Record<string, number> = {};
    const projectMap: Record<string, number> = {};
    const assigneeMap: Record<string, number> = {};

    let totalResolutionTimeMs = 0;
    let resolvedCountForTime = 0;

    bugs.forEach(bug => {
      const status = bug.status.toLowerCase();
      if (status === 'open' || status === 'new') openBugs++;
      else if (status === 'in_progress') inProgressBugs++;
      else if (status === 'resolved' || status === 'closed') {
        closedBugs++;
        if (bug.createdAt && bug.updatedAt) {
          totalResolutionTimeMs += (bug.updatedAt.getTime() - bug.createdAt.getTime());
          resolvedCountForTime++;
        }
      }
      else if (status === 'reopened') reopenedBugs++;

      // Distributions
      const sev = bug.severity ? bug.severity.toLowerCase() : 'none';
      severityMap[sev] = (severityMap[sev] || 0) + 1;

      const prio = bug.priority ? bug.priority.toLowerCase() : 'none';
      priorityMap[prio] = (priorityMap[prio] || 0) + 1;

      statusMap[status] = (statusMap[status] || 0) + 1;

      const projName = bug.project?.name || 'Unknown Project';
      projectMap[projName] = (projectMap[projName] || 0) + 1;

      const assignee = bug.assignedTo || 'Unassigned';
      assigneeMap[assignee] = (assigneeMap[assignee] || 0) + 1;
    });

    const severityDistribution = Object.keys(severityMap).map(k => ({ name: k, value: severityMap[k] }));
    const priorityDistribution = Object.keys(priorityMap).map(k => ({ name: k, value: priorityMap[k] }));
    const statusDistribution = Object.keys(statusMap).map(k => ({ name: k, value: statusMap[k] }));
    const projectDistribution = Object.keys(projectMap).map(k => ({ name: k, value: projectMap[k] }));
    
    const assigneeAnalytics = Object.keys(assigneeMap)
      .map(k => ({ name: k, count: assigneeMap[k] }))
      .sort((a, b) => b.count - a.count);

    const resolutionTimeAvgDays = resolvedCountForTime > 0 
      ? (totalResolutionTimeMs / resolvedCountForTime) / (1000 * 60 * 60 * 24) 
      : 0;

    const reopenRate = closedBugs > 0 ? (reopenedBugs / closedBugs) * 100 : 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trendMap: Record<string, { created: number, resolved: number }> = {};
    
    bugs.forEach(bug => {
      if (bug.createdAt && bug.createdAt >= thirtyDaysAgo) {
        const dateStr = bug.createdAt.toISOString().split('T')[0];
        if (!trendMap[dateStr]) trendMap[dateStr] = { created: 0, resolved: 0 };
        trendMap[dateStr].created++;
      }
      
      const status = bug.status.toLowerCase();
      if ((status === 'resolved' || status === 'closed') && bug.updatedAt && bug.updatedAt >= thirtyDaysAgo) {
        const dateStr = bug.updatedAt.toISOString().split('T')[0];
        if (!trendMap[dateStr]) trendMap[dateStr] = { created: 0, resolved: 0 };
        trendMap[dateStr].resolved++;
      }
    });

    const trendAnalytics = Object.keys(trendMap).sort().map(date => ({
      date,
      created: trendMap[date].created,
      resolved: trendMap[date].resolved
    }));

    return res.status(200).json({
      success: true,
      data: {
        totalBugs,
        openBugs,
        inProgressBugs,
        closedBugs,
        reopenedBugs,
        severityDistribution,
        priorityDistribution,
        statusDistribution,
        projectDistribution,
        assigneeAnalytics,
        resolutionTimeAvgDays: parseFloat(resolutionTimeAvgDays.toFixed(2)),
        trendAnalytics,
        reopenRate: parseFloat(reopenRate.toFixed(2))
      }
    });

  } catch (error) {
    console.error('Error fetching bug analytics:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching bug analytics' });
  }
};
