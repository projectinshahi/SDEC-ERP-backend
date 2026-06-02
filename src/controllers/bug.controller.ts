import { Request, Response } from 'express';
import prisma from '../config/db.js';

export const getBugs = async (req: Request, res: Response) => {
  try {
    const {
      search,
      status,
      priority,
      severity,
      assignee,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    // ── Build WHERE clause ────────────────────────────────────────────────────
    const where: Record<string, any> = {};

    // Full-text search across title, description, assignedTo, reportedBy, and ID
    if (search) {
      const searchNum = parseInt(search, 10);
      where.OR = [
        { title:       { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { assignedTo:  { contains: search, mode: 'insensitive' } },
        { reportedBy:  { contains: search, mode: 'insensitive' } },
        ...(isNaN(searchNum) ? [] : [{ id: searchNum }]),
      ];
    }

    if (status)   where.status   = { equals: status,   mode: 'insensitive' };
    if (priority) where.priority = { equals: priority, mode: 'insensitive' };
    if (severity) where.severity = { equals: severity, mode: 'insensitive' };
    if (assignee) where.assignedTo = { contains: assignee, mode: 'insensitive' };

    // Date range on createdAt
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999); // include the full end day
        where.createdAt.lte = end;
      }
    }

    // ── Build ORDER BY ────────────────────────────────────────────────────────
    const validSortFields = ['createdAt', 'updatedAt', 'priority', 'status', 'title'];
    const orderField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const orderDir   = sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: Record<string, string> = { [orderField]: orderDir };

    // ── Pagination ────────────────────────────────────────────────────────────
    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    // ── Query ─────────────────────────────────────────────────────────────────
    const [bugs, total] = await Promise.all([
      prisma.bugs.findMany({ where, orderBy, skip, take: limitNum }),
      prisma.bugs.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: bugs,
      pagination: {
        total,
        page:       pageNum,
        limit:      limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
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
    const { title, description, status, priority, severity, assignedTo, reportedBy } = req.body;
    
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
