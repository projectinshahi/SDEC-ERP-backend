import prisma from '../config/db.js';
import { SalesAuthContext, can, leadOwnerScopeFilter, LEADS_VIEW_ALL } from '../utils/salesAuth.js';
import {
  computeAttendanceSummary, computeDepartmentRanking, todayIST, addDaysISO, daysBetweenInclusive, createWorkingCalendar,
} from './attendanceAnalytics.service.js';
import { computeSalesPerformanceReport } from './analytics.service.js';
import { buildLeadWhere, startOfDay, endOfDay } from '../utils/leadFilters.js';
import { campaignMetrics, isYmd, CAMPAIGN_VIEW_KEYS, EXPENSE_VIEW_KEYS, canAny } from './marketingFinance.service.js';
import { normalizeProjectStatus, isKnownProjectStatus } from '../controllers/project.controller.js';
import { isGlobalAdmin } from '../utils/roles.js';
import type { ToolSpec } from './aiProvider.service.js';

/**
 * ERP AI Assistant — the APPROVED, READ-ONLY data functions.
 *
 * This file is the only bridge between the model and ERP data. The model never
 * sees SQL or a DB handle: it can only name one of TOOL_SPECS, and `runTool`
 * then (1) validates every argument, (2) checks the caller's EXISTING module
 * permission at invocation time, (3) applies the EXISTING data scope (leave
 * own-vs-all, lead ownership, project membership, my-task participation),
 * (4) runs bounded aggregate queries (parameterised; no writes anywhere), and
 * (5) returns small structured results. Single-tenant ERP: no tenant column
 * exists on any table, so there is no company boundary to add.
 *
 * Business rules are REUSED, not re-derived: attendance → attendanceAnalytics
 * service, sales → computeSalesPerformanceReport + leadOwnerScopeFilter,
 * campaigns → campaignMetrics, project status → normalizeProjectStatus.
 */

// ── Shared types ─────────────────────────────────────────────────────────────

export interface Display {
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  /** Render a bar chart of column `valueIndex` by column 0. Only set for real breakdowns. */
  chartValueIndex?: number;
}
export interface ToolOutcome { forModel: Record<string, unknown>; displays: Display[] }

type Args = Record<string, unknown>;
const fail = (error: string, message: string): ToolOutcome => ({ forModel: { ok: false, error, message }, displays: [] });
const denied = (what: string): ToolOutcome =>
  fail('permission_denied', `The user does not have permission to view ${what}. Tell them they don't have access to this information.`);

const LIST_LIMIT = 25;
const TOOL_TIMEOUT_MS = 15_000;

// ── Date ranges (Asia/Kolkata, the ERP-wide convention — see todayIST) ───────

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_year', 'custom'] as const;
export interface DateRange { from: string; to: string; label: string }
const MAX_CUSTOM_DAYS = 3 * 366;

const ymdParts = (ymd: string) => ymd.split('-').map(Number) as [number, number, number];
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** Turns a period keyword (+ from/to for 'custom') into a validated IST date range. Weeks start Monday. */
export function resolvePeriod(args: Args, today: string = todayIST()): DateRange | { error: string } | null {
  const period = args.period;
  if (period === undefined || period === null || period === '' || period === 'all_time') return null;
  if (typeof period !== 'string' || !(PERIODS as readonly string[]).includes(period)) {
    return { error: `period must be one of: ${PERIODS.join(', ')}` };
  }
  const [y, m] = ymdParts(today);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const monday = addDaysISO(today, -dow);
  const r = (from: string, to: string): DateRange => ({ from, to, label: from === to ? from : `${from} to ${to}` });
  switch (period) {
    case 'today': return r(today, today);
    case 'yesterday': { const d = addDaysISO(today, -1); return r(d, d); }
    case 'this_week': return r(monday, addDaysISO(monday, 6));
    case 'last_week': return r(addDaysISO(monday, -7), addDaysISO(monday, -1));
    case 'this_month': return r(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`);
    case 'last_month': {
      const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
      return r(`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(lastDayOfMonth(py, pm))}`);
    }
    case 'this_year': return r(`${y}-01-01`, `${y}-12-31`);
    case 'last_year': return r(`${y - 1}-01-01`, `${y - 1}-12-31`);
    default: { // custom
      const from = typeof args.from === 'string' ? args.from.trim() : args.from;
      const to = typeof args.to === 'string' ? args.to.trim() : args.to;
      if (!isYmd(from) || !isYmd(to)) return { error: 'custom period needs valid from and to dates (YYYY-MM-DD).' };
      if (from > to) return { error: 'from must be on or before to.' };
      if (daysBetweenInclusive(from, to) > MAX_CUSTOM_DAYS) return { error: 'Date range is too long (max 3 years).' };
      return r(from, to);
    }
  }
}

// ── Arg helpers ──────────────────────────────────────────────────────────────

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T | null =>
  v === undefined || v === null || v === '' ? dflt : (allowed as readonly string[]).includes(String(v)) ? (v as T) : null;
const shortText = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined;
const num = (v: unknown) => Number(v) || 0;
const money2 = (v: unknown) => Math.round(num(v) * 100) / 100;

/** Department names are free text; match the user's wording case-insensitively to a real value. */
async function resolveDepartment(input: string): Promise<{ value: string } | { error: string }> {
  const rows = await prisma.$queryRawUnsafe<{ department: string }[]>(
    `SELECT DISTINCT department FROM employees WHERE LOWER(TRIM(department)) = LOWER(TRIM($1)) LIMIT 1`, input);
  if (rows.length) return { value: rows[0].department };
  const all = await prisma.$queryRawUnsafe<{ department: string }[]>(
    `SELECT DISTINCT department FROM employees WHERE COALESCE(TRIM(department),'') <> '' ORDER BY department LIMIT 50`);
  return { error: `No department named "${input}". Known departments: ${all.map((d) => d.department).join(', ') || 'none'}.` };
}

/**
 * Leave and Projects decide org-wide scope from the user's FIRST role only
 * (canManageAllLeave / getProjects read req.userRole). Mirror that exactly so the
 * assistant never shows more than those modules show the same user.
 */
async function primaryRolePerms(ctx: SalesAuthContext): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`, ctx.roleName);
  const raw = rows[0]?.permissions;
  const parsed = Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

const breakdownDisplay = (title: string, label: string, rows: Array<{ label: string; count: number }>): Display => ({
  title, columns: [label, 'Count'], rows: rows.map((r) => [r.label, r.count]),
  chartValueIndex: rows.length >= 2 ? 1 : undefined,
});

// ═════════════════════════════════════════════════════════════════════════════
// HR — employees (gate: hr.employees.view, as GET /hr/employees)
// ═════════════════════════════════════════════════════════════════════════════

async function employeeSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  if (!can(ctx, 'hr.employees.view')) return denied('employee information');
  const status = oneOf(a.status, ['active', 'all'] as const, 'active');
  const groupBy = oneOf(a.group_by, ['none', 'department', 'designation', 'employment_status'] as const, 'none');
  if (!status || !groupBy) return fail('invalid_arguments', 'status must be active|all; group_by must be none|department|designation|employment_status.');
  const joined = resolvePeriod({ period: a.joined_period, from: a.joined_from, to: a.joined_to });
  if (joined && 'error' in joined) return fail('invalid_arguments', joined.error);

  const where: string[] = []; const params: unknown[] = [];
  const deptIn = shortText(a.department);
  let department: string | undefined;
  if (deptIn) {
    const d = await resolveDepartment(deptIn);
    if ('error' in d) return fail('not_found', d.error);
    department = d.value; params.push(department); where.push(`e.department = $${params.length}`);
  }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ACTIVE = `e.employment_status = 'active'`; // the only status value the backend compares against

  const [tot] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active FROM employees e ${W}`, ...params);
  const statusRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COALESCE(NULLIF(TRIM(e.employment_status),''),'(not set)') AS label, COUNT(*)::int AS count
     FROM employees e ${W} GROUP BY 1 ORDER BY 2 DESC`, ...params);

  const out: Record<string, unknown> = {
    ok: true,
    scope: 'organization (HR employee records)',
    as_of_date: todayIST(),
    department: department ?? 'all departments',
    total_employee_records: tot.total,
    active_employees: tot.active,
    not_active_employees: tot.total - tot.active,
    employment_status_breakdown: statusRows,
    notes: [
      "'Active' = employment_status 'active'. Employees deleted in HR are removed from the table, so they are not counted anywhere.",
    ],
  };
  const displays: Display[] = [];

  if (joined) {
    const jp = [...params, joined.from, joined.to];
    const [j] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM employees e ${W ? W + ' AND' : 'WHERE'} e.join_date::date BETWEEN $${jp.length - 1}::date AND $${jp.length}::date`, ...jp);
    out.joined_in_period = { period: joined.label, count: j.n };
  }

  if (groupBy !== 'none') {
    const col = groupBy === 'employment_status' ? 'e.employment_status' : `e.${groupBy}`;
    const statusFilter = status === 'active' && groupBy !== 'employment_status' ? ACTIVE : '';
    const conds = [...where, statusFilter].filter(Boolean);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(NULLIF(TRIM(${col}),''),'Unassigned') AS label, COUNT(*)::int AS count
       FROM employees e ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`, ...params);
    const what = statusFilter ? 'active employees' : 'all employee records';
    out.breakdown = { by: groupBy, counts: what, rows };
    displays.push(breakdownDisplay(`Employees by ${groupBy.replace('_', ' ')} (${what})`, groupBy === 'employment_status' ? 'Status' : groupBy[0].toUpperCase() + groupBy.slice(1), rows));
  }
  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// HR — leave (gate: hr.leave.view OR hr.leave.self; scope mirrors canManageAllLeave)
