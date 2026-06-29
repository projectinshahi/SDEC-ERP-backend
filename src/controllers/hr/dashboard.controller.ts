import { Request, Response } from 'express';
import prisma from '../../config/db.js';

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

export const getHRDashboardStats = async (
  _req: Request,
  res: Response
) => {
  try {
    const today = getTodayDate();

    // Total employees
    const totalEmployeesResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as count
      FROM employees;
    `);

    const totalEmployees = Number(totalEmployeesResult[0]?.count || 0);

    // Present today
    const presentResult = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT COUNT(*) as count
      FROM attendance
      WHERE date = $1
      AND status='present';
      `,
      today
    );

    const presentToday = Number(presentResult[0]?.count || 0);

    // Late today
    const lateResult = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT COUNT(*) as count
      FROM attendance
      WHERE date = $1
      AND status='late';
      `,
      today
    );

    const lateToday = Number(lateResult[0]?.count || 0);

    // Approved leave
    const leaveResult = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT COUNT(DISTINCT employee_id) as count
      FROM attendance
      WHERE date = $1::date
      AND status IN ('leave_full_day', 'leave_half_day');
      `,
      today
    );

    const onLeave = Number(leaveResult[0]?.count || 0);

    // New joiners this month
    const joinersResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as count
      FROM employees
      WHERE DATE_TRUNC('month', join_date) = DATE_TRUNC('month', CURRENT_DATE);
    `);

    const newJoiners = Number(joinersResult[0]?.count || 0);

    // Recruitment stats (placeholder until recruitment table)
    const openPositions = 0;
    const pendingInterviews = 0;

    // Payroll pending
    const payrollPendingResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as count
      FROM payroll
      WHERE status='pending';
    `);

    const payrollPending = Number(
      payrollPendingResult[0]?.count || 0
    );

    // Payroll pending amount
    const payrollAmountResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COALESCE(SUM(net_salary),0) as total
      FROM payroll
      WHERE status='pending';
    `);

    const payrollPendingAmount = Number(
      payrollAmountResult[0]?.total || 0
    );

    // Attendance summary chart
    const absent = totalEmployees - presentToday - lateToday - onLeave;

    const attendanceSummary = [
      { name: 'Present', value: presentToday },
      { name: 'Late', value: lateToday },
      { name: 'Leave', value: onLeave },
      { name: 'Absent', value: absent < 0 ? 0 : absent },
    ];

    return res.status(200).json({
      success: true,
      data: {
        kpis: {
          totalEmployees,
          presentToday,
          onLeave,
          lateToday,
          newJoiners,
          openPositions,
          pendingInterviews,
          payrollPending,
          payrollPendingAmount,
        },
        attendanceSummary,
      },
    });
  } catch (error) {
    console.error('[HR Dashboard] Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch HR dashboard stats',
    });
  }
};