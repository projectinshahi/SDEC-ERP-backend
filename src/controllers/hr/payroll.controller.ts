import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/**
 * GET /api/hr/payroll
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
      message: 'Failed to fetch payroll',
    });
  }
};

/**
 * POST /api/hr/payroll/generate
 */
export const generatePayroll = async (req: Request, res: Response) => {
  try {
    const { employee_id, bonus = 0, deduction = 0, month } = req.body;

    if (!employee_id || !month) {
      return res.status(400).json({
        success: false,
        message: 'employee_id and month required',
      });
    }

    const employee = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT salary
      FROM employees
      WHERE id=$1
      LIMIT 1
      `,
      employee_id
    );

    if (!employee.length) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
      });
    }

    const basicSalary = Number(employee[0].salary || 0);
    const netSalary = basicSalary + Number(bonus) - Number(deduction);

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
      employee_id,
      basicSalary,
      Number(bonus),
      Number(deduction),
      netSalary,
      month,
      'pending'
    );

    res.status(201).json({
      success: true,
      message: 'Payroll generated',
    });
  } catch (error) {
    console.error('[Generate Payroll]', error);

    res.status(500).json({
      success: false,
      message: 'Payroll generation failed',
    });
  }
};

/**
 * POST /api/hr/payroll/process
 */
export const processPayroll = async (req: Request, res: Response) => {
  try {
    const { payroll_id } = req.body;

    if (!payroll_id) {
      return res.status(400).json({
        success: false,
        message: 'payroll_id required',
      });
    }

    await prisma.$executeRawUnsafe(
      `
      UPDATE payroll
      SET status='processed'
      WHERE id=$1
      `,
      payroll_id
    );

    res.status(200).json({
      success: true,
      message: 'Payroll processed successfully',
    });
  } catch (error) {
    console.error('[Process Payroll]', error);

    res.status(500).json({
      success: false,
      message: 'Payroll processing failed',
    });
  }
};