// ═════════════════════════════════════════════════════════════════════════════

async function leaveSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  if (!can(ctx, 'hr.leave.view') && !can(ctx, 'hr.leave.self')) return denied('leave information');
  // Org-wide only when the FIRST role is admin or holds the EXACT hr.leave.view key (never hr.view) —
  // canManageAllLeave's rule exactly.
  const allScope = isGlobalAdmin(ctx.roleName) || (await primaryRolePerms(ctx)).includes('hr.leave.view');
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const status = oneOf(a.status, ['all', 'pending', 'approved', 'rejected'] as const, 'all');
  const groupBy = oneOf(a.group_by, ['none', 'status', 'leave_type', 'department'] as const, 'none');
  if (!status || !groupBy) return fail('invalid_arguments', 'status must be all|pending|approved|rejected; group_by must be none|status|leave_type|department.');

  const where: string[] = []; const params: unknown[] = [];
  const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  if (!allScope) {
    const own = await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM employees WHERE user_id = $1`, ctx.userId);
    if (!own.length) {
      return { forModel: { ok: true, scope: 'your own leave records', note: 'No employee profile is linked to this user, so there are no leave records.' }, displays: [] };
    }
    add((p) => `l.employee_id = ANY(${p}::int[])`, own.map((o) => o.id));
  }
  const deptIn = shortText(a.department);
  if (deptIn && allScope) {
    const d = await resolveDepartment(deptIn);
    if ('error' in d) return fail('not_found', d.error);
    add((p) => `e.department = ${p}`, d.value);
  }
  if (range) {
    add((p) => `l.start_date::date <= ${p}::date`, range.to);
    add((p) => `l.end_date::date >= ${p}::date`, range.from);
  }
  const base = `FROM leaves l JOIN employees e ON e.id = l.employee_id LEFT JOIN users u ON u.id = e.user_id`;
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [c] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS requests,
       COUNT(*) FILTER (WHERE l.status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE l.status = 'approved')::int AS approved,
       COUNT(*) FILTER (WHERE l.status = 'rejected')::int AS rejected,
       COUNT(DISTINCT l.employee_id) FILTER (WHERE l.status = 'approved' AND e.employment_status = 'active')::int AS employees_on_approved_leave
     ${base} ${W}`, ...params);

  const out: Record<string, unknown> = {
    ok: true,
    scope: allScope ? 'organization (all employees)' : 'your own leave records only',
    period: range ? range.label : 'all time (no date filter)',
    as_of_date: todayIST(),
    leave_requests: { total: c.requests, pending: c.pending, approved: c.approved, rejected: c.rejected },
    distinct_active_employees_with_approved_leave: c.employees_on_approved_leave,
    notes: [range
      ? 'A leave request is counted when its start..end dates overlap the period. Statuses are pending/approved/rejected.'
      : 'No period given: counts cover every leave request on record.'],
  };
  const displays: Display[] = [];
  const statusCond = status === 'all' ? '' : `l.status = '${status}'`; // value from the validated enum above

  if (groupBy !== 'none') {
    const col = groupBy === 'status' ? 'l.status' : groupBy === 'leave_type' ? 'l.leave_type' : 'e.department';
    const conds = [...where, statusCond].filter(Boolean);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(NULLIF(TRIM(${col}),''),'Unspecified') AS label, COUNT(*)::int AS count
       ${base} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} GROUP BY 1 ORDER BY 2 DESC LIMIT 50`, ...params);
    out.breakdown = { by: groupBy, status_filter: status, rows };
    displays.push(breakdownDisplay(`Leave requests by ${groupBy.replace('_', ' ')}${status !== 'all' ? ` (${status})` : ''}`, groupBy === 'leave_type' ? 'Leave type' : groupBy[0].toUpperCase() + groupBy.slice(1), rows));
  }

  if (a.list_employees === true) {
    const conds = [...where, statusCond || `l.status = 'approved'`].filter(Boolean);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(u.name, e.employee_code) AS name, e.department, l.leave_type, l.status, l.half_period,
              to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date
       ${base} WHERE ${conds.join(' AND ')} ORDER BY l.start_date, name LIMIT ${LIST_LIMIT + 1}`, ...params);
    const truncated = rows.length > LIST_LIMIT;
    const list = rows.slice(0, LIST_LIMIT);
    out.employees = { status_filter: status === 'all' ? 'approved' : status, rows: list, truncated };
    if (list.length) {
      displays.push({
        title: `Employees on ${status === 'all' ? 'approved' : status} leave${range ? ` (${range.label})` : ''}${truncated ? ` — first ${LIST_LIMIT}` : ''}`,
        columns: ['Name', 'Department', 'Leave type', 'From', 'To', 'Half day'],
        rows: list.map((r) => [r.name, r.department, r.leave_type, r.start_date, r.end_date, r.half_period || '']),
      });
    }
  }
  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// HR — attendance (org: hr.attendance.view / hr.analytics.view; otherwise the
