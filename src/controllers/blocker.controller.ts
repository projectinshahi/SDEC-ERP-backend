import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * GET /api/blockers
 * Returns all blockers with related project, loggedBy, helpNeededFrom, resolvedBy
 */
export const getBlockers = async (req: Request, res: Response) => {
  try {
    const blockers = await prisma.blocker.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        loggedBy: { select: { id: true, name: true, email: true } },
        helpNeededFrom: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } },
      },
    });
    return res.status(200).json({ success: true, data: blockers });
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
