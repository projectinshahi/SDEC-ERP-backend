import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';

/**
 * GET /api/blockers
 * Returns all blockers with related project, loggedBy, helpNeededFrom, resolvedBy
 */
export const getBlockers = async (req: Request, res: Response) => {
  try {
    const { 
      projectId,
      loggedBy, 
      assignedTo, 
      status, 
      escalation, 
      search, 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      page = '1',
      limit = '50'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.max(1, parseInt(limit as string, 10));
    const skip = (pageNum - 1) * limitNum;

    // Build the dynamic WHERE clause
    const whereClause: any = {};

    if (projectId) {
      whereClause.projectId = projectId;
    }

    if (loggedBy && loggedBy !== 'all') {
      whereClause.loggedById = parseInt(loggedBy as string, 10);
    }

    if (assignedTo && assignedTo !== 'all') {
      if (assignedTo === 'unassigned') {
        whereClause.helpNeededFromId = null;
      } else {
        whereClause.helpNeededFromId = parseInt(assignedTo as string, 10);
      }
    }

    if (status && status !== 'all') {
      // Support comma-separated statuses for multi-select
      const statuses = (status as string).split(',').map(s => s.trim());
      whereClause.status = { in: statuses };
    }

    if (escalation && escalation !== 'all') {
      const escalations = (escalation as string).split(',').map(e => e.trim());
      whereClause.escalationLevel = { in: escalations };
    }

    if (search) {
      whereClause.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    // Build the dynamic ORDER BY clause
    let orderByClause: any = {};
    if (sortBy === 'assignee') {
      orderByClause = { helpNeededFrom: { name: sortOrder } };
    } else {
      orderByClause[sortBy as string] = sortOrder;
    }

    const [blockers, total] = await Promise.all([
      prisma.blocker.findMany({
        where: whereClause,
        orderBy: orderByClause,
        skip,
        take: limitNum,
        include: {
          project: { select: { id: true, name: true } },
          loggedBy: { select: { id: true, name: true, email: true } },
          helpNeededFrom: { select: { id: true, name: true, email: true } },
          resolvedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.blocker.count({ where: whereClause })
    ]);

    return res.status(200).json({ 
      success: true, 
      data: blockers,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching blockers:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching blockers' });
  }
};

/**
 * GET /api/blockers/:id
 */
export const getBlockerById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid blocker ID' });
    }

    const blocker = await prisma.blocker.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        loggedBy: { select: { id: true, name: true, email: true } },
        helpNeededFrom: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!blocker) {
      return res.status(404).json({ success: false, message: 'Blocker not found' });
    }

    return res.status(200).json({ success: true, data: blocker });
  } catch (error) {
    console.error('Error fetching blocker:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching blocker' });
  }
};

/**
 * POST /api/blockers
 * Body: { title, description?, severity, status?, escalationLevel?, projectId, loggedById, helpNeededFromId?, notes? }
 */
export const createBlocker = async (req: Request, res: Response) => {
  try {
    const {
      title,
      description,
      severity,
      status,
      escalationLevel,
      projectId,
      loggedById,
      helpNeededFromId,
      notes,
      tags,
    } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    if (!projectId) {
      return res.status(400).json({ success: false, message: 'Project ID is required' });
    }
    if (!loggedById) {
      return res.status(400).json({ success: false, message: 'loggedById is required' });
    }

    const blocker = await prisma.blocker.create({
      data: {
        title,
        description: description || null,
        severity: severity || 'Medium',
        status: status || 'Open',
        escalationLevel: escalationLevel || 'none',
        projectId,
        loggedById: parseInt(loggedById),
        helpNeededFromId: helpNeededFromId ? parseInt(helpNeededFromId) : null,
        notes: notes || null,
        tags: tags || [],
      },
      include: {
        project: { select: { id: true, name: true } },
        loggedBy: { select: { id: true, name: true, email: true } },
        helpNeededFrom: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    await activityService.logActivity({
      actorUserId: parseInt(loggedById),
      projectId: projectId,
      type: 'blocker_created',
      description: `Logged a new Blocker: ${title}`
    });

    if (helpNeededFromId) {
      await activityService.logActivity({
        actorUserId: parseInt(loggedById),
        targetUserId: parseInt(helpNeededFromId),
        projectId: projectId,
        type: 'blocker_assigned',
        description: `Assigned blocker to ${blocker.helpNeededFrom?.name || 'user'}`
      });
      
      if (parseInt(loggedById) !== parseInt(helpNeededFromId)) {
        await notificationService.createNotification({
          userId: parseInt(helpNeededFromId),
          type: 'assignment',
          title: 'New Blocker Assigned',
          message: `${blocker.loggedBy.name} assigned you to blocker: "${title}"`,
          entityType: 'blocker',
          entityId: blocker.id
        });
      }
    }

    return res.status(201).json({ success: true, data: blocker });
  } catch (error) {
    console.error('Error creating blocker:', error);
    return res.status(500).json({ success: false, message: 'Server error creating blocker' });
  }
};

/**
 * PUT /api/blockers/:id
 */
export const updateBlocker = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid blocker ID' });
    }

    const {
      title,
      description,
      severity,
      status,
      escalationLevel,
      helpNeededFromId,
      resolvedById,
      resolvedAt,
      notes,
      tags,
    } = req.body;

    const existingBlocker = await prisma.blocker.findUnique({
      where: { id },
      include: { helpNeededFrom: true }
    });

    if (!existingBlocker) {
      return res.status(404).json({ success: false, message: 'Blocker not found' });
    }

    const blocker = await prisma.blocker.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(severity !== undefined && { severity }),
        ...(status !== undefined && { status }),
        ...(escalationLevel !== undefined && { escalationLevel }),
        ...(helpNeededFromId !== undefined && { helpNeededFromId: helpNeededFromId ? parseInt(helpNeededFromId) : null }),
        ...(resolvedById !== undefined && { resolvedById: resolvedById ? parseInt(resolvedById) : null }),
        ...(resolvedAt !== undefined && { resolvedAt: resolvedAt ? new Date(resolvedAt) : null }),
        ...(notes !== undefined && { notes }),
        ...(tags !== undefined && { tags }),
      },
      include: {
        project: { select: { id: true, name: true } },
        loggedBy: { select: { id: true, name: true, email: true } },
        helpNeededFrom: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    const userId = (req as any).userId;
    if (userId) {
      if (helpNeededFromId !== undefined) {
        const newAssigneeId = helpNeededFromId ? parseInt(helpNeededFromId) : null;
        if (existingBlocker.helpNeededFromId !== newAssigneeId) {
          if (newAssigneeId === null) {
            await activityService.logActivity({
              actorUserId: Number(userId),
              projectId: blocker.projectId,
              type: 'blocker_unassigned',
              description: `Removed assignee from Blocker: ${blocker.title}`
            });
          } else {
            await activityService.logActivity({
              actorUserId: Number(userId),
              targetUserId: newAssigneeId,
              projectId: blocker.projectId,
              type: 'blocker_assigned',
              description: `Assigned blocker to ${blocker.helpNeededFrom?.name || 'user'}`
            });
            
            if (Number(userId) !== newAssigneeId) {
              await notificationService.createNotification({
                userId: newAssigneeId,
                type: 'assignment',
                title: 'Blocker Reassigned',
                message: `You have been assigned to blocker: "${blocker.title}"`,
                entityType: 'blocker',
                entityId: blocker.id
              });
            }
            
            if (existingBlocker.helpNeededFromId && existingBlocker.helpNeededFromId !== Number(userId)) {
              await notificationService.createNotification({
                userId: existingBlocker.helpNeededFromId,
                type: 'reassignment',
                title: 'Blocker Reassigned',
                message: `Blocker "${blocker.title}" was reassigned from you to ${blocker.helpNeededFrom?.name || 'someone else'}`,
                entityType: 'blocker',
                entityId: blocker.id
              });
            }
          }
        }
      }

      // Check for status change
      if (status !== undefined && existingBlocker.status !== status) {
        const notifyUsers = new Set<number>();
        if (existingBlocker.loggedById !== Number(userId)) notifyUsers.add(existingBlocker.loggedById);
        if (blocker.helpNeededFromId && blocker.helpNeededFromId !== Number(userId)) notifyUsers.add(blocker.helpNeededFromId);
        
        await notificationService.createNotifications(Array.from(notifyUsers), {
          type: 'status_change',
          title: 'Blocker Status Changed',
          message: `Status of "${blocker.title}" changed from ${existingBlocker.status} to ${status}`,
          entityType: 'blocker',
          entityId: blocker.id
        });
      }

      // Check for escalation
      if (escalationLevel !== undefined && existingBlocker.escalationLevel !== escalationLevel) {
        const notifyUsers = new Set<number>();
        if (existingBlocker.loggedById !== Number(userId)) notifyUsers.add(existingBlocker.loggedById);
        if (blocker.helpNeededFromId && blocker.helpNeededFromId !== Number(userId)) notifyUsers.add(blocker.helpNeededFromId);
        
        await notificationService.createNotifications(Array.from(notifyUsers), {
          type: 'escalation',
          title: 'Blocker Escalation Level Changed',
          message: `Escalation of "${blocker.title}" changed to ${escalationLevel}`,
          entityType: 'blocker',
          entityId: blocker.id
        });
      }

      await activityService.logActivity({
        actorUserId: Number(userId),
        projectId: blocker.projectId,
        type: 'blocker_updated',
        description: `Updated Blocker: ${blocker.title}`
      });
    }

    return res.status(200).json({ success: true, data: blocker });
  } catch (error) {
    console.error('Error updating blocker:', error);
    return res.status(500).json({ success: false, message: 'Server error updating blocker' });
  }
};

/**
 * DELETE /api/blockers/:id
 */
export const deleteBlocker = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid blocker ID' });
    }

    await prisma.blocker.delete({ where: { id } });

    return res.status(200).json({ success: true, message: 'Blocker deleted successfully' });
  } catch (error) {
    console.error('Error deleting blocker:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting blocker' });
  }
};