// caller's own record, mirroring the ungated GET /hr/attendance/me)
// ═════════════════════════════════════════════════════════════════════════════

async function attendanceSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const range = resolvePeriod(a);
  if (!range) return fail('invalid_arguments', 'period is required for attendance (e.g. today, this_month).');
  if ('error' in range) return fail('invalid_arguments', range.error);
  const today = todayIST();
  if (range.from > today) return fail('invalid_arguments', 'Attendance cannot be reported for future dates.');
  const to = range.to > today ? today : range.to; // future days would count as absent
  if (daysBetweenInclusive(range.from, to) > 366) return fail('invalid_arguments', 'Attendance range is limited to 366 days.');
  const groupBy = oneOf(a.group_by, ['none', 'department'] as const, 'none');
  if (!groupBy) return fail('invalid_arguments', 'group_by must be none|department.');

  const orgScope = can(ctx, 'hr.attendance.view') || can(ctx, 'hr.analytics.view');
  const f: { from: string; to: string; department?: string; employeeId?: number } = { from: range.from, to };
  if (orgScope) {
    const deptIn = shortText(a.department);
    if (deptIn) {
      const d = await resolveDepartment(deptIn);
      if ('error' in d) return fail('not_found', d.error);
      f.department = d.value;
    }
  } else {
    const own = await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, ctx.userId);
    if (!own.length) return denied("organization attendance (and no employee profile is linked to this user for their own attendance)");
    f.employeeId = own[0].id;
  }

  let calendar = createWorkingCalendar();
  if (f.employeeId) {
    const hol = await prisma.$queryRawUnsafe<{ d: string }[]>(
      `SELECT holiday_date::text AS d FROM company_holidays WHERE is_optional = false AND holiday_date BETWEEN $1::date AND $2::date`, f.from, f.to);
    calendar = createWorkingCalendar({ holidays: new Set(hol.map((h) => h.d)) });
  }
  const s = await computeAttendanceSummary(f, calendar);
  const out: Record<string, unknown> = {
    ok: true,
    scope: orgScope ? `organization (active employees${f.department ? `, ${f.department}` : ''})` : 'your own attendance only',
    period: from_to_label(range.from, to),
    as_of: `${today} (Asia/Kolkata)`,
    active_employees_in_scope: s.totalEmployees,
    present: s.present,
    late: s.late,
    absent: s.absent,
    full_day_leave: s.fullDayLeave,
    half_day_leave: s.halfDay,
    working_days: s.workingDays,
    attendance_percent: s.attendancePct,
    definitions: {
      unit: 'employee-days (for a single day this equals number of employees)',
      present: 'attendance marked present, late, late-after-lunch or half-day (late arrivals ARE included in present)',
      late: 'subset of present marked late',
      absent: 'working days with no attendance record and no approved leave — for today this includes employees who have not been marked yet',
      leave: 'from approved leave requests',
      working_days: f.employeeId ? 'Mon–Sat from your join date, excluding company holidays' : 'Mon–Sat from each employee’s join date; company holidays are not excluded (as in HR attendance analytics)',
    },
  };
  const displays: Display[] = [];
  if (orgScope && groupBy === 'department' && !f.department) {
    const ranking = await computeDepartmentRanking(f);
    const rows = ranking.departments.slice(0, 50).map((d) => ({
      department: d.department, headcount: d.headcount, present: d.present, late: d.late, absent: d.absent,
      leave_days: d.leaveDays, attendance_percent: d.attendancePct,
    }));
    out.by_department = rows;
    displays.push({
      title: `Attendance by department (${from_to_label(range.from, to)})`,
      columns: ['Department', 'Headcount', 'Present', 'Late', 'Absent', 'Leave days', 'Attendance %'],
      rows: rows.map((r) => [r.department, r.headcount, r.present, r.late, r.absent, r.leave_days, r.attendance_percent]),
      chartValueIndex: rows.length >= 2 ? 6 : undefined,
    });
  }
  return { forModel: out, displays };
}
const from_to_label = (from: string, to: string) => (from === to ? from : `${from} to ${to}`);

// ═════════════════════════════════════════════════════════════════════════════
// Tasks — the My Tasks module (org-wide with mytasks.dashboard.view, exactly like
// the Task Dashboard; otherwise tasks the caller created or is a member of)
// ═════════════════════════════════════════════════════════════════════════════

const TASK_COMPLETED = ['done', 'approved'];
const ymdUTC = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null); // due_date is a DATE at UTC midnight

