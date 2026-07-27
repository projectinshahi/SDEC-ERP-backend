import { Request, Response } from 'express';
import prisma from '../../config/db.js';
import { computePayroll, splitSalary } from '../../services/payroll.service.js';
import { getPayrollDayBreakdown, type PayrollDayBreakdown } from '../../services/attendanceAnalytics.service.js';

/**
 * Payroll Controller — THIN. It orchestrates only; it holds no salary formulas.
 *   parse month → attendance day aggregation → computePayroll → save snapshot.
 * All math lives in payroll.service (money) and attendanceAnalytics (worked days).
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Parse a stored month label ("June 2026" or "2026-06") → { year, monthIndex }. */
function parseMonthYear(month: string): { year: number; monthIndex: number } | null {
  const m = String(month || '').trim().toLowerCase();
  let match = m.match(/^(\d{4})-(\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    return monthIndex >= 0 && monthIndex <= 11 ? { year, monthIndex } : null;
  }
  match = m.match(/^([a-z]+)\s+(\d{4})$/);
  if (match) {
    let monthIndex = MONTHS.indexOf(match[1]);
    if (monthIndex < 0) monthIndex = MONTHS.findIndex((x) => x.startsWith(match![1]));
    if (monthIndex >= 0) return { year: Number(match[2]), monthIndex };
  }
  return null;
}

/** Company holidays (mandatory only) in [from,to] as an ISO set → excluded from Office Working Days. */
async function loadHolidaySet(from: string, to: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT holiday_date::text AS d
       FROM company_holidays
      WHERE is_optional = false AND holiday_date BETWEEN $1::date AND $2::date;`,
    from,
    to,
  );
  return new Set(rows.map((r) => String(r.d).slice(0, 10)));
}

interface ResolvedDays {
  year: number;
  monthIndex: number;
  days: PayrollDayBreakdown;
  totalSalary: number;
  split: { basicSalary: number; dearnessAllowance: number };
}

/** Shared setup for generate + preview: month parse, employee, holidays, day aggregation, 75/25 split. */
async function resolveDays(
  employeeId: number,
  month: string,
): Promise<{ ok: true; data: ResolvedDays } | { ok: false; status: number; message: string }> {
  const parsed = parseMonthYear(month);
  if (!parsed) {
    return { ok: false, status: 400, message: "Invalid month format; expected e.g. 'June 2026'." };
  }
  const { year, monthIndex } = parsed;

  const emp = await prisma.$queryRawUnsafe<any[]>(
    `SELECT salary FROM employees WHERE id = $1 LIMIT 1`,
    employeeId,
  );
  if (!emp.length) return { ok: false, status: 404, message: 'Employee not found' };

  const calendarDays = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const mm = String(monthIndex + 1).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-${String(calendarDays).padStart(2, '0')}`;

  const holidays = await loadHolidaySet(from, to);
  const days = await getPayrollDayBreakdown(employeeId, year, monthIndex, holidays);
  const totalSalary = Number(emp[0].salary) || 0;
  const split = splitSalary(totalSalary);

  return { ok: true, data: { year, monthIndex, days, totalSalary, split } };
}

/** The day snapshot (immutable after CREATE) that money math is computed against. */
interface SnapshotDays {
  calendarDays: number;
  officeWorkingDays: number;
  workedDays: number;
  lop: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
}

/**
 * PURE money assembly — runs computePayroll and returns the ordered column→value
 * snapshot. Day values are passed IN (from attendance on CREATE, from the stored
 * row on EDIT); this function never reads attendance or holidays. Key order
 * defines the SQL column/param order so INSERT and UPDATE can never drift.
 */
function assembleSnapshot(p: {
  employeeId: number;
  month: string;
  basicSalary: number;
  dearnessAllowance: number;
  fine: number;
  specialAllowance: number;
  providentFund: number;
  bonus: number;
  incentive: number;
  arrears: number;
  days: SnapshotDays;
}): Record<string, any> {
  const r = computePayroll({
    basicSalary: p.basicSalary,
    dearnessAllowance: p.dearnessAllowance,
    officeWorkingDays: p.days.officeWorkingDays,
    employeeWorkedDays: p.days.workedDays,
    fine: p.fine,
    specialAllowance: p.specialAllowance,
    providentFund: p.providentFund,
    bonus: p.bonus,
    incentive: p.incentive,
    arrears: p.arrears,
  });
  return {
    employee_id: p.employeeId,
    basic_salary: p.basicSalary,
    da: p.dearnessAllowance,
    bonus: p.bonus,
    fine: p.fine,
    special_allowance: p.specialAllowance,
    pf: p.providentFund,
    incentive: p.incentive,
    arrears: p.arrears,
    calendar_days: p.days.calendarDays,
    office_working_days: p.days.officeWorkingDays,
    worked_days: p.days.workedDays,
    lop: p.days.lop,
    paid_leave_days: p.days.paidLeaveDays,
    unpaid_leave_days: p.days.unpaidLeaveDays,
    payable_basic: r.payableBasicSalary,
    payable_da: r.payableDearnessAllowance,
    gross: r.grossSalary,
    esi: r.employeeStateInsurance,
    total_deductions: r.totalDeductions,
    deduction: r.totalDeductions, // legacy column mirrors Total Deductions (backward compat)
    net_salary: r.netSalary,
    month: p.month,
  };
}

/**
 * CREATE-ONLY snapshot builder. Reads Attendance + Company Holidays to derive the
 * day snapshot ONCE, then freezes it. Earnings default to the config 75/25 split;
 * manual adjustments default to 0. EDIT must NEVER call this (it reuses the row).
 */
async function buildPayrollSnapshot(
  body: any,
): Promise<{ ok: true; snap: Record<string, any> } | { ok: false; status: number; message: string }> {
  const employeeId = Number(body.employee_id);
  const month = String(body.month).trim();

  const resolved = await resolveDays(employeeId, month);
  if (!resolved.ok) return resolved;
  const { days, split } = resolved.data;

  const num = (v: any, fallback = 0) => (v == null || v === '' ? fallback : Number(v) || 0);

  const snap = assembleSnapshot({
    employeeId,
    month,
    basicSalary: body.basic_salary != null ? Number(body.basic_salary) : split.basicSalary,
    dearnessAllowance: body.da != null ? Number(body.da) : split.dearnessAllowance,
    fine: num(body.fine),
    specialAllowance: num(body.special_allowance),
    providentFund: num(body.pf),
    bonus: num(body.bonus),
    incentive: num(body.incentive),
    arrears: num(body.arrears),
    days: {
      calendarDays: days.calendarDays,
      officeWorkingDays: days.officeWorkingDays,
      workedDays: days.workedDays,
      lop: days.lossOfPay,
      paidLeaveDays: days.paidLeaveDays,
      unpaidLeaveDays: days.unpaidLeaveDays,
    },
  });
  return { ok: true, snap };
}

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
 * GET /api/hr/payroll/attendance-preview?employee_id=&month=
 * Read-only: the day snapshot (Calendar/Office Working/Worked/LOP) + the suggested
 * 75/25 salary split for a given employee + month. Powers the generate form.
 */
export const getPayrollAttendancePreview = async (req: Request, res: Response) => {
  try {
    const employeeId = Number(req.query.employee_id);
    const month = String(req.query.month ?? '');
    if (!employeeId || !month) {
      return res.status(400).json({ success: false, message: 'employee_id and month are required' });
    }

    const resolved = await resolveDays(employeeId, month);
    if (!resolved.ok) return res.status(resolved.status).json({ success: false, message: resolved.message });
    const { days, totalSalary, split } = resolved.data;

    res.status(200).json({
      success: true,
      data: {
        calendarDays: days.calendarDays,
        officeWorkingDays: days.officeWorkingDays,
        employeeWorkedDays: days.workedDays,
        lossOfPay: days.lossOfPay,
        presentDays: days.presentDays,
        approvedLeaveDays: days.approvedLeaveDays,
        paidLeaveDays: days.paidLeaveDays,
        unpaidLeaveDays: days.unpaidLeaveDays,
        totalSalary,
        suggestedBasicSalary: split.basicSalary,
        suggestedDearnessAllowance: split.dearnessAllowance,
      },
    });
  } catch (error) {
    console.error('[Payroll Attendance Preview]', error);
    res.status(500).json({ success: false, message: 'Failed to load payroll attendance preview' });
  }
};

/**
 * POST /api/hr/payroll
 * Create a payroll record. Snapshots every calculated value (see buildPayrollSnapshot).
 */
export const createPayroll = async (req: Request, res: Response) => {
  try {
    const { employee_id, basic_salary, month } = req.body;

    if (!employee_id || basic_salary == null || !month) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, basic_salary, and month are required',
      });
    }

    // Duplicate check: same employee + same month
    const duplicate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE employee_id = $1 AND LOWER(month) = LOWER($2) LIMIT 1`,
      Number(employee_id),
      String(month).trim(),
    );
    if (duplicate.length) {
      return res.status(400).json({
        success: false,
        message: `Payroll for this employee in ${month} has already been generated.`,
      });
    }

    const built = await buildPayrollSnapshot(req.body);
    if (!built.ok) return res.status(built.status).json({ success: false, message: built.message });

    const snap = { ...built.snap, status: 'Pending' };
    const cols = Object.keys(snap);
    const vals = Object.values(snap);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    await prisma.$executeRawUnsafe(
      `INSERT INTO payroll (${cols.join(', ')}) VALUES (${placeholders})`,
      ...vals,
    );

    res.status(201).json({
      success: true,
      message: 'Payroll record created successfully',
      data: snap,
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
 * Edit a payroll record. IMMUTABLE SNAPSHOT: the stored day values (Calendar /
 * Office Working / Worked / LOP / paid-unpaid leave) are REUSED as-is — Attendance
 * and Company Holidays are NEVER re-read and worked days are NEVER rebuilt. Only
 * the money is recomputed from the frozen day snapshot + the edited manual values.
 * Employee and month are identity and cannot change on edit.
 */
export const updatePayroll = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: 'status is required' });
    }

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM payroll WHERE id = $1 LIMIT 1`,
      Number(id),
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }
    const existing = rows[0];

    // Manual/earning fields: use the edited value if supplied, else keep the stored one.
    const pick = (bodyVal: any, storedVal: any) =>
      bodyVal == null || bodyVal === '' ? Number(storedVal) || 0 : Number(bodyVal) || 0;

    const snap = {
      ...assembleSnapshot({
        employeeId: Number(existing.employee_id), // identity — not editable
        month: existing.month, // identity — not editable
        basicSalary: pick(req.body.basic_salary, existing.basic_salary),
        dearnessAllowance: pick(req.body.da, existing.da),
        fine: pick(req.body.fine, existing.fine),
        specialAllowance: pick(req.body.special_allowance, existing.special_allowance),
        providentFund: pick(req.body.pf, existing.pf),
        bonus: pick(req.body.bonus, existing.bonus),
        incentive: pick(req.body.incentive, existing.incentive),
        arrears: pick(req.body.arrears, existing.arrears),
        // Frozen day snapshot — reused verbatim from the stored row.
        days: {
          calendarDays: Number(existing.calendar_days) || 0,
          officeWorkingDays: Number(existing.office_working_days) || 0,
          workedDays: Number(existing.worked_days) || 0,
          lop: Number(existing.lop) || 0,
          paidLeaveDays: Number(existing.paid_leave_days) || 0,
          unpaidLeaveDays: Number(existing.unpaid_leave_days) || 0,
        },
      }),
      status,
    };

    const cols = Object.keys(snap);
    const vals = Object.values(snap);
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');

    await prisma.$executeRawUnsafe(
      `UPDATE payroll SET ${setClause} WHERE id = $${cols.length + 1}`,
      ...vals,
      Number(id),
    );

    res.status(200).json({
      success: true,
      message: 'Payroll record updated successfully',
      data: snap,
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
      return res.status(400).json({ success: false, message: 'status is required' });
    }

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM payroll WHERE id = $1 LIMIT 1`,
      Number(id),
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }

    await prisma.$executeRawUnsafe(`UPDATE payroll SET status = $1 WHERE id = $2`, status, Number(id));

    res.status(200).json({ success: true, message: 'Payroll status updated successfully' });
  } catch (error) {
    console.error('[Payroll Status Update Error]', error);
    res.status(500).json({ success: false, message: 'Failed to update payroll status' });
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
      Number(id),
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }

    await prisma.$executeRawUnsafe(`DELETE FROM payroll WHERE id = $1`, Number(id));

    res.status(200).json({ success: true, message: 'Payroll record deleted successfully' });
  } catch (error) {
    console.error('[Payroll Delete Error]', error);
    res.status(500).json({ success: false, message: 'Failed to delete payroll record' });
  }
};
