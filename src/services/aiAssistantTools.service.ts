import prisma from '../config/db.js';
import { SalesAuthContext, can, leadOwnerScopeFilter, LEADS_VIEW_ALL } from '../utils/salesAuth.js';
import {
  computeAttendanceSummary, computeDepartmentRanking, computeAttendanceTrend, todayIST, addDaysISO, daysBetweenInclusive,
  createWorkingCalendar, generateBuckets, previousWindow, Granularity,
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
  /** Render a chart of column `chartValueIndex` by column 0. Only set for real breakdowns/series. */
  chartValueIndex?: number;
  /** Chart kind (default bar when chartValueIndex is set): line = chronological series, pie = share of a whole. */
  chart?: 'bar' | 'line' | 'pie';
  /** Several value columns on one chart (e.g. current vs previous bars, or approved/pending lines). */
  chartSeries?: number[];
}
export interface ToolOutcome { forModel: Record<string, unknown>; displays: Display[] }

type Args = Record<string, unknown>;
const fail = (error: string, message: string): ToolOutcome => ({ forModel: { ok: false, error, message }, displays: [] });
const denied = (what: string): ToolOutcome =>
  fail('permission_denied', `The user does not have permission to view ${what}. Tell them they don't have access to this information.`);

const LIST_LIMIT = 25;
const TOOL_TIMEOUT_MS = 15_000;

// ── Date ranges (Asia/Kolkata, the ERP-wide convention — see todayIST) ───────

export const PERIODS = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year',
  'last_7_days', 'last_30_days', 'last_90_days', 'last_6_months', 'custom',
] as const;
export type Period = (typeof PERIODS)[number];
export interface DateRange { from: string; to: string; label: string; kind: Period; days: number }
const MAX_CUSTOM_DAYS = 3 * 366;

const ymdParts = (ymd: string) => ymd.split('-').map(Number) as [number, number, number];
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
/** First and last day of the calendar month `offset` months away from (y, m). */
const monthSpan = (y: number, m: number, offset: number): [string, string] => {
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
  return [`${yy}-${pad(mm)}-01`, `${yy}-${pad(mm)}-${pad(lastDayOfMonth(yy, mm))}`];
};
const mkRange = (from: string, to: string, kind: Period): DateRange =>
  ({ from, to, kind, days: daysBetweenInclusive(from, to), label: from === to ? from : `${from} to ${to}` });