async function taskSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const orgScope = can(ctx, 'mytasks.dashboard.view');
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const groupBy = oneOf(a.group_by, ['none', 'status', 'priority', 'assignee', 'department'] as const, 'none');
  if (!groupBy) return fail('invalid_arguments', 'group_by must be none|status|priority|assignee|department.');

  const where: any = {};
  if (!orgScope) {
    const memberOf = await prisma.my_task_members.findMany({ where: { user_id: ctx.userId }, select: { task_id: true } });
    where.OR = [{ created_by: ctx.userId }, { id: { in: memberOf.map((m) => m.task_id) } }];
  }

  // Optional assignee filter — resolved to ONE active user by name.
  const assigneeIn = shortText(a.assignee_name);
  let assignee: { id: number; name: string } | undefined;
  if (assigneeIn) {
    const matches = (await prisma.users.findMany({
      where: { name: { contains: assigneeIn, mode: 'insensitive' } },
      select: { id: true, name: true, status: true }, take: 20,
    })).filter((u) => String(u.status ?? 'active').toLowerCase() !== 'inactive').slice(0, 6);
    const exact = matches.filter((m) => m.name.toLowerCase() === assigneeIn.toLowerCase());
    const pick = exact.length === 1 ? exact : matches;
    if (pick.length === 0) return fail('not_found', `No active user matches "${assigneeIn}".`);
    if (pick.length > 1) return fail('ambiguous', `Several users match "${assigneeIn}": ${pick.map((m) => m.name).join(', ')}. Ask the user which one.`);
    assignee = pick[0];
    where.members = { some: { user_id: assignee.id } };
  }

  const tasks = await prisma.my_tasks.findMany({
    where,
    select: { id: true, status: true, priority: true, due_date: true, created_at: true, members: { select: { user_id: true } } },
  });

  // Department via employees.user_id (users without an employee row → Unassigned), as the Task Dashboard does.
  const memberIds = [...new Set(tasks.flatMap((t) => t.members.map((m) => m.user_id)))];
  const deptRows = memberIds.length
    ? await prisma.$queryRawUnsafe<{ user_id: number; department: string }[]>(
        `SELECT user_id, department FROM employees WHERE user_id = ANY($1::int[])`, memberIds)
    : [];
  const deptOf = new Map(deptRows.map((r) => [r.user_id, (r.department || '').trim() || 'Unassigned']));
  const deptIn = shortText(a.department)?.toLowerCase();
  const inDept = (t: (typeof tasks)[number]) =>
    !deptIn || t.members.some((m) => (deptOf.get(m.user_id) || 'Unassigned').toLowerCase() === deptIn);
  const scoped = tasks.filter(inDept);

  const today = todayIST();
  const done = (t: { status: string }) => TASK_COMPLETED.includes(t.status);
  const overdue = (t: (typeof tasks)[number]) => {
    const d = ymdUTC(t.due_date);
    return !!d && d < today && !done(t) && t.status !== 'waiting'; // the Task Dashboard's "delayed" rule
  };
  const current = {
    total: scoped.length,
    open_not_completed: scoped.filter((t) => !done(t)).length,
    overdue: scoped.filter(overdue).length,
    due_today: scoped.filter((t) => ymdUTC(t.due_date) === today && !done(t)).length,
    waiting: scoped.filter((t) => t.status === 'waiting').length,
    completed: scoped.filter(done).length,
  };

  const out: Record<string, unknown> = {
    ok: true,
    source: 'My Tasks module',
    scope: orgScope ? 'organization (all tasks, Task Dashboard access)' : 'only tasks you created or are a member of',
    filters: { assignee: assignee?.name ?? 'any', department: deptIn ? shortText(a.department) : 'any' },
    as_of_date: `${today} (Asia/Kolkata)`,
    current,
    definitions: {
      completed: "status 'done' or 'approved'",
      overdue: "due date before today, not completed, and not in 'waiting'",
      statuses: 'todo, in_progress, waiting, done, approved',
    },
  };

  if (range) {
    const fromD = startOfDay(range.from), toD = endOfDay(range.to);
    const ids = scoped.map((t) => t.id);
    const acts = ids.length
      ? await prisma.my_task_activities.findMany({
          where: { task_id: { in: ids }, created_at: { gte: fromD, lte: toD } },
          select: { task_id: true, action: true },
        })
      : [];
    const completedIds = new Set(acts
      .filter((x) => { const s = x.action.toLowerCase(); return s.includes('→ done') || s.includes('→ approved'); })
      .map((x) => x.task_id));
    const stillDone = scoped.filter((t) => completedIds.has(t.id) && done(t)).length;
    out.in_period = {
      period: range.label,
      created: scoped.filter((t) => t.created_at >= fromD && t.created_at <= toD).length,
      completed: stillDone,
      completed_note: 'Completion time is reconstructed from the task activity log (no completion date column); tasks completed before activity logging existed are not counted.',
    };
  }

  const displays: Display[] = [];
  if (groupBy !== 'none') {
    const counts = new Map<string, { total: number; open: number; overdue: number; completed: number }>();
    const bump = (k: string, t: (typeof tasks)[number]) => {
      const c = counts.get(k) ?? { total: 0, open: 0, overdue: 0, completed: 0 };
      c.total++; if (done(t)) c.completed++; else c.open++; if (overdue(t)) c.overdue++;
      counts.set(k, c);
    };
    let nameOf = new Map<number, string>();
    if (groupBy === 'assignee' && memberIds.length) {
      const us = await prisma.users.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } });
      nameOf = new Map(us.map((u) => [u.id, u.name]));
    }
    for (const t of scoped) {
      if (groupBy === 'status' || groupBy === 'priority') bump(String(t[groupBy] || 'unspecified'), t);
      else if (groupBy === 'assignee') {
        if (!t.members.length) bump('Unassigned', t);
        for (const m of t.members) bump(nameOf.get(m.user_id) || `User ${m.user_id}`, t);
      } else {
        const ds = new Set(t.members.map((m) => deptOf.get(m.user_id) || 'Unassigned'));
        if (!ds.size) ds.add('Unassigned');
        for (const d of ds) bump(d, t);
      }
    }
    const rows = [...counts.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 30)
      .map(([label, c]) => ({ label, ...c }));
    out.breakdown = { by: groupBy, note: groupBy === 'assignee' || groupBy === 'department' ? 'A task counts once per assigned member (or department).' : undefined, rows };
    displays.push({
      title: `Tasks by ${groupBy}`,
      columns: [groupBy[0].toUpperCase() + groupBy.slice(1), 'Total', 'Open', 'Overdue', 'Completed'],
      rows: rows.map((r) => [r.label, r.total, r.open, r.overdue, r.completed]),
      chartValueIndex: rows.length >= 2 ? 1 : undefined,
    });
  }
  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// Projects (scope mirrors GET /projects: global admin = all, else membership)
