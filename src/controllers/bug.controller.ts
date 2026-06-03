import { Request, Response } from 'express';
import prisma from '../config/db.js';

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

    await prisma.bugs.delete({
      where: { id },
    });

    return res.status(200).json({ success: true, message: 'Bug deleted successfully' });
  } catch (error) {
    console.error('Error deleting bug:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting bug' });
  }
};
