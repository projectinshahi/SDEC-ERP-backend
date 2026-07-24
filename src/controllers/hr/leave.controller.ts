import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/** Reads the caller's role permission list (global admins implicitly allowed). */
async function getRolePermissions(req: Request): Promise<string[]> {
  const userRole = String((req as any).userRole || '');
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
  if (roles.length > 0 && roles[0].permissions) {
    const raw = roles[0].permissions;
    return Array.isArray(raw) ? raw : JSON.parse(raw);
  }
  return [];
}

/**
 * True when the caller may delete ANY employee's leave (HR-admin delete rights):
 * a global admin, or a role holding `hr.delete`. Anyone else who reached the
 * delete route did so via `hr.leave.self` and must be restricted to their own
 * records (do NOT rely on checkSelfService here — it returns false for roles
 * that also hold hr.view, which would otherwise bypass the ownership check).
 */
async function canDeleteAnyLeave(req: Request): Promise<boolean> {
  const userRole = String((req as any).userRole || '');
  const normalized = userRole.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'superadmin' || normalized === 'admin') return true;
  const permissions = await getRolePermissions(req);
  return permissions.includes('hr.delete');
}

/**
 * True when the caller may view/manage ALL employees' leave (the "View HR Admin
 * Leave" right): a global admin, or a role holding `hr.leave.view`. Everyone else
 * is a self-service staff user (reached the route via `hr.leave.self`) and is
 * scoped to their OWN records. Deliberately keyed on `hr.leave.view` — the Staff
 * and HR-Admin leave views are INDEPENDENT permissions, so this must NOT depend
 * on `hr.view` (that would couple the two and re-open the old scoping leak where
 * an employee holding hr.view saw everyone's leave).
 */
async function canManageAllLeave(req: Request): Promise<boolean> {
  const userRole = String((req as any).userRole || '');
  const normalized = userRole.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'superadmin' || normalized === 'admin') return true;
  const permissions = await getRolePermissions(req);
  return permissions.includes('hr.leave.view');
}

/**
 * GET /api/hr/leaves
 */
export const getLeaves = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const isAdmin = await canManageAllLeave(req);

    let leaves;
    if (!isAdmin) {
      // Self-service staff: only their OWN leave records.
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
      half_period,
    } = req.body;

    if (!leave_type || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Required fields missing',
      });
    }

    // half_period is the half-day SESSION (separate from the leave_type category).
    // Server-side validation — never trust the client: only these three values.
    const VALID_HALF_PERIODS = ['first_half', 'second_half'];
    let halfPeriod: string | null = null;
    if (half_period != null && half_period !== '') {
      if (!VALID_HALF_PERIODS.includes(half_period)) {
        return res.status(400).json({
          success: false,
          message: "half_period must be 'first_half', 'second_half' or null",
        });
      }
      halfPeriod = half_period;
    }

    const userId = (req as any).userId;
    const isAdmin = await canManageAllLeave(req);
    let resolvedEmployeeId = employee_id;

    console.log('[LEAVE CREATE] REQ BODY:', req.body);
    console.log('[LEAVE CREATE] REQ USER ID:', userId);
    console.log('[LEAVE CREATE] CAN MANAGE ALL LEAVE:', isAdmin);

    if (!isAdmin) {
      // Staff self-service: always file against their OWN employee record.
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
        status,
        half_period
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      resolvedEmployeeId,
      leave_type,
      start,
      end,
      days,
      reason || null,
      'pending',
      halfPeriod
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
    const isAdmin = await canManageAllLeave(req);
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: HR Admin Leave permission required to approve leave requests',
      });
    }

    const leaveId = Number(id);

    // Approval is the integrity gate: pending requests may freely coexist, but an
    // employee must not end up with two APPROVED leaves whose date ranges overlap
    // (that made the derived-attendance overlay ambiguous). Block the approval if
    // another approved leave for the same employee overlaps this request's range.
    const current = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, employee_id, start_date, end_date FROM leaves WHERE id = $1 LIMIT 1;',
      leaveId
    );
    if (current.length === 0) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }
    const { employee_id, start_date, end_date } = current[0];

    const overlaps = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM leaves
        WHERE employee_id = $1
          AND status = 'approved'
          AND id <> $2
          AND start_date::date <= $3::date
          AND end_date::date   >= $4::date
        LIMIT 1;`,
      employee_id,
      leaveId,
      end_date,
      start_date
    );
    if (overlaps.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'This employee already has an approved leave overlapping the selected date range.',
      });
    }

    await prisma.$executeRawUnsafe(
      `
      UPDATE leaves
      SET status='approved'
      WHERE id=$1
      `,
      leaveId
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
    const isAdmin = await canManageAllLeave(req);
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: HR Admin Leave permission required to reject leave requests',
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
 * DELETE /api/hr/leaves/:id
 *
 * Permanently removes a leave request. HR Admins (hr.delete) may delete any
 * request; self-service staff (hr.leave.self) may delete ONLY their own. The UI
 * surfaces this for Approved/Rejected requests (and the staff Cancel action on
 * their own Pending requests); the endpoint is status-agnostic so both flows work.
 */
export const deleteLeave = async (req: Request, res: Response) => {
  try {
    const leaveId = Number(req.params.id);
    if (isNaN(leaveId)) {
      return res.status(400).json({ success: false, message: 'Invalid leave id' });
    }

    // Verify the request exists (and grab employee_id for the ownership check).
    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, employee_id, status FROM leaves WHERE id = $1 LIMIT 1;',
      leaveId
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }
    const leave = rows[0];

    // Anyone without HR-admin delete rights (i.e. reached here via hr.leave.self)
    // may delete ONLY their own leave requests.
    const isAdminDeleter = await canDeleteAnyLeave(req);
    if (!isAdminDeleter) {
      const userId = (req as any).userId;
      const employees = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM employees WHERE user_id = $1 LIMIT 1;',
        userId
      );
      const ownEmployeeId = employees[0]?.id;
      if (!ownEmployeeId || Number(leave.employee_id) !== Number(ownEmployeeId)) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: you can only delete your own leave requests',
        });
      }
    }

    await prisma.$executeRawUnsafe('DELETE FROM leaves WHERE id = $1;', leaveId);

    res.status(200).json({ success: true, message: 'Leave request deleted' });
  } catch (error) {
    console.error('[Leave Delete] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete leave' });
  }
};

/**
 * GET /api/hr/leaves/stats
 */
export const getLeaveStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const isAdmin = await canManageAllLeave(req);

    let statsRaw;
    if (!isAdmin) {
      // Self-service staff: stats over their OWN records only.
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