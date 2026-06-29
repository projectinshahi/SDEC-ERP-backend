import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/**
 * GET /api/hr/payroll
 * Fetch all payroll records with employee designation, code, and user name.
 */
export const getPayroll = async (_req: Request, res: Response) => {
  try {
    const payroll = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        p.*,
        e.employee_code,
        e.designation,
        u.name
      FROM payroll p
      JOIN employees e ON p.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      ORDER BY p.created_at DESC;
    `);

    res.status(200).json({
      success: true,
      data: payroll,
    });
  } catch (error) {
    console.error('[Payroll Fetch]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payroll records',
    });
  }
};

/**
 * POST /api/hr/payroll
 * Create a new payroll record with duplicate checks (same employee + same month).
 */
export const createPayroll = async (req: Request, res: Response) => {
  try {
    const { employee_id, basic_salary, bonus = 0, deduction = 0, month } = req.body;

    if (!employee_id || basic_salary == null || !month) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, basic_salary, and month are required',
      });
    }

    // 1. Duplicate check: same employee + same month
    const duplicate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE employee_id = $1 AND LOWER(month) = LOWER($2) LIMIT 1`,
      Number(employee_id),
      month.trim()
    );

    if (duplicate.length) {
      return res.status(400).json({
        success: false,
        message: `Payroll for this employee in ${month} has already been generated.`,
      });
    }

    const netSalary = Number(basic_salary) + Number(bonus) - Number(deduction);

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO payroll (
        employee_id,
        basic_salary,
        bonus,
        deduction,
        net_salary,
        month,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      Number(employee_id),
      Number(basic_salary),
      Number(bonus),
      Number(deduction),
      netSalary,
      month.trim(),
      'Pending'
    );

    res.status(201).json({
      success: true,
      message: 'Payroll record created successfully',
    });
  } catch (error) {
    console.error('[Payroll Create Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payroll record',
    });
  }
};

/**
 * PUT /api/hr/payroll/:id
 * Update an existing payroll record with duplicate checks.
 */
export const updatePayroll = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { employee_id, basic_salary, bonus = 0, deduction = 0, month, status } = req.body;

    if (!employee_id || basic_salary == null || !month || !status) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, basic_salary, month, and status are required',
      });
    }

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found',
      });
    }

    // Duplicate check: ensure we don't change to a month/employee combo that already exists on a different ID
    const duplicate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE employee_id = $1 AND LOWER(month) = LOWER($2) AND id <> $3 LIMIT 1`,
      Number(employee_id),
      month.trim(),
      Number(id)
    );

    if (duplicate.length) {
      return res.status(400).json({
        success: false,
        message: `Another payroll record for this employee in ${month} already exists.`,
      });
    }

    const netSalary = Number(basic_salary) + Number(bonus) - Number(deduction);

    await prisma.$executeRawUnsafe(
      `
      UPDATE payroll
      SET
        employee_id = $1,
        basic_salary = $2,
        bonus = $3,
        deduction = $4,
        net_salary = $5,
        month = $6,
        status = $7
      WHERE id = $8
      `,
      Number(employee_id),
      Number(basic_salary),
      Number(bonus),
      Number(deduction),
      netSalary,
      month.trim(),
      status,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Payroll record updated successfully',
    });
  } catch (error) {
    console.error('[Payroll Update Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payroll record',
    });
  }
};

/**
 * PATCH /api/hr/payroll/:id/status
 * Update payroll status (e.g. marking as paid).
 */
export const updatePayrollStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'status is required',
      });
    }

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found',
      });
    }

    await prisma.$executeRawUnsafe(
      `
      UPDATE payroll
      SET status = $1
      WHERE id = $2
      `,
      status,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Payroll status updated successfully',
    });
  } catch (error) {
    console.error('[Payroll Status Update Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payroll status',
    });
  }
};

/**
 * DELETE /api/hr/payroll/:id
 * Delete a payroll record.
 */
export const deletePayroll = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found',
      });
    }

    await prisma.$executeRawUnsafe(
      `DELETE FROM payroll WHERE id = $1`,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Payroll record deleted successfully',
    });
  } catch (error) {
    console.error('[Payroll Delete Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete payroll record',
    });
  }
};