// ═════════════════════════════════════════════════════════════════════════════

const TASK_DONE_WORDS = ['done', 'completed', 'complete', 'closed', 'resolved'];

async function projectSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const includeArchived = a.include_archived === true;
  const statusIn = shortText(a.status);
  if (statusIn && !isKnownProjectStatus(statusIn)) {
    return fail('invalid_arguments', 'Unknown project status. Use one of: active, on-track, delayed, on-hold, completed, archived, planning, at-risk, cancelled.');
  }
  const statusFilter = statusIn ? normalizeProjectStatus(statusIn) : undefined;
  const allProjects = isGlobalAdmin(ctx.roleName); // getProjects checks the first role only
  const nameIn = shortText(a.project_name);

  const where: any = {};
  if (!allProjects) where.project_members = { some: { user_id: ctx.userId } };
  if (nameIn) where.name = { contains: nameIn, mode: 'insensitive' };
  const projects = await prisma.projects.findMany({
    where, select: { id: true, name: true, status: true, is_archived: true, category: true },
    orderBy: { name: 'asc' }, take: 2000,
  });
  const norm = projects.map((p) => ({ ...p, s: p.is_archived ? 'archived' : normalizeProjectStatus(p.status) }));
  const visible = norm.filter((p) => includeArchived || p.s !== 'archived');

  const dist = new Map<string, number>();
  for (const p of visible) dist.set(p.s, (dist.get(p.s) || 0) + 1);
  const statusRows = [...dist.entries()].sort((x, y) => y[1] - x[1]).map(([label, count]) => ({ label, count }));
  const selected = statusFilter ? visible.filter((p) => p.s === statusFilter) : visible;

  const out: Record<string, unknown> = {
    ok: true,
    scope: allProjects ? 'all projects (admin)' : 'projects you are a member of',
    archived_included: includeArchived,
    total_projects: visible.length,
    by_status: statusRows,
    status_values: 'active, on-track, delayed, on-hold, completed, archived, planning, at-risk, cancelled (as recorded on each project)',
    filter: { status: statusFilter ?? 'any', name: nameIn ?? 'any' },
    matching_projects: selected.length,
  };
  const displays: Display[] = [];
  if (!statusFilter && statusRows.length) displays.push(breakdownDisplay('Projects by status', 'Status', statusRows));

  const list = selected.slice(0, LIST_LIMIT);
  if (a.include_task_summary === true && !can(ctx, 'task.read')) {
    out.project_task_summary = 'not permitted: viewing Kanban tasks requires the "View Boards" (task.read) permission';
  } else if (a.include_task_summary === true && list.length) {
    const today = todayIST();
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `WITH t AS (
         SELECT b.project_id AS pid, t."dueDate" AS due,
                (LOWER(TRIM(t.status)) = ANY($2::text[]) OR COALESCE(c.label,'') ~* '(done|complete)') AS is_done
         FROM kanban_tasks t
         JOIN kanban_boards b ON b.id = t.board_id
         LEFT JOIN kanban_columns c ON c.id = t.status
         WHERE b.project_id = ANY($1::text[]))
       SELECT pid, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_done)::int AS done,
              COUNT(*) FILTER (WHERE NOT is_done AND due ~ '^\\d{4}-\\d{2}-\\d{2}' AND LEFT(due,10) < $3)::int AS overdue
       FROM t GROUP BY pid`,
      list.map((p) => p.id), TASK_DONE_WORDS, today);
    const byId = new Map(rows.map((r) => [r.pid, r]));
    const summary = list.map((p) => {
      const r = byId.get(p.id) ?? { total: 0, done: 0, overdue: 0 };
      return { project: p.name, status: p.s, tasks_total: r.total, tasks_done: r.done, tasks_open: r.total - r.done, tasks_overdue: r.overdue };
    });
    out.project_task_summary = { projects: summary, truncated: selected.length > LIST_LIMIT, task_definitions: 'done = status word done/completed/closed/resolved or a board column labelled Done/Complete; overdue = not done and due date before today' };
    displays.push({
      title: `Project task summary${selected.length > LIST_LIMIT ? ` (first ${LIST_LIMIT})` : ''}`,
      columns: ['Project', 'Status', 'Tasks', 'Done', 'Open', 'Overdue'],
      rows: summary.map((s) => [s.project, s.status, s.tasks_total, s.tasks_done, s.tasks_open, s.tasks_overdue]),
    });
  } else if (statusFilter || nameIn) {
    out.projects = list.map((p) => ({ name: p.name, status: p.s, category: p.category }));
    out.truncated = selected.length > LIST_LIMIT;
    if (list.length) displays.push({ title: `Projects${statusFilter ? ` — ${statusFilter}` : ''}`, columns: ['Project', 'Status', 'Category'], rows: list.map((p) => [p.name, p.s, p.category || '']) });
  }
  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sales — opportunities/pipeline (gate sales.leads.view; owner scope = the
// Pipeline's leadOwnerScopeFilter; numbers from the Sales Performance report)
// ═════════════════════════════════════════════════════════════════════════════

async function salesSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  if (!can(ctx, 'sales.leads.view')) return denied('sales pipeline information');
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);

  const where = buildLeadWhere(range ? { fromDate: range.from, toDate: range.to } : {});
  const scope = await leadOwnerScopeFilter(ctx);
  if (scope === undefined) delete where.ownerId; else where.ownerId = scope;
  const window = range ? { start: startOfDay(range.from), end: endOfDay(range.to) } : null;
  const r = await computeSalesPerformanceReport(where, window);
  const s = r.summary;

  const funnel = (r.funnel as any[]).map((f) => ({ stage: f.stage, opportunities: f.opportunities, value: f.value }));
  const team = (r.teamPerformance as any[]).slice(0, 10).map((t) => ({
    owner: t.name, opportunities: t.opportunities, won_revenue: t.wonRevenue, active_pipeline: t.activePipeline, won_rate_percent: t.conversion,
  }));
  const out: Record<string, unknown> = {
    ok: true,
    scope: can(ctx, LEADS_VIEW_ALL) ? 'all opportunities' : 'only your own opportunities',
    period: range ? `opportunities CREATED ${range.label} (cohort basis)` : 'all opportunities on record',
    currency: 'INR',
    total_opportunities: s.totalOpportunities,
    total_value: s.totalValue,
    active_pipeline: { opportunities: s.activeOpportunities, value: s.activePipeline, stages: 'NQL, MQL, SQL, PQL, SAL' },
    won: { count: s.won, revenue: s.wonRevenue },
    hold: s.hold, lost: s.lost,
    converted: s.converted,
    conversion_rate_percent: s.overallConversion,
    target: s.targetAvailable ? { target: s.target, achievement_percent: s.achievementPercentage, gap: s.targetGap } : 'no revenue target set for this period',
    stage_funnel: funnel,
    by_owner_top10_by_won_revenue: team,
    definitions: {
      won: "opportunities currently in stage WON; revenue = their opportunity value",
      converted: "opportunities with status 'converted' (converted to a deal); conversion rate = converted ÷ total",
    },
  };
  const displays: Display[] = [{
    title: `Pipeline by stage${range ? ` (created ${range.label})` : ''}`,
    columns: ['Stage', 'Opportunities', 'Value (INR)'],
    rows: funnel.map((f) => [f.stage, f.opportunities, f.value]),
    chartValueIndex: 1,
  }];
  if (team.length > 1) {
    displays.push({ title: 'By owner (top 10 by won revenue)', columns: ['Owner', 'Opportunities', 'Won revenue (INR)', 'Active pipeline (INR)', 'Won %'], rows: team.map((t) => [t.owner, t.opportunities, t.won_revenue, t.active_pipeline, t.won_rate_percent]) });
  }
  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// Finance (gates mirror /finance routes; all-or-nothing, no owner scoping)
