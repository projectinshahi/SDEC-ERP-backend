import { Request, Response } from 'express';
import prisma from '../../config/db.js';

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentMonth(): string {
  return new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

export const getHRDashboardStats = async (
  _req: Request,
  res: Response
) => {
  try {
    const today = getTodayDate();

    // Nine independent aggregates → ONE round of parallel queries (they were awaited one
    // after another, so the endpoint paid nine sequential DB round trips).
    const q = (sql: string, ...params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);
    const [
      totalEmployeesResult, presentResult, lateResult, leaveResult, joinersResult,
      payrollPendingResult, payrollPaidResult, payrollAmountResult, payrollMonthResult,
    ] = await Promise.all([
      // Total employees
      q(`SELECT COUNT(*) as count FROM employees;`),
      // Present today
      q(`SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status='present';`, today),
      // Late today
      q(`SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status='late';`, today),
      // Approved leave
      q(`SELECT COUNT(DISTINCT employee_id) as count FROM attendance
       WHERE date = $1::date AND status IN ('leave_full_day', 'leave_half_day');`, today),
      // New joiners this month
      q(`SELECT COUNT(*) as count FROM employees
      WHERE DATE_TRUNC('month', join_date) = DATE_TRUNC('month', CURRENT_DATE);`),
      // Payroll pending count
      q(`SELECT COUNT(*) as count FROM payroll WHERE LOWER(status) = 'pending';`),
      // Payroll paid count
      q(`SELECT COUNT(*) as count FROM payroll WHERE LOWER(status) = 'paid';`),
      // Payroll pending amount
      q(`SELECT COALESCE(SUM(net_salary), 0) as total FROM payroll WHERE LOWER(status) = 'pending';`),
      // Payroll this month totals
      q(`SELECT COALESCE(SUM(net_salary), 0) as total, COUNT(*) as count
      FROM payroll
      WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE);`),
    ]);
    const totalEmployees = Number(totalEmployeesResult[0]?.count || 0);
    const presentToday = Number(presentResult[0]?.count || 0);
    const lateToday = Number(lateResult[0]?.count || 0);
    const onLeave = Number(leaveResult[0]?.count || 0);
    const newJoiners = Number(joinersResult[0]?.count || 0);

    const openPositions = 0;
    const pendingInterviews = 0;

    const payrollPending = Number(payrollPendingResult[0]?.count || 0);
    const payrollPaid = Number(payrollPaidResult[0]?.count || 0);
    const payrollPendingAmount = Number(payrollAmountResult[0]?.total || 0);
    const payrollMonthTotal = Number(payrollMonthResult[0]?.total || 0);
    const payrollMonthCount = Number(payrollMonthResult[0]?.count || 0);

    // Attendance summary chart — clamp absent ≥ 0
    const absentRaw = totalEmployees - presentToday - lateToday - onLeave;
    const absent = absentRaw < 0 ? 0 : absentRaw;

    const attendanceSummary = [
      { name: 'Present', value: presentToday },
      { name: 'Late', value: lateToday },
      { name: 'Leave', value: onLeave },
      { name: 'Absent', value: absent },
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
          payrollPaid,
          payrollPendingAmount,
          payrollMonthTotal,
          payrollMonthCount,
          currentMonth: getCurrentMonth(),
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

/* ── Activity Feed ───────────────────────────────────────────────────────── */

/**
 * GET /api/hr/dashboard/activity
 * Returns the most recent 20 HR events across all key tables.
 */
export const getHRActivityFeed = async (
  _req: Request,
  res: Response
) => {
  try {
    const events = await prisma.$queryRawUnsafe<any[]>(`
      SELECT * FROM (
        -- New employees added
        SELECT
          e.id::text AS id,
          'hire' AS type,
          'HR Admin' AS actor,
          'New employee added: ' || u.name AS action,
          e.created_at AS timestamp
        FROM employees e
        LEFT JOIN users u ON e.user_id = u.id
        WHERE e.created_at IS NOT NULL

        UNION ALL

        -- Documents uploaded
        SELECT
          d.id::text AS id,
          'document' AS type,
          COALESCE(vu.name, 'HR Admin') AS actor,
          d.document_type || ' uploaded for ' || COALESCE(eu.name, 'employee') AS action,
          d.created_at AS timestamp
        FROM documents d
        LEFT JOIN employees e ON d.employee_id = e.id
        LEFT JOIN users eu ON e.user_id = eu.id
        LEFT JOIN users vu ON d.verified_by = vu.id
        WHERE d.created_at IS NOT NULL

        UNION ALL

        -- Payroll records created
        SELECT
          p.id::text AS id,
          'payroll' AS type,
          'HR Admin' AS actor,
          'Payroll generated for ' || COALESCE(u.name, 'employee') || ' (' || p.month || ')' AS action,
          p.created_at AS timestamp
        FROM payroll p
        LEFT JOIN employees e ON p.employee_id = e.id
        LEFT JOIN users u ON e.user_id = u.id
        WHERE p.created_at IS NOT NULL

        UNION ALL

        -- Appraisal status changes (any created_at)
        SELECT
          pa.id::text AS id,
          'performance' AS type,
          COALESCE(eu.name, 'Employee') AS actor,
          'Appraisal ' || pa.status || ': ' || COALESCE(eu.name, 'employee') AS action,
          pa.updated_at AS timestamp
        FROM performance_appraisals pa
        LEFT JOIN employees e ON pa.employee_id = e.id
        LEFT JOIN users eu ON e.user_id = eu.id
        WHERE pa.updated_at IS NOT NULL

        UNION ALL

        -- Recruitment candidates added / stage changes
        SELECT
          c.id::text AS id,
          'hire' AS type,
          'Recruiter' AS actor,
          'Candidate ' || c.full_name || ' — ' || c.stage AS action,
          c.created_at AS timestamp
        FROM candidates c
        WHERE c.created_at IS NOT NULL

      ) AS feed
      ORDER BY timestamp DESC
      LIMIT 20;
    `);

    // Serialize BigInt and convert timestamp to ISO string
    const serialized = events.map((e) => ({
      id: String(e.id),
      type: e.type,
      actor: e.actor,
      action: e.action,
      timestamp: e.timestamp instanceof Date
        ? e.timestamp.toISOString()
        : String(e.timestamp),
    }));

    return res.status(200).json({ success: true, data: serialized });
  } catch (error) {
    console.error('[HR Activity Feed] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch HR activity feed',
    });
  }
};

/* ── Alerts ─────────────────────────────────────────────────────────────── */

/**
 * GET /api/hr/dashboard/alerts
 * Computes and returns actionable HR alerts from real stats.
 */
export const getHRAlerts = async (
  _req: Request,
  res: Response
) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Ten independent counts → ONE round of parallel queries (previously ten sequential
    // DB round trips).
    const q = (sql: string, ...params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);
    const [
      mgrPendingResult, selfPendingResult, payrollPendingResult, docPendingResult, docRejectedResult,
      totalEmpResult, presentResult, lateResult, leaveResult, newCandidatesResult,
    ] = await Promise.all([
      // Manager reviews pending
      q(`SELECT COUNT(*) as count FROM performance_appraisals
      WHERE LOWER(status) = 'manager_review';`),
      // Self reviews pending
      q(`SELECT COUNT(*) as count FROM performance_appraisals
      WHERE LOWER(status) = 'self_review';`),
      // Payroll pending count
      q(`SELECT COUNT(*) as count FROM payroll WHERE LOWER(status) = 'pending';`),
      // Documents pending verification
      q(`SELECT COUNT(*) as count FROM documents WHERE LOWER(status) = 'pending';`),
      // Documents rejected
      q(`SELECT COUNT(*) as count FROM documents WHERE LOWER(status) = 'rejected';`),
      // High absenteeism today
      q(`SELECT COUNT(*) as count FROM employees;`),
      q(`SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status = 'present';`, today),
      q(`SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status = 'late';`, today),
      q(`SELECT COUNT(DISTINCT employee_id) as count FROM attendance
       WHERE date = $1::date AND status IN ('leave_full_day','leave_half_day');`, today),
      // New candidates in last 7 days
      q(`SELECT COUNT(*) as count FROM candidates
      WHERE created_at >= CURRENT_DATE - INTERVAL '7 days';`),
    ]);
    const mgrPending = Number(mgrPendingResult[0]?.count || 0);
    const selfPending = Number(selfPendingResult[0]?.count || 0);
    const payrollPending = Number(payrollPendingResult[0]?.count || 0);
    const docPending = Number(docPendingResult[0]?.count || 0);
    const docRejected = Number(docRejectedResult[0]?.count || 0);
    const totalEmployees = Number(totalEmpResult[0]?.count || 0);
    const presentToday = Number(presentResult[0]?.count || 0);
    const lateToday = Number(lateResult[0]?.count || 0);
    const onLeave = Number(leaveResult[0]?.count || 0);

    const absentCount = Math.max(0, totalEmployees - presentToday - lateToday - onLeave);
    const absentPct = totalEmployees > 0 ? Math.round((absentCount / totalEmployees) * 100) : 0;

    const newCandidates = Number(newCandidatesResult[0]?.count || 0);

    // Build alerts array
    const alerts: any[] = [];

    if (mgrPending > 0) {
      alerts.push({
        id: 'mgr-review',
        type: 'critical',
        title: 'Manager Reviews Pending',
        desc: `${mgrPending} appraisal${mgrPending !== 1 ? 's' : ''} awaiting manager scoring`,
        count: mgrPending,
        href: '/dashboard/hr/performance',
      });
    }

    if (docRejected > 0) {
      alerts.push({
        id: 'doc-rejected',
        type: 'critical',
        title: 'Documents Rejected',
        desc: `${docRejected} document${docRejected !== 1 ? 's were' : ' was'} rejected and need re-upload`,
        count: docRejected,
        href: '/dashboard/hr/documents',
      });
    }

    if (selfPending > 0) {
      alerts.push({
        id: 'self-review',
        type: 'warning',
        title: 'Self Reviews Pending',
        desc: `${selfPending} employee${selfPending !== 1 ? 's haven\'t' : ' hasn\'t'} submitted self-assessment`,
        count: selfPending,
        href: '/dashboard/hr/performance',
      });
    }

    if (docPending > 0) {
      alerts.push({
        id: 'doc-pending',
        type: 'warning',
        title: 'Documents Awaiting Verification',
        desc: `${docPending} document${docPending !== 1 ? 's require' : ' requires'} HR review`,
        count: docPending,
        href: '/dashboard/hr/documents',
      });
    }

    if (payrollPending > 0) {
      alerts.push({
        id: 'payroll-pending',
        type: 'info',
        title: 'Payroll Processing Pending',
        desc: `${payrollPending} employee payroll record${payrollPending !== 1 ? 's' : ''} not yet paid`,
        count: payrollPending,
        href: '/dashboard/hr/payroll',
      });
    }

    if (absentPct > 20 && totalEmployees > 0) {
      alerts.push({
        id: 'high-absence',
        type: 'warning',
        title: 'High Absenteeism Today',
        desc: `${absentCount} employees (${absentPct}%) have no attendance record today`,
        count: absentCount,
        href: '/dashboard/hr/attendance',
      });
    }

    if (newCandidates > 0) {
      alerts.push({
        id: 'new-candidates',
        type: 'info',
        title: 'New Candidates This Week',
        desc: `${newCandidates} new candidate${newCandidates !== 1 ? 's' : ''} applied in the last 7 days`,
        count: newCandidates,
        href: '/dashboard/hr/recruitment',
      });
    }

    return res.status(200).json({ success: true, data: alerts });
  } catch (error) {
    console.error('[HR Alerts] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch HR alerts',
    });
  }
};