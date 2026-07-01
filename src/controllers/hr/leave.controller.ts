import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/** Helper to check if user has only hr.leave.self and not full hr access */
async function checkSelfService(req: Request): Promise<boolean> {
  const userRole = String((req as any).userRole || '');
  
  // Super Admin bypass
  const normalizedRole = userRole.toLowerCase().replace(/[\s_-]/g, '');
  if (normalizedRole === 'superadmin' || normalizedRole === 'admin') {
    return false;
  }

  let roles = await prisma.$queryRawUnsafe<any[]>(
    'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
    userRole
  );
  if (roles.length === 0) {
    roles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
      userRole
    );
  }
  let permissions: string[] = [];
  if (roles.length > 0 && roles[0].permissions) {
    const raw = roles[0].permissions;
    permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
  }

  const hasLeaveSelf = permissions.includes('hr.leave.self');
  const hasFullHr = permissions.includes('hr.view') || permissions.includes('hr.leave.view');
  return hasLeaveSelf && !hasFullHr;
}

/**
 * GET /api/hr/leaves
 */
export const getLeaves = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const isSelf = await checkSelfService(req);

    let leaves;
    if (isSelf) {
      const employees = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM employees WHERE user_id = $1 LIMIT 1;',
        userId
      );
      if (employees.length === 0) {
        return res.status(200).json({ success: true, data: [] });
      }
      const employeeId = employees[0].id;
      leaves = await prisma.$queryRawUnsafe<any[]>(`
        SELECT
          l.*,
          e.employee_code,
          e.department,
          e.designation,
          u.name
        FROM leaves l
        JOIN employees e ON l.employee_id = e.id
        LEFT JOIN users u ON e.user_id = u.id
        WHERE l.employee_id = $1
        ORDER BY l.created_at DESC;
      `, employeeId);
    } else {
      leaves = await prisma.$queryRawUnsafe<any[]>(`
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
    }

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

    if (!leave_type || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Required fields missing',
      });
    }

    const userId = (req as any).userId;
    const isSelf = await checkSelfService(req);
    let resolvedEmployeeId = employee_id;

    console.log('[LEAVE CREATE] REQ BODY:', req.body);
    console.log('[LEAVE CREATE] REQ USER ID:', userId);
    console.log('[LEAVE CREATE] IS SELF SERVICE:', isSelf);

    if (isSelf) {
      console.log('[LEAVE CREATE] EMPLOYEE LOOKUP START');
      const employees = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM employees WHERE user_id = $1 LIMIT 1;',
        userId
      );
      if (employees.length === 0) {
        console.warn('[LEAVE CREATE] Employee lookup empty for user_id:', userId);
        return res.status(400).json({
          success: false,
          message: 'Employee record not found for the logged-in user',
        });
      }
      resolvedEmployeeId = employees[0].id;
      console.log('[LEAVE CREATE] Resolved Employee ID:', resolvedEmployeeId);
    } else if (employee_id === undefined || employee_id === null) {
      return res.status(400).json({
        success: false,
        message: 'employee_id is required',
      });
    }

    const start = new Date(start_date);
    const end = new Date(end_date);

    const diffTime = end.getTime() - start.getTime();
    const days = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;

    console.log('[LEAVE CREATE] INSERT LEAVE START — employee_id:', resolvedEmployeeId, '| days:', days);

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
      resolvedEmployeeId,
      leave_type,
      start,
      end,
      days,
      reason || null,
      'pending'
    );

    console.log('[LEAVE CREATE] INSERT SUCCESS');

    res.status(201).json({
      success: true,
      message: 'Leave request created',
    });
  } catch (error: any) {
    console.error('CREATE LEAVE ERROR:', error);
    console.error('STACK:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to create leave',
      error: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    });
  }
};

/**
 * PATCH /api/hr/leaves/:id/approve
 */
export const approveLeave = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isSelf = await checkSelfService(req);
    if (isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Self-service employees cannot approve leave requests',
      });
    }

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
    const isSelf = await checkSelfService(req);
    if (isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Self-service employees cannot reject leave requests',
      });
    }

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
export const getLeaveStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const isSelf = await checkSelfService(req);

    let statsRaw;
    if (isSelf) {
      const employees = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM employees WHERE user_id = $1 LIMIT 1;',
        userId
      );
      if (employees.length === 0) {
        return res.status(200).json({
          success: true,
          data: { pending: 0, approved: 0, rejected: 0 },
        });
      }
      const employeeId = employees[0].id;
      statsRaw = await prisma.$queryRawUnsafe<any[]>(`
        SELECT status, COUNT(*) as count
        FROM leaves
        WHERE employee_id = $1
        GROUP BY status
      `, employeeId);
    } else {
      statsRaw = await prisma.$queryRawUnsafe<any[]>(`
        SELECT status, COUNT(*) as count
        FROM leaves
        GROUP BY status
      `);
    }

    let pending = 0;
    let approved = 0;
    let rejected = 0;

    statsRaw.forEach((item) => {
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