// ═════════════════════════════════════════════════════════════════════════════

async function financeSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  // Periods, breakdowns and status splits need the list keys (GET /finance/expenses | /income).
  // Dashboard/reports-only holders get exactly what GET /finance/overview shows them: all-time totals.
  const canExp = can(ctx, 'finance.expenses.view');
  const canInc = can(ctx, 'finance.income.view');
  const canOverview = can(ctx, 'finance.dashboard.view') || can(ctx, 'finance.reports.view');
  if (!canExp && !canInc && !canOverview) return denied('finance information');
  if (!canExp && !canInc) {
    const [t] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT (SELECT COALESCE(SUM(amount),0) FROM finance_expense)::float8 AS expenses,
              (SELECT COALESCE(SUM(amount),0) FROM finance_income)::float8 AS income`);
    return {
      forModel: {
        ok: true, scope: 'organization (finance overview only)', currency: 'INR', period: 'all time',
        total_expenses: money2(t.expenses), total_income: money2(t.income), net: money2(t.income - t.expenses),
        note: 'This user can only see the all-time Finance overview totals. Date ranges and breakdowns need the Finance expenses/income view permissions; if they asked for a period or breakdown, say that detail is not available to them.',
      },
      displays: [],
    };
  }
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const groupBy = oneOf(a.group_by, ['none', 'category', 'payment_status', 'approval_status', 'month'] as const, 'none');
  if (!groupBy) return fail('invalid_arguments', 'group_by must be none|category|payment_status|approval_status|month.');

  const params: unknown[] = range ? [range.from, range.to] : [];
  const expW = range ? `WHERE expense_date::date BETWEEN $1::date AND $2::date` : '';
  const out: Record<string, unknown> = {
    ok: true, scope: 'organization', currency: 'INR',
    period: range ? range.label : 'all time (no date filter)',
    rounding: 'amounts rounded to 2 decimals (paise)',
  };
  const displays: Display[] = [];

  if (canExp) {
    const [e] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS total,
         COALESCE(SUM(amount) FILTER (WHERE status = 'paid'),0)::float8 AS paid,
         COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),0)::float8 AS payment_pending,
         COALESCE(SUM(amount) FILTER (WHERE approval_status = 'approved'),0)::float8 AS approved,
         COALESCE(SUM(amount) FILTER (WHERE approval_status = 'pending'),0)::float8 AS approval_pending,
         COUNT(*) FILTER (WHERE approval_status = 'pending')::int AS approval_pending_count,
         COALESCE(SUM(amount) FILTER (WHERE approval_status = 'rejected'),0)::float8 AS rejected
       FROM finance_expense ${expW}`, ...params);
    out.expenses = {
      records: e.n,
      total_all_records: money2(e.total),
      by_payment_status: { paid: money2(e.paid), pending_payment: money2(e.payment_pending) },
      by_approval_status: { approved: money2(e.approved), awaiting_approval: money2(e.approval_pending), awaiting_approval_count: e.approval_pending_count, rejected: money2(e.rejected) },
      note: 'Total includes every expense record (Finance and Marketing), as the Finance overview does. Payment status (paid/pending) and approval status (approved/pending/rejected) are separate.',
    };
    if (groupBy !== 'none') {
      const col = groupBy === 'category' ? `COALESCE(NULLIF(TRIM(category),''),'general')`
        : groupBy === 'payment_status' ? 'status' : groupBy === 'approval_status' ? 'approval_status'
        : `to_char(expense_date,'YYYY-MM')`;
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${col} AS label, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float8 AS amount
         FROM finance_expense ${expW} GROUP BY 1 ORDER BY ${groupBy === 'month' ? '1' : '3 DESC'} LIMIT 60`, ...params);
      const shaped = rows.map((r) => ({ label: r.label, count: r.count, amount: money2(r.amount) }));
      (out.expenses as any).breakdown = { by: groupBy, rows: shaped };
      displays.push({
        title: `Expenses by ${groupBy.replace('_', ' ')}`, columns: [groupBy === 'month' ? 'Month' : 'Group', 'Records', 'Amount (INR)'],
        rows: shaped.map((r) => [r.label, r.count, r.amount]), chartValueIndex: shaped.length >= 2 ? 2 : undefined,
      });
    }
  } else out.expenses = 'not permitted for this user';

  if (canInc) {
    const incW = range ? `WHERE income_date::date BETWEEN $1::date AND $2::date` : '';
    const [i] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS total,
         COALESCE(SUM(amount) FILTER (WHERE status = 'received'),0)::float8 AS received,
         COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),0)::float8 AS pending
       FROM finance_income ${incW}`, ...params);
    out.income = { records: i.n, total: money2(i.total), received: money2(i.received), pending: money2(i.pending) };
  } else out.income = 'not permitted for this user';

  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// Marketing (each section gated by the Marketing module's own keys)