/** Turns a period keyword (+ from/to for 'custom') into a validated IST date range. Weeks start Monday. */
export function resolvePeriod(args: Args, today: string = todayIST()): DateRange | { error: string } | null {
  const period = args.period;
  if (period === undefined || period === null || period === '' || period === 'all_time') return null;
  if (typeof period !== 'string' || !(PERIODS as readonly string[]).includes(period)) {
    return { error: `period must be one of: ${PERIODS.join(', ')}` };
  }
  const kind = period as Period;
  const [y, m] = ymdParts(today);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const monday = addDaysISO(today, -dow);
  const q0 = m - ((m - 1) % 3); // first month of the current quarter
  const r = (from: string, to: string): DateRange => mkRange(from, to, kind);
  const months = (offset: number, span: number): DateRange => r(monthSpan(y, m, offset)[0], monthSpan(y, m, offset + span - 1)[1]);
  switch (kind) {
    case 'today': return r(today, today);
    case 'yesterday': { const d = addDaysISO(today, -1); return r(d, d); }
    case 'this_week': return r(monday, addDaysISO(monday, 6));
    case 'last_week': return r(addDaysISO(monday, -7), addDaysISO(monday, -1));
    case 'this_month': return months(0, 1);
    case 'last_month': return months(-1, 1);
    case 'this_quarter': return months(q0 - m, 3);
    case 'last_quarter': return months(q0 - m - 3, 3);
    case 'this_year': return r(`${y}-01-01`, `${y}-12-31`);
    case 'last_year': return r(`${y - 1}-01-01`, `${y - 1}-12-31`);
    case 'last_7_days': return r(addDaysISO(today, -6), today);
    case 'last_30_days': return r(addDaysISO(today, -29), today);
    case 'last_90_days': return r(addDaysISO(today, -89), today);
    case 'last_6_months': return r(monthSpan(y, m, -5)[0], today); // 5 previous calendar months + this month to date
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

/** Months a calendar-aligned period spans; rolling/custom periods are compared by equal day counts instead. */
const CALENDAR_MONTHS: Partial<Record<Period, number>> = {
  this_month: 1, last_month: 1, this_quarter: 3, last_quarter: 3, this_year: 12, last_year: 12, last_6_months: 6,
};

/** The comparable period immediately before `r`: previous month/quarter/year for calendar periods, else the preceding equal-length window. */
export function previousPeriod(r: DateRange): DateRange {
  const n = CALENDAR_MONTHS[r.kind];
  if (n) {
    const [y, m] = ymdParts(r.from);
    return mkRange(monthSpan(y, m, -n)[0], monthSpan(y, m, -1)[1], 'custom');
  }
  const p = previousWindow({ from: r.from, to: r.to });
  return mkRange(p.from, p.to, 'custom');
}

// ── Time series (trend) helpers — buckets follow generateBuckets (weeks start Monday) ──

const TRENDS = ['day', 'week', 'month'] as const;
const MAX_TREND_POINTS = 120;
/** IST wall-clock time of a `timestamp without time zone` column (stored in UTC, as Prisma writes it). */
const istTs = (col: string) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
/** SQL bucket key of a DATE or IST-local timestamp expression; matches generateBuckets labels. */
const bucketSql = (expr: string, g: Granularity) =>
  g === 'month' ? `to_char(${expr},'YYYY-MM')` : g === 'week' ? `to_char(date_trunc('week', ${expr}::timestamp),'YYYY-MM-DD')` : `to_char(${expr},'YYYY-MM-DD')`;

function resolveTrend(v: unknown, range: DateRange | null): { g: Granularity } | { error: string } | null {
  if (v === undefined || v === null || v === '' || v === 'none') return null;
  if (!(TRENDS as readonly string[]).includes(String(v))) return { error: 'trend must be none|day|week|month.' };
  if (!range) return { error: 'A period is required for a trend (e.g. last_6_months, this_year, last_30_days).' };
  const g = v as Granularity;
  if (generateBuckets(range.from, range.to, g).length > MAX_TREND_POINTS) {
    return { error: `Too many ${g} points for this period (max ${MAX_TREND_POINTS}); use a coarser trend or a shorter period.` };
  }
  return { g };
}

/**
 * Dense series over every bucket of the range. A missing bucket means NO events were
 * recorded in it, so counts/sums are a true 0; rates get `null` (left to the caller via `zero`).
 */
function fillSeries<T extends Record<string, number | null>>(range: DateRange, g: Granularity, rows: Array<{ bucket: string } & Partial<T>>, zero: T): Array<{ bucket: string } & T> {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return generateBuckets(range.from, range.to, g).map((b) => {
    const r = byKey.get(b.label) ?? {};
    const out = { bucket: b.label } as { bucket: string } & T;
    for (const k of Object.keys(zero) as Array<keyof T>) (out as any)[k] = (r as any)[k] ?? zero[k];
    return out;
  });
}
const trendDisplay = (title: string, g: Granularity, columns: string[], rows: Display['rows'], series: number[] = [1]): Display =>
  ({ title, columns: [g[0].toUpperCase() + g.slice(1), ...columns], rows, chart: 'line', chartValueIndex: series[0], chartSeries: series });
const pct1 = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

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

const breakdownDisplay = (title: string, label: string, rows: Array<{ label: string; count: number }>, chart: Display['chart'] = 'bar'): Display => ({
  title, columns: [label, 'Count'], rows: rows.map((r) => [r.label, r.count]),
  chartValueIndex: rows.length >= 2 ? 1 : undefined, chart,
});
/** How a result relates to time — stated on every analytics answer so history is never implied from today's rows. */
const DATA_TYPE = {
  snapshot: 'current snapshot (state of the records right now)',
  events: 'historical event count (records bucketed by the date the event happened)',
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// HR — employees (gate: hr.employees.view, as GET /hr/employees)
// ═════════════════════════════════════════════════════════════════════════════

async function employeeSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  if (!can(ctx, 'hr.employees.view')) return denied('employee information');
  const status = oneOf(a.status, ['active', 'all'] as const, 'active');
  const groupBy = oneOf(a.group_by, ['none', 'department', 'designation', 'employment_status'] as const, 'none');
  if (!status || !groupBy) return fail('invalid_arguments', 'status must be active|all; group_by must be none|department|designation|employment_status.');
  const joined = resolvePeriod({ period: a.joined_period ?? a.period, from: a.joined_from ?? a.from, to: a.joined_to ?? a.to });
  if (joined && 'error' in joined) return fail('invalid_arguments', joined.error);
  const trend = resolveTrend(a.trend, joined);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error.replace('A period', 'joined_period'));

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
    out.joined_in_period = { period: joined.label, count: j.n, data_type: DATA_TYPE.events };
    if (trend) {
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketSql('e.join_date::date', trend.g)} AS bucket, COUNT(*)::int AS joiners
         FROM employees e ${W ? W + ' AND' : 'WHERE'} e.join_date::date BETWEEN $${jp.length - 1}::date AND $${jp.length}::date GROUP BY 1`, ...jp);
      const series = fillSeries(joined, trend.g, rows, { joiners: 0 });
      out.joiners_trend = { granularity: trend.g, data_type: DATA_TYPE.events, points: series };
      out.trend_limitations = 'Headcount over time is NOT available: there are no historical headcount snapshots and employees removed in HR leave no record, so past headcounts cannot be reconstructed from today\'s table.';
      displays.push(trendDisplay(`Employees joined per ${trend.g} (${joined.label})`, trend.g, ['Joiners'], series.map((p) => [p.bucket, p.joiners])));
    }
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
    displays.push(breakdownDisplay(`Employees by ${groupBy.replace('_', ' ')} (${what})`, groupBy === 'employment_status' ? 'Status' : groupBy[0].toUpperCase() + groupBy.slice(1), rows, groupBy === 'employment_status' ? 'pie' : 'bar'));
  }
  out.data_type = DATA_TYPE.snapshot;
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
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);
  const status = oneOf(a.status, ['all', 'pending', 'approved', 'rejected'] as const, 'all');
  const groupBy = oneOf(a.group_by, ['none', 'status', 'leave_type', 'department'] as const, 'none');
  if (!status || !groupBy) return fail('invalid_arguments', 'status must be all|pending|approved|rejected; group_by must be none|status|leave_type|department.');

  const where: string[] = []; const params: unknown[] = [];
  const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  const scopeOnly = () => ({ where: where.slice(0, scopeN), params: params.slice(0, scopeP) }); // conditions before the date filter
  let scopeN = 0, scopeP = 0;
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
  scopeN = where.length; scopeP = params.length;
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
    data_type: DATA_TYPE.events,
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
    displays.push(breakdownDisplay(`Leave requests by ${groupBy.replace('_', ' ')}${status !== 'all' ? ` (${status})` : ''}`, groupBy === 'leave_type' ? 'Leave type' : groupBy[0].toUpperCase() + groupBy.slice(1), rows, groupBy === 'status' ? 'pie' : 'bar'));
  }

  if (trend && range) {
    // Trend = requests by START date (one event per request), unlike the overlap-based totals above.
    const s = scopeOnly();
    const tp = [...s.params, range.from, range.to];
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT ${bucketSql('l.start_date::date', trend.g)} AS bucket, COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE l.status = 'approved')::int AS approved,
         COUNT(*) FILTER (WHERE l.status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE l.status = 'rejected')::int AS rejected,
         COALESCE(SUM(l.days) FILTER (WHERE l.status = 'approved'),0)::int AS approved_days
       ${base} WHERE ${[...s.where, `l.start_date::date BETWEEN $${tp.length - 1}::date AND $${tp.length}::date`].join(' AND ')} GROUP BY 1`, ...tp);
    const series = fillSeries(range, trend.g, rows, { requests: 0, approved: 0, pending: 0, rejected: 0, approved_days: 0 });
    out.trend = { granularity: trend.g, counts: 'leave requests by their start date (current status)', data_type: DATA_TYPE.events, points: series };
    displays.push(trendDisplay(`Leave requests per ${trend.g} (${range.label})`, trend.g, ['Requests', 'Approved', 'Pending', 'Rejected', 'Approved days'],
      series.map((p) => [p.bucket, p.requests, p.approved, p.pending, p.rejected, p.approved_days]), [2, 3, 4]));
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
  const clamped = mkRange(range.from, to, range.kind);
  const trend = resolveTrend(a.trend, clamped);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);

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
    data_type: `${DATA_TYPE.events}; working days and absences are computed against the CURRENT active roster (employees who have since left are not counted)`,
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
  if (trend) {
    // Same HR attendance analytics trend the Attendance dashboard draws (own-scope: this employee only).
    const t = await computeAttendanceTrend(f, { granularity: trend.g });
    const points = t.points.map((p) => ({ bucket: p.label, present: p.present, late: p.late, absent: p.absent, leave: p.leave, attendance_percent: p.attendancePct }));
    out.trend = { granularity: trend.g, data_type: DATA_TYPE.events, points };
    displays.push(trendDisplay(`Attendance per ${trend.g} (${from_to_label(range.from, to)})`, trend.g, ['Present', 'Late', 'Absent', 'Leave', 'Attendance %'],
      points.map((p) => [p.bucket, p.present, p.late, p.absent, p.leave, p.attendance_percent]), [5]));
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
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
/** Bucket label of an IST day, matching generateBuckets (month = YYYY-MM, week = its Monday). */
const bucketOf = (ymd: string, g: Granularity) =>
  g === 'month' ? ymd.slice(0, 7) : g === 'week' ? addDaysISO(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7)) : ymd;

