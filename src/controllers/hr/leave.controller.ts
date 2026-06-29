import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/**
 * GET /api/hr/leaves
 */
export const getLeaves = async (_req: Request, res: Response) => {
  try {
    const leaves = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        l.*,
        e.employee_code,
        e.department,
        e.designation,
        u.name
      FROM leaves l
      JOIN employees e ON l.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      ORDER BY l.created_at DESC;
    `);

    res.status(200).json({
      success: true,
      data: leaves,
    });
  } catch (error) {
    console.error('[Leaves] Fetch Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leaves',
    });
  }
};

/**
 * POST /api/hr/leaves
 */
export const createLeave = async (req: Request, res: Response) => {
  try {
    const {
      employee_id,
      leave_type,
      start_date,
      end_date,
      reason,
    } = req.body;

    if (!employee_id || !leave_type || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Required fields missing',
      });
    }

    const start = new Date(start_date);
    const end = new Date(end_date);

    const diffTime = end.getTime() - start.getTime();
    const days = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO leaves (
        employee_id,
        leave_type,
        start_date,
        end_date,
        days,
        reason,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      employee_id,
      leave_type,
      start,
      end,
      days,
      reason || null,
      'pending'
    );

    res.status(201).json({
      success: true,
      message: 'Leave request created',
    });
  } catch (error) {
    console.error('[Leave Create] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create leave',
    });
  }
};

/**
 * PATCH /api/hr/leaves/:id/approve
 */
export const approveLeave = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.$executeRawUnsafe(
      `
      UPDATE leaves
      SET status='approved'
      WHERE id=$1
      `,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Leave approved',
    });
  } catch (error) {
    console.error('[Leave Approve] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve leave',
    });
  }
};

/**
 * PATCH /api/hr/leaves/:id/reject
 */
export const rejectLeave = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.$executeRawUnsafe(
      `
      UPDATE leaves
      SET status='rejected'
      WHERE id=$1
      `,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Leave rejected',
    });
  } catch (error) {
    console.error('[Leave Reject] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject leave',
    });
  }
};

/**
 * GET /api/hr/leaves/stats
 */
export const getLeaveStats = async (_req: Request, res: Response) => {
  try {
    const stats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT status, COUNT(*) as count
      FROM leaves
      GROUP BY status
    `);

    let pending = 0;
    let approved = 0;
    let rejected = 0;

    stats.forEach((item) => {
      if (item.status === 'pending') pending = Number(item.count);
      if (item.status === 'approved') approved = Number(item.count);
      if (item.status === 'rejected') rejected = Number(item.count);
    });

    res.status(200).json({
      success: true,
      data: {
        pending,
        approved,
        rejected,
      },
    });
  } catch (error) {
    console.error('[Leave Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave stats',
    });
  }
};