// ═════════════════════════════════════════════════════════════════════════════

async function marketingSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const canCamp = canAny(ctx, CAMPAIGN_VIEW_KEYS);
  const canExp = canAny(ctx, EXPENSE_VIEW_KEYS);
  const canContent = can(ctx, 'marketing.content.view');
  if (!canCamp && !canExp && !canContent) return denied('marketing information');
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const today = todayIST();
  const out: Record<string, unknown> = { ok: true, scope: 'organization', currency: 'INR', as_of_date: `${today} (Asia/Kolkata)`, period: range ? range.label : 'all time' };
  const displays: Display[] = [];

  if (canCamp) {
    const p: unknown[] = range ? [range.to, range.from] : [];
    const W = range ? `WHERE start_date <= $1::date AND end_date >= $2::date` : '';
    const [t] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE start_date <= $${p.length + 1}::date AND end_date >= $${p.length + 1}::date)::int AS running_today,
         COALESCE(SUM(budget),0)::float8 AS budget, COALESCE(SUM(spend),0)::float8 AS spend,
         COALESCE(SUM(impressions),0)::float8 AS impressions, COALESCE(SUM(clicks),0)::float8 AS clicks,
         COALESCE(SUM(leads),0)::float8 AS leads, COALESCE(SUM(conversions),0)::float8 AS conversions,
         COALESCE(SUM(revenue),0)::float8 AS revenue
       FROM marketing_ad_campaigns ${W}`, ...p, today);
    const top = await prisma.$queryRawUnsafe<any[]>(
      `SELECT name, platform, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
         budget::float8 AS budget, spend::float8 AS spend, leads::float8 AS leads, revenue::float8 AS revenue
       FROM marketing_ad_campaigns ${W} ORDER BY spend DESC, name LIMIT 10`, ...p);
    const totals = { budget: t.budget, spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads: t.leads, revenue: t.revenue };
    out.ad_campaigns = {
      campaigns: t.n,
      running_today: t.running_today,
      running_definition: 'campaigns whose start..end dates include today (campaigns have no status field)',
      period_filter: range ? 'campaigns whose dates overlap the period' : 'all campaigns',
      totals: { ...totals, conversions: t.conversions },
      metrics: campaignMetrics(totals),
      metrics_note: 'cpl/cpc/ctr/roi are null when their denominator is 0; ctr and roi are percentages',
      top_by_spend: top,
    };
    if (top.length) displays.push({
      title: 'Ad campaigns (top by spend)', columns: ['Campaign', 'Platform', 'Start', 'End', 'Budget', 'Spend', 'Leads'],
      rows: top.map((c) => [c.name, c.platform, c.start_date, c.end_date, money2(c.budget), money2(c.spend), c.leads]),
    });
  } else out.ad_campaigns = 'not permitted for this user';

  if (canExp) {
    const p: unknown[] = range ? [range.from, range.to] : [];
    const W = `WHERE client_id IS NOT NULL${range ? ' AND expense_date::date BETWEEN $1::date AND $2::date' : ''}`;
    const [e] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE approval_status = 'approved'),0)::float8 AS approved,
         COUNT(*) FILTER (WHERE approval_status = 'approved')::int AS approved_n,
         COALESCE(SUM(amount) FILTER (WHERE approval_status = 'pending'),0)::float8 AS pending,
         COUNT(*) FILTER (WHERE approval_status = 'pending')::int AS pending_n,
         COUNT(*) FILTER (WHERE approval_status = 'rejected')::int AS rejected_n
       FROM finance_expense ${W}`, ...p);
    const cats = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(NULLIF(TRIM(category),''),'general') AS label, COALESCE(SUM(amount),0)::float8 AS amount
       FROM finance_expense ${W} AND approval_status = 'approved' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, ...p);
    out.marketing_expenses = {
      approved_total: money2(e.approved), approved_count: e.approved_n,
      pending_approval_total: money2(e.pending), pending_approval_count: e.pending_n,
      rejected_count: e.rejected_n,
      approved_by_category: cats.map((c) => ({ category: c.label, amount: money2(c.amount) })),
      note: 'Marketing reporting counts APPROVED expenses only; pending and rejected are shown separately.',
    };
    if (cats.length) displays.push({ title: 'Approved marketing expenses by category', columns: ['Category', 'Amount (INR)'], rows: cats.map((c) => [c.label, money2(c.amount)]), chartValueIndex: cats.length >= 2 ? 1 : undefined });
  } else out.marketing_expenses = 'not permitted for this user';

  if (canContent) {
    const [c] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*) FILTER (WHERE stage = 'review')::int AS in_review,
              COUNT(*) FILTER (WHERE stage = 'review' AND approver_id = $1)::int AS awaiting_me
       FROM marketing_contents WHERE archived = false`, ctx.userId);
    out.content_approvals = { content_in_review: c.in_review, awaiting_your_review: c.awaiting_me };
  } else out.content_approvals = 'not permitted for this user';

  return { forModel: out, displays };
}

// ═════════════════════════════════════════════════════════════════════════════
// Registry — the ONLY functions the model can reach
// ═════════════════════════════════════════════════════════════════════════════

const PERIOD_PROPS = {
  period: { type: 'string', enum: [...PERIODS, 'all_time'], description: 'Date range, resolved by the server in Asia/Kolkata. Weeks start Monday. Use custom with from/to for explicit dates.' },
  from: { type: 'string', description: 'YYYY-MM-DD, only with period=custom' },
  to: { type: 'string', description: 'YYYY-MM-DD, only with period=custom' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS: Record<string, { spec: ToolSpec; run: (ctx: SalesAuthContext, a: Args) => Promise<ToolOutcome> }> = {
  get_employee_summary: {
    spec: { name: 'get_employee_summary', description: 'HR employee headcount: total/active employee records, employment-status breakdown, optional breakdown by department/designation, and how many joined in a period. Aggregates only — never personal details.',
      parameters: obj({
        status: { type: 'string', enum: ['active', 'all'], description: 'Which records the group_by breakdown counts. Default active.' },
        department: { type: 'string', description: 'Restrict to one department' },
        group_by: { type: 'string', enum: ['none', 'department', 'designation', 'employment_status'] },
        joined_period: { type: 'string', enum: [...PERIODS], description: 'Count employees whose join date falls in this period' },
        joined_from: { type: 'string' }, joined_to: { type: 'string' },
      }) },
    run: employeeSummary,
  },
  get_leave_summary: {
    spec: { name: 'get_leave_summary', description: 'Leave requests: counts by status (pending/approved/rejected), distinct employees on approved leave, optional breakdown, optional list of employees on leave. Use period=today for "who is on leave today". Omit period for all-time totals (e.g. currently pending requests).',
      parameters: obj({
        ...PERIOD_PROPS,
        status: { type: 'string', enum: ['all', 'pending', 'approved', 'rejected'], description: 'Filter for breakdown/list. Default all (list defaults to approved).' },
        department: { type: 'string' },
        group_by: { type: 'string', enum: ['none', 'status', 'leave_type', 'department'] },
        list_employees: { type: 'boolean', description: 'Include up to 25 employees on leave (names, department, dates)' },
      }) },
    run: leaveSummary,
  },
  get_attendance_summary: {
    spec: { name: 'get_attendance_summary', description: 'Attendance for a period using the HR attendance analytics rules: present (incl. late), late, absent, leave, attendance %, optional department breakdown. Users without HR attendance access get only their own attendance.',
      parameters: obj({ ...PERIOD_PROPS, department: { type: 'string' }, group_by: { type: 'string', enum: ['none', 'department'] } }, ['period']) },
    run: attendanceSummary,
  },
  get_task_summary: {
    spec: { name: 'get_task_summary', description: 'Tasks from the My Tasks module: total, open, overdue, due today, completed; tasks created/completed in a period; optional filter by assignee name or department; optional breakdown. Users without the Task Dashboard permission only see tasks they created or are a member of.',
      parameters: obj({
        ...PERIOD_PROPS,
        assignee_name: { type: 'string', description: 'Employee/user name to filter tasks assigned to them' },
        department: { type: 'string' },
        group_by: { type: 'string', enum: ['none', 'status', 'priority', 'assignee', 'department'] },
      }) },
    run: taskSummary,
  },
  get_project_summary: {
    spec: { name: 'get_project_summary', description: 'Development projects: counts by status (active, completed, on-hold, …), optional list filtered by status or name, optional project-wise Kanban task summary (total/done/open/overdue). Non-admins only see projects they are a member of.',
      parameters: obj({
        status: { type: 'string', description: 'Filter by status, e.g. active, completed, on-hold, delayed, planning, cancelled' },
        project_name: { type: 'string' },
        include_archived: { type: 'boolean' },
        include_task_summary: { type: 'boolean' },
      }) },
    run: projectSummary,
  },
  get_sales_summary: {
    spec: { name: 'get_sales_summary', description: 'Sales pipeline/opportunities (leads): totals, value, stage funnel (NQL→WON, HOLD, LOST), won revenue, converted count and conversion rate, target achievement, top owners. A period filters opportunities by CREATION date. Lead visibility follows the user\'s own/all-leads permission.',
      parameters: obj({ ...PERIOD_PROPS }) },
    run: salesSummary,
  },
  get_finance_summary: {
    spec: { name: 'get_finance_summary', description: 'Finance: expense totals (with payment status and approval status splits) and income totals for a period; optional expense breakdown by category, payment status, approval status or month (for month-over-month comparison).',
      parameters: obj({ ...PERIOD_PROPS, group_by: { type: 'string', enum: ['none', 'category', 'payment_status', 'approval_status', 'month'] } }) },
    run: financeSummary,
  },
  get_marketing_summary: {
    spec: { name: 'get_marketing_summary', description: 'Marketing: ad campaigns (count, running today, budget/spend/leads/revenue, CPL/CPC/CTR/ROI, top campaigns), marketing expenses (approved/pending/rejected, by category) and pending approvals (expenses awaiting approval, content in review).',
      parameters: obj({ ...PERIOD_PROPS }) },
    run: marketingSummary,
  },
};

export const TOOL_SPECS: ToolSpec[] = Object.values(TOOLS).map((t) => t.spec);
export const TOOL_NAMES = Object.keys(TOOLS);

/** Executes ONE approved tool for ONE already-authenticated caller. Never throws. */
export async function runTool(ctx: SalesAuthContext, name: string, rawArgs: string): Promise<ToolOutcome> {
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) return fail('unknown_tool', `"${name}" is not an available tool.`);
  let args: Args;
  try {
    const parsed = JSON.parse(rawArgs || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed;
  } catch {
    return fail('invalid_arguments', 'Arguments must be a JSON object.');
  }
  try {
    // ponytail: race-based timeout returns to the model but does not cancel the DB query; every query is a bounded aggregate.
    return await Promise.race([
      tool.run(ctx, args),
      new Promise<ToolOutcome>((resolve) => setTimeout(() => resolve(fail('timeout', 'The data lookup took too long. Ask the user to narrow the date range.')), TOOL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.error(`[AI Assistant] tool ${name} failed:`, (e as Error)?.message);
    return fail('tool_failed', 'The data could not be retrieved right now.');
  }
}

/** Starter questions the caller can actually get answered (checked against the same gates as the tools). */
export async function suggestionsFor(ctx: SalesAuthContext): Promise<string[]> {
  const out: string[] = [];
  if (can(ctx, 'hr.employees.view')) out.push('How many active employees do we have?', 'Show department-wise employee count');
  if (can(ctx, 'hr.attendance.view') || can(ctx, 'hr.analytics.view')) out.push("What is today's attendance summary?");
  else if ((await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM employees WHERE user_id = $1 LIMIT 1`, ctx.userId)).length) out.push('What is my attendance this month?');
  if (can(ctx, 'hr.leave.view') || can(ctx, 'hr.leave.self')) {
    const orgLeave = isGlobalAdmin(ctx.roleName) || (await primaryRolePerms(ctx)).includes('hr.leave.view');
    out.push(orgLeave ? 'Who is on leave today?' : 'How many leave requests do I have pending?');
  }
  out.push('How many tasks are pending?', 'How many tasks are overdue?', 'Which projects are currently active?');
  if (can(ctx, 'sales.leads.view')) out.push("Give me this month's sales summary");
  if (can(ctx, 'finance.expenses.view')) out.push("What are this month's expenses by category?");
  else if (can(ctx, 'finance.income.view') || can(ctx, 'finance.dashboard.view') || can(ctx, 'finance.reports.view')) out.push('What are our total income and expenses?');
  if (canAny(ctx, CAMPAIGN_VIEW_KEYS)) out.push('Which marketing campaigns are running?');
  return out;
}