async function taskSummary(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const orgScope = can(ctx, 'mytasks.dashboard.view');
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);
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
    period: range ? range.label : 'none (current counts only)',
    current: { ...current, data_type: DATA_TYPE.snapshot },
    definitions: {
      completed: "status 'done' or 'approved'",
      overdue: "due date before today, not completed, and not in 'waiting'",
      statuses: 'todo, in_progress, waiting, done, approved',
    },
  };
  const displays: Display[] = [];

  if (range) {
    const fromD = startOfDay(range.from), toD = endOfDay(range.to);
    const ids = scoped.map((t) => t.id);
    // First transition into done/approved = completion time (the Task Dashboard's rule; there is no completion column).
    const acts = ids.length
      ? await prisma.my_task_activities.findMany({
          where: { task_id: { in: ids }, action: { contains: '→' } },
          select: { task_id: true, action: true, created_at: true }, orderBy: { created_at: 'asc' },
        })
      : [];
    const completedAt = new Map<number, Date>();
    for (const x of acts) {
      const s = x.action.toLowerCase();
      if ((s.includes('→ done') || s.includes('→ approved')) && !completedAt.has(x.task_id)) completedAt.set(x.task_id, x.created_at);
    }
    const completedIn = (t: (typeof tasks)[number], f: Date, l: Date) => { const c = completedAt.get(t.id); return !!c && c >= f && c <= l && done(t); };
    out.in_period = {
      period: range.label,
      created: scoped.filter((t) => t.created_at >= fromD && t.created_at <= toD).length,
      completed: scoped.filter((t) => completedIn(t, fromD, toD)).length,
      due: scoped.filter((t) => { const d = ymdUTC(t.due_date); return !!d && d >= range.from && d <= range.to; }).length,
      data_type: DATA_TYPE.events,
      completed_note: 'Completion time is reconstructed from the task activity log (first change to Done/Approved; no completion date column); tasks completed before activity logging existed are not counted.',
    };
    if (trend) {
      const g = trend.g;
      const rows = new Map<string, { created: number; completed: number; due: number; missed_due: number }>();
      const at = (k: string) => rows.get(k) ?? (rows.set(k, { created: 0, completed: 0, due: 0, missed_due: 0 }).get(k)!);
      for (const t of scoped) {
        const cd = istDay(t.created_at);
        if (cd >= range.from && cd <= range.to) at(bucketOf(cd, g)).created++;
        const c = completedAt.get(t.id);
        if (c && done(t)) { const d = istDay(c); if (d >= range.from && d <= range.to) at(bucketOf(d, g)).completed++; }
        const due = ymdUTC(t.due_date);
        if (due && due >= range.from && due <= range.to) {
          const b = at(bucketOf(due, g)); b.due++;
          // Missed = not completed by its due date: completed after it, or still open past it (no 'waiting' exemption here).
          const fin = c && done(t) ? c : null;
          if (fin ? istDay(fin) > due : due < today && !done(t)) b.missed_due++;
        }
      }
      const series = fillSeries(range, g, [...rows.entries()].map(([bucket, v]) => ({ bucket, ...v })), { created: 0, completed: 0, due: 0, missed_due: 0 });
      out.trend = {
        granularity: g, data_type: DATA_TYPE.events, points: series,
        definitions: { created: 'tasks created in the bucket', completed: 'tasks whose first Done/Approved change happened in the bucket (and are still completed)', due: 'tasks due in the bucket', missed_due: 'of those due, not completed by the due date (still open, or completed after it)' },
        limitations: 'An "overdue count at a past date" is not available (overdue is a current state); missed_due is the historical equivalent based on due dates.',
      };
      displays.push(trendDisplay(`Tasks per ${g} (${range.label})`, g, ['Created', 'Completed', 'Due', 'Missed due date'],
        series.map((p) => [p.bucket, p.created, p.completed, p.due, p.missed_due]), [1, 2, 4]));
    }
  }

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
      chart: groupBy === 'status' ? 'pie' : 'bar',
      chartSeries: groupBy === 'status' || groupBy === 'priority' ? [1] : [2, 3, 4],
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
  const range = resolvePeriod(a);
  if (range && 'error' in range) return fail('invalid_arguments', range.error);
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);

  const where: any = {};
  if (!allProjects) where.project_members = { some: { user_id: ctx.userId } };
  if (nameIn) where.name = { contains: nameIn, mode: 'insensitive' };
  const projects = await prisma.projects.findMany({
    where, select: { id: true, name: true, status: true, is_archived: true, category: true, createdAt: true },
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
    data_type: DATA_TYPE.snapshot,
  };
  const displays: Display[] = [];
  if (!statusFilter && statusRows.length) displays.push(breakdownDisplay('Projects by status', 'Status', statusRows, 'pie'));
  if (range) {
    const createdDay = (p: { createdAt: Date | null }) => (p.createdAt ? istDay(p.createdAt) : null);
    const inRange = selected.filter((p) => { const d = createdDay(p); return !!d && d >= range.from && d <= range.to; });
    out.created_in_period = { period: range.label, count: inRange.length, data_type: DATA_TYPE.events };
    out.trend_limitations = 'Project completion over time is NOT available: projects have no completion date and status changes are not timestamped, so "completed per month" cannot be derived from today\'s statuses.';
    if (trend) {
      const counts = new Map<string, number>();
      for (const p of inRange) { const k = bucketOf(createdDay(p)!, trend.g); counts.set(k, (counts.get(k) ?? 0) + 1); }
      const series = fillSeries(range, trend.g, [...counts.entries()].map(([bucket, created]) => ({ bucket, created })), { created: 0 });
      out.trend = { granularity: trend.g, counts: 'projects created (by creation date)', data_type: DATA_TYPE.events, points: series };
      displays.push(trendDisplay(`Projects created per ${trend.g} (${range.label})`, trend.g, ['Created'], series.map((p) => [p.bucket, p.created])));
    }
  }

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
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);

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
    data_type: `${DATA_TYPE.snapshot} of the opportunities created in the period (their stage/status as of today)`,
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

  if (trend && range) {
    const g = trend.g;
    const owners = scope === undefined ? null : typeof scope === 'number' ? [scope] : scope.in;
    const own = owners ? ` AND l."ownerId" = ANY($3::int[])` : '';
    const p: unknown[] = [startOfDay(range.from).toISOString(), endOfDay(range.to).toISOString(), ...(owners ? [owners] : [])];
    const [created, won] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketSql(istTs('l."createdAt"'), g)} AS bucket, COUNT(*)::int AS created,
                COUNT(*) FILTER (WHERE UPPER(l.stage) = 'WON')::int AS now_won,
                COUNT(*) FILTER (WHERE LOWER(l.status) = 'converted')::int AS now_converted
         FROM "Lead" l WHERE l."createdAt" >= $1::timestamp AND l."createdAt" <= $2::timestamp${own} GROUP BY 1`, ...p),
      // WON revenue by the RECORDED WON transition (stage_changed → WON in the activity log); never by updatedAt.
      prisma.$queryRawUnsafe<any[]>(
        `WITH w AS (
           SELECT l.id, COALESCE(l.lead_value, 0)::float8 AS value, MAX(a.created_at) AS won_at
           FROM "Lead" l
           LEFT JOIN activity_logs a ON a.lead_id = l.id AND a.type = 'stage_changed' AND UPPER(a.metadata->>'toStage') = 'WON'
           WHERE UPPER(l.stage) = 'WON'${own} GROUP BY l.id)
         SELECT CASE WHEN won_at IS NULL THEN NULL ELSE ${bucketSql(istTs('won_at'), g)} END AS bucket,
                COUNT(*)::int AS won, COALESCE(SUM(value), 0)::float8 AS won_revenue
         FROM w WHERE won_at IS NULL OR (won_at >= $1::timestamp AND won_at <= $2::timestamp) GROUP BY 1`, ...p),
    ]);
    const cohort = fillSeries(range, g, created, { created: 0, now_won: 0, now_converted: 0 })
      .map((x) => ({ ...x, won_rate_percent: pct1(x.now_won, x.created), conversion_rate_percent: pct1(x.now_converted, x.created) }));
    const undated = won.find((w) => w.bucket === null);
    const wonSeries = fillSeries(range, g, won.filter((w) => w.bucket !== null), { won: 0, won_revenue: 0 });
    out.trend = {
      granularity: g,
      leads_created: { data_type: `${DATA_TYPE.events} (creation date); now_won/now_converted = how many of that cohort are WON/converted TODAY (cohort conversion, not the date they converted)`, points: cohort },
      won_revenue: {
        data_type: `${DATA_TYPE.events} (date the opportunity was moved to WON, from the activity log)`, points: wonSeries,
        won_without_recorded_won_date: undated ? { count: undated.won, revenue: money2(undated.won_revenue), note: 'WON opportunities with no stage-change record cannot be placed on the timeline and are excluded from the series.' } : null,
      },
    };
    displays.push(trendDisplay(`Opportunities created per ${g} (${range.label})`, g, ['Created', 'Now WON', 'Now converted', 'Won %', 'Conversion %'],
      cohort.map((x) => [x.bucket, x.created, x.now_won, x.now_converted, x.won_rate_percent, x.conversion_rate_percent]), [1, 2, 3]));
    displays.push(trendDisplay(`WON revenue per ${g} by WON date (${range.label})`, g, ['Won', 'Won revenue (INR)'],
      wonSeries.map((x) => [x.bucket, x.won, money2(x.won_revenue)]), [2]));
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
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);
  const groupBy = oneOf(a.group_by, ['none', 'category', 'payment_status', 'approval_status', 'month'] as const, 'none');
  if (!groupBy) return fail('invalid_arguments', 'group_by must be none|category|payment_status|approval_status|month.');

  const params: unknown[] = range ? [range.from, range.to] : [];
  const expW = range ? `WHERE expense_date::date BETWEEN $1::date AND $2::date` : '';
  const out: Record<string, unknown> = {
    ok: true, scope: 'organization', currency: 'INR',
    period: range ? range.label : 'all time (no date filter)',
    data_type: `${DATA_TYPE.events} (expense/income dates)`,
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
        chart: groupBy === 'month' ? 'line' : groupBy === 'category' ? 'bar' : 'pie',
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
  if (canExp && canInc) {
    out.net = money2(num((out.income as any).total) - num((out.expenses as any).total_all_records));
  }

  if (trend && range) {
    const g = trend.g;
    const exp = canExp ? fillSeries(range, g, await prisma.$queryRawUnsafe<any[]>(
      `SELECT ${bucketSql('expense_date::date', g)} AS bucket, COUNT(*)::int AS records, COALESCE(SUM(amount),0)::float8 AS amount,
              COALESCE(SUM(amount) FILTER (WHERE approval_status = 'approved'),0)::float8 AS approved,
              COALESCE(SUM(amount) FILTER (WHERE approval_status = 'pending'),0)::float8 AS pending_approval
       FROM finance_expense ${expW} GROUP BY 1`, ...params), { records: 0, amount: 0, approved: 0, pending_approval: 0 }) : null;
    const inc = canInc ? fillSeries(range, g, await prisma.$queryRawUnsafe<any[]>(
      `SELECT ${bucketSql('income_date::date', g)} AS bucket, COUNT(*)::int AS records, COALESCE(SUM(amount),0)::float8 AS amount
       FROM finance_income WHERE income_date::date BETWEEN $1::date AND $2::date GROUP BY 1`, ...params), { records: 0, amount: 0 }) : null;
    const points = (exp ?? inc)!.map((_, i) => ({
      bucket: (exp ?? inc)![i].bucket,
      ...(exp ? { expenses: money2(exp[i].amount), expense_records: exp[i].records, approved_expenses: money2(exp[i].approved), expenses_awaiting_approval: money2(exp[i].pending_approval) } : {}),
      ...(inc ? { income: money2(inc[i].amount), income_records: inc[i].records } : {}),
      ...(exp && inc ? { net: money2(inc[i].amount - exp[i].amount) } : {}),
    }));
    out.trend = { granularity: g, data_type: DATA_TYPE.events, points };
    const cols = [...(exp ? ['Expenses (INR)', 'Approved expenses (INR)', 'Awaiting approval (INR)'] : []), ...(inc ? ['Income (INR)'] : [])];
    const series = exp && inc ? [1, 4] : [1];
    displays.push(trendDisplay(`Finance per ${g} (${range.label})`, g, cols, points.map((p: any) => [
      p.bucket, ...(exp ? [p.expenses, p.approved_expenses, p.expenses_awaiting_approval] : []), ...(inc ? [p.income] : [])]), series));
  }

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
  const trend = resolveTrend(a.trend, range);
  if (trend && 'error' in trend) return fail('invalid_arguments', trend.error);
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
      title: 'Ad campaigns (top by spend)', columns: ['Campaign', 'Platform', 'Start', 'End', 'Budget (INR)', 'Spend (INR)', 'Leads'],
      rows: top.map((c) => [c.name, c.platform, c.start_date, c.end_date, money2(c.budget), money2(c.spend), c.leads]),
      chartValueIndex: top.length >= 2 ? 5 : undefined, chart: 'bar',
    });
    if (trend && range) {
      const g = trend.g;
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketSql('start_date', g)} AS bucket, COUNT(*)::int AS campaigns, COALESCE(SUM(budget),0)::float8 AS budget,
                COALESCE(SUM(spend),0)::float8 AS spend, COALESCE(SUM(leads),0)::float8 AS leads
         FROM marketing_ad_campaigns WHERE start_date BETWEEN $1::date AND $2::date GROUP BY 1`, range.from, range.to);
      const series = fillSeries(range, g, rows, { campaigns: 0, budget: 0, spend: 0, leads: 0 }).map((x) => ({ ...x, budget: money2(x.budget), spend: money2(x.spend) }));
      (out.ad_campaigns as any).trend = {
        granularity: g, points: series,
        data_type: `${DATA_TYPE.events} (campaign START date); spend/budget/leads are each campaign's recorded totals — there is no daily spend history, so this is not a daily burn rate`,
      };
      displays.push(trendDisplay(`Ad campaigns started per ${g} (${range.label})`, g, ['Campaigns', 'Budget (INR)', 'Spend (INR)', 'Leads'],
        series.map((x) => [x.bucket, x.campaigns, x.budget, x.spend, x.leads]), [3]));
    }
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
    if (trend && range) {
      const g = trend.g;
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketSql('expense_date::date', g)} AS bucket,
                COALESCE(SUM(amount) FILTER (WHERE approval_status = 'approved'),0)::float8 AS approved,
                COUNT(*) FILTER (WHERE approval_status = 'approved')::int AS approved_count,
                COALESCE(SUM(amount) FILTER (WHERE approval_status = 'pending'),0)::float8 AS pending_approval,
                COUNT(*) FILTER (WHERE approval_status = 'pending')::int AS pending_count
         FROM finance_expense ${W} GROUP BY 1`, ...p);
      const series = fillSeries(range, g, rows, { approved: 0, approved_count: 0, pending_approval: 0, pending_count: 0 })
        .map((x) => ({ ...x, approved: money2(x.approved), pending_approval: money2(x.pending_approval) }));
      (out.marketing_expenses as any).trend = { granularity: g, data_type: `${DATA_TYPE.events} (expense date)`, points: series };
      displays.push(trendDisplay(`Marketing expenses per ${g} (${range.label})`, g, ['Approved (INR)', 'Approved count', 'Awaiting approval (INR)', 'Awaiting count'],
        series.map((x) => [x.bucket, x.approved, x.approved_count, x.pending_approval, x.pending_count]), [1, 3]));
    }
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
// Period comparison — runs ONE of the period-taking tools for the requested period
// and for the comparable previous period, then diffs the numbers server-side. The
// inner tool does every permission/scope check exactly as when called directly.
// ═════════════════════════════════════════════════════════════════════════════

const COMPARABLE = ['get_leave_summary', 'get_attendance_summary', 'get_task_summary', 'get_sales_summary', 'get_finance_summary', 'get_marketing_summary'] as const;
/** Result keys that describe the state NOW (not the period) — comparing them would fake history. */
const SNAPSHOT_KEYS: Record<string, string[]> = {
  get_task_summary: ['current', 'breakdown'],
  get_marketing_summary: ['content_approvals', 'ad_campaigns.running_today', 'ad_campaigns.top_by_spend'],
  get_leave_summary: ['employees'],
  get_sales_summary: ['by_owner_top10_by_won_revenue'],
};
const NON_METRIC_KEYS = new Set(['as_of', 'as_of_date', 'period', 'scope', 'definitions', 'notes', 'note', 'filters', 'rounding', 'currency', 'data_type', 'trend', 'truncated', 'granularity', 'points', 'completed_note', 'metrics_note', 'running_definition', 'period_filter']);
const isPercentMetric = (path: string) => /(percent|_pct|rate)$/i.test(path);

/** Every finite number in a tool result, keyed by its dotted path (array items keyed by their first text field). */
function numericLeaves(v: unknown, skip: string[], path = '', out = new Map<string, number>()): Map<string, number> {
  if (typeof v === 'number') { if (Number.isFinite(v)) out.set(path, v); return out; }
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      const label = Object.values(item).find((x): x is string => typeof x === 'string');
      if (label) numericLeaves(item, skip, `${path}.${label}`, out);
    }
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (NON_METRIC_KEYS.has(k)) continue;
      const p = path ? `${path}.${k}` : k;
      if (skip.some((s) => p === s || p.startsWith(`${s}.`))) continue;
      numericLeaves(val, skip, p, out);
    }
  }
  return out;
}
const metricLabel = (path: string) => path.replace(/\.rows\./g, ': ').replace(/\./g, ' › ').replace(/_/g, ' ');

async function comparePeriods(ctx: SalesAuthContext, a: Args): Promise<ToolOutcome> {
  const tool = oneOf(a.tool, COMPARABLE, null as never);
  if (!tool) return fail('invalid_arguments', `tool must be one of: ${COMPARABLE.join(', ')}.`);
  const cur = resolvePeriod(a);
  if (!cur) return fail('invalid_arguments', 'period is required for a comparison (e.g. this_month, this_quarter, last_30_days, or custom with from/to).');
  if ('error' in cur) return fail('invalid_arguments', cur.error);
  let prev: DateRange;
  if (a.previous_from !== undefined || a.previous_to !== undefined) {
    const p = resolvePeriod({ period: 'custom', from: a.previous_from, to: a.previous_to });
    if (!p || 'error' in p) return fail('invalid_arguments', `previous period: ${p && 'error' in p ? p.error : 'needs previous_from and previous_to (YYYY-MM-DD).'}`);
    if (p.to >= cur.from && p.from <= cur.to) return fail('invalid_arguments', 'The two periods overlap; choose non-overlapping ranges.');
    prev = p;
  } else prev = previousPeriod(cur);

  const OWN = ['tool', 'period', 'from', 'to', 'previous_from', 'previous_to', 'trend'];
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !OWN.includes(k)));
  const run = (r: DateRange) => TOOLS[tool].run(ctx, { ...rest, period: 'custom', from: r.from, to: r.to });
  const [c, p] = await Promise.all([run(cur), run(prev)]);
  if (c.forModel.ok === false) return c; // permission_denied / invalid_arguments propagate unchanged
  if (p.forModel.ok === false) return p;
  if (typeof c.forModel.period === 'string' && /all time/i.test(c.forModel.period)) {
    return fail('not_available', 'This user can only see all-time totals for this module, so a period comparison is not available to them.');
  }

  const skip = SNAPSHOT_KEYS[tool] ?? [];
  const cm = numericLeaves(c.forModel, skip), pm = numericLeaves(p.forModel, skip);
  const paths = [...new Set([...cm.keys(), ...pm.keys()])];
  const rows = paths.map((path) => {
    const curV = cm.get(path), prevV = pm.get(path);
    // A metric missing on one side is NOT zero (e.g. a category with no records that period).
    const change = curV !== undefined && prevV !== undefined ? Math.round((curV - prevV) * 100) / 100 : null;
    const pctChange = change === null || isPercentMetric(path) ? null
      : prevV === 0 ? null : Math.round(((curV! - prevV!) / Math.abs(prevV!)) * 1000) / 10;
    return {
      metric: metricLabel(path), current: curV ?? null, previous: prevV ?? null,
      change: change === null ? null : isPercentMetric(path) ? `${change > 0 ? '+' : ''}${change} pp` : change,
      change_percent: pctChange,
      direction: change === null ? 'not comparable' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      ...(change !== null && prevV === 0 && !isPercentMetric(path) ? { baseline_note: curV === 0 ? 'both periods are 0' : 'no percentage: previous period was 0' } : {}),
    };
  });

  const today = todayIST();
  const notes: string[] = [];
  if (cur.to > today) notes.push(`The current period is still in progress: ${daysBetweenInclusive(cur.from, today)} of ${cur.days} days have elapsed (data through ${today}).`);
  if (cur.days !== prev.days) notes.push(`The periods differ in length (${cur.days} vs ${prev.days} days); compare totals with that in mind.`);
  notes.push('Change % = (current − previous) ÷ |previous| × 100, rounded to 1 decimal; percentage metrics show the difference in percentage points (pp). Snapshot-only figures (e.g. tasks currently open) are not compared because their past values are not recorded.');

  const cell = (v: number | string | null) => (v === null ? null : v);
  const display: Display = {
    title: `${tool.replace('get_', '').replace('_summary', '')}: ${cur.label} vs ${prev.label}`,
    columns: ['Metric', `Current (${cur.label})`, `Previous (${prev.label})`, 'Change', 'Change %'],
    rows: rows.map((r) => [r.metric, cell(r.current), cell(r.previous), cell(r.change), r.change_percent === null ? (r.baseline_note ? 'n/a' : null) : r.change_percent]),
  };
  // Grouped breakdown (group_by) as current-vs-previous bars: one value per group — amount if present, else count.
  const displays: Display[] = [display];
  const groupedPaths = paths.filter((p) => p.includes('.rows.'));
  const valueKeys = [...new Set(groupedPaths.map((p) => p.split('.').pop()!))];
  const key = valueKeys.find((k) => k === 'amount') ?? valueKeys.find((k) => k === 'count') ?? valueKeys[0];
  if (key) {
    const groups = groupedPaths.filter((p) => p.endsWith(`.${key}`)).map((p) => [p.split('.rows.')[1].slice(0, -(key.length + 1)), cm.get(p) ?? null, pm.get(p) ?? null] as Display['rows'][number]);
    if (groups.length >= 2) displays.push({ title: `${display.title} — by group (${key.replace(/_/g, ' ')})`, columns: ['Group', 'Current', 'Previous'], rows: groups, chart: 'bar', chartValueIndex: 1, chartSeries: [1, 2] });
  }
  return {
    forModel: {
      ok: true, tool, current_period: { ...cur, kind: undefined }, previous_period: { ...prev, kind: undefined },
      scope: c.forModel.scope, data_type: c.forModel.data_type, definitions: c.forModel.definitions, notes: [...notes, ...(Array.isArray(c.forModel.notes) ? c.forModel.notes : [])],
      comparison: rows,
    },
    displays,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Registry — the ONLY functions the model can reach
// ═════════════════════════════════════════════════════════════════════════════

const PERIOD_PROPS = {
  period: { type: 'string', enum: [...PERIODS, 'all_time'], description: 'Date range, resolved by the server in Asia/Kolkata. Weeks start Monday; quarters are calendar quarters; last_N_days include today; last_6_months = the 5 previous calendar months plus this month to date. Use custom with from/to for explicit dates (both inclusive).' },
  from: { type: 'string', description: 'YYYY-MM-DD, only with period=custom' },
  to: { type: 'string', description: 'YYYY-MM-DD, only with period=custom' },
};
const TREND_PROP = {
  trend: { type: 'string', enum: ['none', 'day', 'week', 'month'], description: 'Add a time series over the period (needs a period): day for up to ~6 weeks, week for 1–4 months, month for longer. Rendered as a line chart.' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS: Record<string, { spec: ToolSpec; run: (ctx: SalesAuthContext, a: Args) => Promise<ToolOutcome> }> = {
  get_employee_summary: {
    spec: { name: 'get_employee_summary', description: 'HR employee headcount: total/active employee records, employment-status breakdown, optional breakdown by department/designation, how many joined in a period, and a joiners-over-time trend. Aggregates only — never personal details. Headcount history is not available (no snapshots).',
      parameters: obj({
        status: { type: 'string', enum: ['active', 'all'], description: 'Which records the group_by breakdown counts. Default active.' },
        department: { type: 'string', description: 'Restrict to one department' },
        group_by: { type: 'string', enum: ['none', 'department', 'designation', 'employment_status'] },
        joined_period: { type: 'string', enum: [...PERIODS], description: 'Count employees whose join date falls in this period' },
        joined_from: { type: 'string' }, joined_to: { type: 'string' },
        trend: { ...TREND_PROP.trend, description: 'Joiners per day/week/month over joined_period.' },
      }) },
    run: employeeSummary,
  },
  get_leave_summary: {
    spec: { name: 'get_leave_summary', description: 'Leave requests: counts by status (pending/approved/rejected), distinct employees on approved leave, optional breakdown, optional list of employees on leave, optional trend of requests by start date. Use period=today for "who is on leave today". Omit period for all-time totals (e.g. currently pending requests).',
      parameters: obj({
        ...PERIOD_PROPS, ...TREND_PROP,
        status: { type: 'string', enum: ['all', 'pending', 'approved', 'rejected'], description: 'Filter for breakdown/list. Default all (list defaults to approved).' },
        department: { type: 'string' },
        group_by: { type: 'string', enum: ['none', 'status', 'leave_type', 'department'] },
        list_employees: { type: 'boolean', description: 'Include up to 25 employees on leave (names, department, dates)' },
      }) },
    run: leaveSummary,
  },
  get_attendance_summary: {
    spec: { name: 'get_attendance_summary', description: 'Attendance for a period using the HR attendance analytics rules: present (incl. late), late, absent, leave, attendance %, optional department breakdown, optional daily/weekly/monthly trend. Users without HR attendance access get only their own attendance.',
      parameters: obj({ ...PERIOD_PROPS, ...TREND_PROP, department: { type: 'string' }, group_by: { type: 'string', enum: ['none', 'department'] } }, ['period']) },
    run: attendanceSummary,
  },
  get_task_summary: {
    spec: { name: 'get_task_summary', description: 'Tasks from the My Tasks module: total, open, overdue, due today, completed (current snapshot); tasks created/completed/due in a period; optional trend (created, completed, due, missed due date per bucket); optional filter by assignee name or department; optional breakdown by status/priority/assignee/department. Users without the Task Dashboard permission only see tasks they created or are a member of.',
      parameters: obj({
        ...PERIOD_PROPS, ...TREND_PROP,
        assignee_name: { type: 'string', description: 'Employee/user name to filter tasks assigned to them' },
        department: { type: 'string' },
        group_by: { type: 'string', enum: ['none', 'status', 'priority', 'assignee', 'department'] },
      }) },
    run: taskSummary,
  },
  get_project_summary: {
    spec: { name: 'get_project_summary', description: 'Development projects: counts by status (active, completed, on-hold, …), optional list filtered by status or name, optional project-wise Kanban task summary (total/done/open/overdue), projects created in a period and a created-per-bucket trend. Completion-over-time is not available (no completion dates). Non-admins only see projects they are a member of.',
      parameters: obj({
        ...PERIOD_PROPS, ...TREND_PROP,
        status: { type: 'string', description: 'Filter by status, e.g. active, completed, on-hold, delayed, planning, cancelled' },
        project_name: { type: 'string' },
        include_archived: { type: 'boolean' },
        include_task_summary: { type: 'boolean' },
      }) },
    run: projectSummary,
  },
  get_sales_summary: {
    spec: { name: 'get_sales_summary', description: 'Sales pipeline/opportunities (leads): totals, value, stage funnel (NQL→WON, HOLD, LOST), won revenue, converted count and conversion rate, target achievement, top owners; optional trend of opportunities created per bucket (with cohort won/conversion %) and WON revenue by WON date. A period filters opportunities by CREATION date. Lead visibility follows the user\'s own/all-leads permission.',
      parameters: obj({ ...PERIOD_PROPS, ...TREND_PROP }) },
    run: salesSummary,
  },
  get_finance_summary: {
    spec: { name: 'get_finance_summary', description: 'Finance: expense totals (with payment status and approval status splits), income totals and net for a period; optional expense breakdown by category, payment status, approval status or month; optional expenses/income trend per day/week/month.',
      parameters: obj({ ...PERIOD_PROPS, ...TREND_PROP, group_by: { type: 'string', enum: ['none', 'category', 'payment_status', 'approval_status', 'month'] } }) },
    run: financeSummary,
  },
  get_marketing_summary: {
    spec: { name: 'get_marketing_summary', description: 'Marketing: ad campaigns (count, running today, budget/spend/leads/revenue, CPL/CPC/CTR/ROI, top campaigns by spend), marketing expenses (approved/pending/rejected, by category) and pending approvals (expenses awaiting approval, content in review); optional trend of campaigns started and marketing expenses per bucket.',
      parameters: obj({ ...PERIOD_PROPS, ...TREND_PROP }) },
    run: marketingSummary,
  },
  compare_periods: {
    spec: { name: 'compare_periods', description: 'Compare one summary tool\'s period-bound metrics between a period and the comparable previous period (this_month vs last month, this_quarter vs last quarter, this_year vs last year, last_30_days vs the 30 days before, or two custom ranges via previous_from/previous_to). Absolute and % change are computed server-side. Use this ONE call for "vs", "compared to", "increase/decrease", "better/worse than". Pass the inner tool\'s filters (department, group_by, status, assignee_name) to compare breakdowns too.',
      parameters: obj({
        tool: { type: 'string', enum: [...COMPARABLE], description: 'Which summary to compare' },
        ...PERIOD_PROPS,
        previous_from: { type: 'string', description: 'YYYY-MM-DD; with previous_to, an explicit previous range instead of the automatic one' },
        previous_to: { type: 'string' },
        department: { type: 'string' }, group_by: { type: 'string' }, status: { type: 'string' }, assignee_name: { type: 'string' },
      }, ['tool', 'period']) },
    run: comparePeriods,
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
  // Phase 2 — analytics starters (same gates as the tools that answer them).
  if (can(ctx, 'hr.attendance.view') || can(ctx, 'hr.analytics.view')) out.push('Show monthly attendance trends for the last 6 months');
  out.push('Department-wise task performance', 'Compare task completion this month with last month');
  if (can(ctx, 'sales.leads.view')) out.push('Sales conversion trends over the last 6 months');
  if (can(ctx, 'finance.expenses.view')) out.push("Compare this month's expenses with last month");
  return out;
}
