import { Request, Response } from 'express';
import prisma from '../config/db';

export const getSprints = async (req: Request, res: Response) => {
  try {
    const sprints = await prisma.sprints.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { tasks: true }
        }
      }
    });
    return res.status(200).json({ success: true, data: sprints });
  } catch (error) {
    console.error('Error fetching sprints:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching sprints' });
  }
};

export const getSprintById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!id || Array.isArray(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sprint ID',
      });
    }
    const sprint = await prisma.sprints.findUnique({
      where: { id },
      include: {
        tasks: true,
        members: {
          include: { user: true }
        }
      }
    });
    if (!sprint) {
      return res.status(404).json({ success: false, message: 'Sprint not found' });
    }
    return res.status(200).json({ success: true, data: sprint });
  } catch (error) {
    console.error('Error fetching sprint:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching sprint' });
  }
};

export const createSprint = async (req: Request, res: Response) => {
  try {
    const { id, name, goal, description, startDate, endDate, status, estimatedHours, capacity, projectId } = req.body;
    
    if (!name || !id) {
      return res.status(400).json({ success: false, message: 'ID and Name are required' });
    }

    const sprint = await prisma.sprints.create({
      data: {
        id,
        name,
        goal,
        description,
        startDate,
        endDate,
        status: status || 'Planned',
        estimatedHours: estimatedHours ? parseFloat(estimatedHours) : 0,
        capacity: capacity ? parseFloat(capacity) : 0,
        projectId: projectId || null,
      },
    });

    return res.status(201).json({ success: true, data: sprint });
  } catch (error) {
    console.error('Error creating sprint:', error);
    return res.status(500).json({ success: false, message: 'Server error creating sprint' });
  }
};

export const updateSprint = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!id || Array.isArray(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sprint ID',
      });
    }
    // Ensure we don't try to update id or relational fields directly without proper structures
    const updateData = { ...req.body };
    delete updateData.id;
    if (updateData.estimatedHours !== undefined) {
      updateData.estimatedHours = parseFloat(updateData.estimatedHours);
    }
    if (updateData.capacity !== undefined) {
      updateData.capacity = parseFloat(updateData.capacity);
    }
    const sprint = await prisma.sprints.update({
      where: { id },
      data: updateData,
    });
    return res.status(200).json({ success: true, data: sprint });
  } catch (error) {
    console.error('Error updating sprint:', error);
    return res.status(500).json({ success: false, message: 'Server error updating sprint' });
  }
};

export const deleteSprint = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!id || Array.isArray(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sprint ID',
      });
    }
    await prisma.sprints.delete({
      where: { id },
    });
    return res.status(200).json({ success: true, message: 'Sprint deleted successfully' });
  } catch (error) {
    console.error('Error deleting sprint:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting sprint' });
  }
};
