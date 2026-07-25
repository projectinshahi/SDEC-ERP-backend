import prisma from '../config/db.js';
import { PAYROLL_CONFIG } from '../config/payroll.config.js';

/**
 * Attendance Analytics — service layer (Phase 1, Milestones 2 & 3.1).
 *
 * Single source of attendance metric math (mirrors the Sales analytics.service
 * pattern). Controllers stay thin; all aggregation is date-bounded raw SQL that
 * scales to 10k+ employees.
 *
 * MODULARITY / REUSE: the reusable core is exported so future modules (a full
 * Employee Profile spanning Attendance/Leave/Payroll/Performance/Documents) can
 * reuse it without duplicating SQL:
 *   • STATUS_COUNT_SELECT  — one shared status-count SELECT fragment
 *   • aggregateByEmployee  — per-employee status aggregation (report / rankings / profile)
 *   • computeAttendanceMetrics — one metric formula set (attendance %, absenteeism,
 *     punctuality, LOP/Payable) reused by every surface
 *
 * DATA MODEL: attendance is recorded MANUALLY as a daily STATUS (present | late |
 *   late_after_lunch | leave_half_day | leave_full_day | absent). No biometric
 *   punch device, so timestamp-derived metrics (late minutes, overtime, work
 *   hours) are intentionally EXCLUDED. Only status/calendar/leave data is used.
 *
 * COMPANY CALENDAR: Monday–Saturday working, Sunday weekly-off — via the
 *   `WorkingCalendar` abstraction. A future `holidays` table plugs in through the
 *   `holidays` Set with no contract change.
 *
 * TIMEZONE: every date is a calendar date (YYYY-MM-DD), computed in Asia/Kolkata.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Response DTOs
// ═════════════════════════════════════════════════════════════════════════════

export interface Range {
  from: string;
  to: string;
  days: number;
}

export interface AttendanceFilters {
  from: string; // YYYY-MM-DD (inclusive)
  to: string; // YYYY-MM-DD (inclusive)
  department?: string;
  employeeId?: number;
}

/** Raw status counts for a group (period/department/employee). Reusable DTO. */
export interface StatusCounts {
  presentFull: number; // present + late + late_after_lunch
  lateCount: number; // late + late_after_lunch
  halfDay: number; // leave_half_day
  fullLeave: number; // leave_full_day
  totalRows: number; // all attendance rows in the group
}

/**
 * Computed attendance metrics for a group. Reused everywhere so the formulas live
 * in ONE place. `lopDays` / `payableDays` are Estimated for Payroll Reference
 * (attendance-derived; not an authoritative payroll figure).
 */
export interface AttendanceMetrics {
  present: number;
  late: number;
  halfDay: number;
  fullDayLeave: number;
  absent: number;
  workingDays: number;
  approvedLeaveDays: number;
  attendancePct: number;
  absenteeismPct: number;
  punctualityPct: number;
  lopDays: number; // Estimated for Payroll Reference
  payableDays: number; // Estimated for Payroll Reference
}

export interface AnalyticsSummary {
  totalEmployees: number;
  present: number;
  late: number;
  halfDay: number;
  fullDayLeave: number;
  absent: number;
  workingDays: number;
  approvedLeaveDays: number;
  attendancePct: number;
  range: Range;
}

export interface StatusDistributionSegment {
  status: string;
  label: string;
  count: number;
  pct: number;
}
export interface StatusDistribution {
  total: number;
  segments: StatusDistributionSegment[];
  range: Range;
}

/** Per-employee aggregate row (reusable across report / rankings / profile). */
export interface EmployeeStatusRow extends StatusCounts {
  employeeId: number;
  name: string;
  employeeCode: string;
  department: string;
  designation: string;
  joinDate: string | null;
}

export type Granularity = 'day' | 'week' | 'month';

export interface AttendanceTrendPoint {
  bucket: string; // ISO date (bucket start)
  label: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
  attendancePct: number;
}
export interface DayOfWeekPoint {
  dow: number; // ISO day-of-week: Mon=1 … Sat=6
  day: string;
  present: number;
  absent: number;
  late: number;
  attendancePct: number;
}
export interface AttendanceTrend {
  granularity: Granularity;
  points: AttendanceTrendPoint[];
  dayOfWeek: DayOfWeekPoint[];
  comparison?: {
    range: Range;
    points: AttendanceTrendPoint[];
    attendancePct: number; // previous-period overall
    deltaPct: number; // current − previous
  };
  range: Range;
}

export interface DepartmentRanking {
  rank: number;
  department: string;
  headcount: number;
  present: number;
  absent: number;
  late: number;
  leaveDays: number;
  workingDays: number;
  attendancePct: number;
  absenteeismPct: number;
  punctualityPct: number;
  lopDays: number; // Estimated for Payroll Reference
  payableDays: number; // Estimated for Payroll Reference
  deltaPct?: number; // vs previous period (compare=true)
}
export interface DepartmentRankingResponse {
  departments: DepartmentRanking[];
  companyAvgAttendancePct: number;
  range: Range;
  comparisonRange?: Range;
}

export type RankingMetric = 'perfect_attendance' | 'most_absent' | 'most_late' | 'low_attendance';
export interface RankingEntry {
  rank: number;
  employeeId: number;
  name: string;
  employeeCode: string;
  department: string;
  designation: string;
  value: number; // metric value (attendance % or day count)
  attendancePct: number; // always included for context
}
export interface RankingBoard {
  metric: RankingMetric;
  label: string;
  entries: RankingEntry[];
}
export interface RankingsResponse {
  boards: RankingBoard[];
  threshold: number; // low-attendance threshold used
  range: Range;
}

export interface PaginationResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface EmployeeReportRow {
  employeeId: number;
  name: string;
  employeeCode: string;
  department: string;
  designation: string;
  workingDays: number;
  present: number;
  absent: number;
  late: number;
  halfDay: number; // Half Day Leave
  fullDayLeave: number; // Full Day Leave
  attendancePct: number;
  absenteeismPct: number;
  punctualityPct: number;
  lopDays: number; // Estimated for Payroll Reference
  payableDays: number; // Estimated for Payroll Reference
  totalLateCount: number;
  perfectAttendance: boolean;
  atRisk: boolean; // attendance % below the requested threshold
}

export interface EmployeeReportTotals {
  employees: number;
  workingDays: number;
  present: number;
  absent: number;
  late: number;
  halfDay: number;
  fullDayLeave: number;
  attendancePct: number;
  absenteeismPct: number;
  punctualityPct: number;
  lopDays: number;
  payableDays: number;
  totalLateCount: number;
}

export interface EmployeeReportResponse {
  rows: EmployeeReportRow[];
  pagination: PaginationResponse;
  totals: EmployeeReportTotals;
  threshold: number;
  range: Range;
}

export type AnalyticsWindow = { from: string; to: string; days: number };
export type ParseWindowResult =
  | { ok: true; window: AnalyticsWindow }
  | { ok: false; message: string };

// ═════════════════════════════════════════════════════════════════════════════
// Small utilities
// ═════════════════════════════════════════════════════════════════════════════

const MS_DAY = 24 * 60 * 60 * 1000;

const num = (v: any): number => (v == null ? 0 : Number(v));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const maxISO = (a: string, b: string): string => (a > b ? a : b);
const minISO = (a: string, b: string): string => (a < b ? a : b);

function toISODate(v: any): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Day-of-week (0=Sun … 6=Sat) for a calendar date, tz-safely at UTC midnight. */
function dayOfWeekUTC(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((b - a) / MS_DAY) + 1;
}

export function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const zeroCounts = (): StatusCounts => ({
  presentFull: 0,
  lateCount: 0,
  halfDay: 0,
  fullLeave: 0,
  totalRows: 0,
});

// ═════════════════════════════════════════════════════════════════════════════
// Working calendar (Mon–Sat working, Sun off) + future-holiday plug-point
// ═════════════════════════════════════════════════════════════════════════════

export interface WorkingCalendar {
  isWorkingDay(iso: string): boolean;
}
export interface WorkingCalendarOptions {
  weeklyOffDays?: number[]; // 0=Sun … 6=Sat. Default [0].
  holidays?: Set<string>; // FUTURE holiday hook; empty today.
}

export function createWorkingCalendar(opts: WorkingCalendarOptions = {}): WorkingCalendar {
  const weeklyOff = new Set(opts.weeklyOffDays ?? [0]);
  const holidays = opts.holidays ?? new Set<string>();
  return {
    isWorkingDay(iso: string): boolean {
      if (weeklyOff.has(dayOfWeekUTC(iso))) return false;
      if (holidays.has(iso)) return false;
      return true;
    },
  };
}

export function countWorkingDays(from: string, to: string, cal: WorkingCalendar): number {
  if (to < from) return 0;
  let count = 0;
  let cur = from;
  while (cur <= to) {
    if (cal.isWorkingDay(cur)) count++;
    cur = addDaysISO(cur, 1);
  }
  return count;
}

/**
 * Per-employee, join-clamped working-day counter (memoised). ONE implementation
 * reused by the summary, department ranking, rankings and employee report — no
 * duplicated working-day logic.
 */
function makeEmployeeWorkingDays(
  from: string,
  to: string,
  cal: WorkingCalendar,
): (joinISO: string | null) => number {
  const cache = new Map<string, number>();
  return (joinISO: string | null): number => {
    const start = joinISO && joinISO > from ? joinISO : from;
    if (start > to) return 0;
    let v = cache.get(start);
    if (v === undefined) {
      v = countWorkingDays(start, to, cal);
      cache.set(start, v);
    }
    return v;
  };
}

/** Σ per-employee working days in [max(from, join_date), to], join-clamped. */
function sumWorkingDays(
  roster: Array<{ joinISO: string | null }>,
  from: string,
  to: string,
  cal: WorkingCalendar,
): number {
  const wd = makeEmployeeWorkingDays(from, to, cal);
  let total = 0;
  for (const e of roster) total += wd(e.joinISO);
  return total;
}

/**
 * Expected working employee-days for an arbitrary sub-window, split into a base
 * cohort (joined on/before `from`) + recent joiners so per-bucket cost stays low.
 */
function makeExpectedFn(
  roster: Array<{ joinISO: string | null }>,
  from: string,
  to: string,
  cal: WorkingCalendar,
): (bStart: string, bEnd: string) => number {
  const base = roster.filter((e) => !e.joinISO || e.joinISO <= from).length;
  const recent = roster.filter((e) => e.joinISO && e.joinISO > from).map((e) => e.joinISO as string);
  const cache = new Map<string, number>();
  const wd = (s: string, e: string): number => {
    if (e < s) return 0;
    const key = `${s}|${e}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = countWorkingDays(s, e, cal);
      cache.set(key, v);
    }
    return v;
  };
  return (bStart: string, bEnd: string): number => {
    const s = maxISO(bStart, from);
    const e = minISO(bEnd, to);
    if (e < s) return 0;
    let total = base * wd(s, e);
    for (const j of recent) {
      const es = maxISO(j, s);
      if (es <= e) total += wd(es, e);
    }
    return total;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Window / bucket helpers
// ═════════════════════════════════════════════════════════════════════════════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

export function parseAnalyticsWindow(query: Record<string, any>): ParseWindowResult {
  const rawFrom = typeof query.from === 'string' ? query.from.trim() : '';
  const rawTo = typeof query.to === 'string' ? query.to.trim() : '';

  let from: string;
  let to: string;

  if (!rawFrom && !rawTo) {
    to = todayIST();
    from = addDaysISO(to, -29);
  } else if (rawFrom && rawTo) {
    if (!ISO_DATE.test(rawFrom) || !ISO_DATE.test(rawTo)) {
      return { ok: false, message: 'from/to must be valid YYYY-MM-DD dates.' };
    }
    if (
      Number.isNaN(new Date(`${rawFrom}T00:00:00Z`).getTime()) ||
      Number.isNaN(new Date(`${rawTo}T00:00:00Z`).getTime())
    ) {
      return { ok: false, message: 'from/to must be valid calendar dates.' };
    }
    from = rawFrom;
    to = rawTo;
  } else {
    return {
      ok: false,
      message: 'Both from and to are required (or omit both for the default range).',
    };
  }

  if (to < from) return { ok: false, message: 'to must be on or after from.' };

  const days = daysBetweenInclusive(from, to);
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, message: `Date range too large (max ${MAX_RANGE_DAYS} days).` };
  }
  return { ok: true, window: { from, to, days } };
}

/** The immediately-preceding equal-length window (for compare=true). */
export function previousWindow(f: AttendanceFilters): { from: string; to: string } {
  const days = daysBetweenInclusive(f.from, f.to);
  const prevTo = addDaysISO(f.from, -1);
  const prevFrom = addDaysISO(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

export function resolveGranularity(raw: string | undefined, days: number): Granularity {
  if (raw === 'day' || raw === 'week' || raw === 'month') return raw;
  if (days <= 45) return 'day';
  if (days <= 182) return 'week';
  return 'month';
}

function bucketStartOf(iso: string, g: Granularity): string {
  if (g === 'month') return `${iso.slice(0, 7)}-01`;
  if (g === 'week') {
    const back = (dayOfWeekUTC(iso) + 6) % 7; // days since Monday
    return addDaysISO(iso, -back);
  }
  return iso;
}
function bucketEndOf(start: string, g: Granularity): string {
  if (g === 'month') {
    const [y, m] = start.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${start.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
  }
  if (g === 'week') return addDaysISO(start, 6);
  return start;
}
function bucketLabelOf(start: string, g: Granularity): string {
  return g === 'month' ? start.slice(0, 7) : start;
}

export function generateBuckets(
  from: string,
  to: string,
  g: Granularity,
): Array<{ start: string; end: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ start: string; end: string; label: string }> = [];
  let cur = from;
  while (cur <= to) {
    const s = bucketStartOf(cur, g);
    if (!seen.has(s)) {
      seen.add(s);
      out.push({ start: s, end: bucketEndOf(s, g), label: bucketLabelOf(s, g) });
    }
    cur = addDaysISO(cur, 1);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared SQL (one status-count fragment; reused by every aggregate → no dup SQL)
// ═════════════════════════════════════════════════════════════════════════════

const STATUS_COUNT_SELECT = `
  COUNT(a.id) FILTER (WHERE a.status IN ('present','late','late_after_lunch')) AS present_full,
  COUNT(a.id) FILTER (WHERE a.status IN ('late','late_after_lunch'))           AS late_count,
  COUNT(a.id) FILTER (WHERE a.status = 'leave_half_day')                       AS half_day,
  COUNT(a.id) FILTER (WHERE a.status = 'leave_full_day')                       AS full_leave,
  COUNT(a.id)                                                                  AS total_rows
`;

function parseStatusCounts(r: any): StatusCounts {
  return {
    presentFull: num(r.present_full),
    lateCount: num(r.late_count),
    halfDay: num(r.half_day),
    fullLeave: num(r.full_leave),
    totalRows: num(r.total_rows),
  };
}

/** Half-day leave = structured half_period OR the legacy " (Half Day)" suffix. */
function isHalfDayLeave(halfPeriod: any, leaveType: any): boolean {
  if (halfPeriod === 'first_half' || halfPeriod === 'second_half') return true;
  return typeof leaveType === 'string' && leaveType.includes('(Half Day)');
}

/**
 * LEAVE ALIGNMENT — approved-leave WORKING-days per employee, derived from the
 * `leaves` table (the source of truth), NOT from materialized attendance leave
 * rows. Each approved leave is intersected with [from,to] and the Mon–Sat working
 * calendar; a half-day counts its working-days under `half` (weighted 0.5 by the
 * metric formula), a full-day under `full`. Reused to override the attendance-
 * status-derived leave counts in the per-employee aggregate and the summary.
 */
async function approvedLeaveByEmployee(
  f: AttendanceFilters,
  calendar: WorkingCalendar,
): Promise<Map<number, { full: number; half: number }>> {
  const args: any[] = [];
  const p = (v: any) => {
    args.push(v);
    return `$${args.length}`;
  };
  const clauses: string[] = [
    `e.employment_status = 'active'`,
    `l.status = 'approved'`,
    `l.start_date::date <= ${p(f.to)}::date`,
    `l.end_date::date >= ${p(f.from)}::date`,
  ];
  if (f.department) clauses.push(`e.department = ${p(f.department)}`);
  if (f.employeeId != null) clauses.push(`e.id = ${p(f.employeeId)}`);

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT l.employee_id, l.start_date, l.end_date, l.leave_type, l.half_period
       FROM leaves l
       JOIN employees e ON l.employee_id = e.id
      WHERE ${clauses.join(' AND ')};`,
    ...args,
  );

  const map = new Map<number, { full: number; half: number }>();
  for (const r of rows) {
    const empId = num(r.employee_id);
    const startISO = toISODate(r.start_date);
    const endISO = toISODate(r.end_date);
    const lo = startISO > f.from ? startISO : f.from; // clamp to window
    const hi = endISO < f.to ? endISO : f.to;
    let workingDays = 0;
    let cur = lo;
    while (cur <= hi) {
      if (calendar.isWorkingDay(cur)) workingDays++;
      cur = addDaysISO(cur, 1);
    }
    if (workingDays === 0) continue;
    const agg = map.get(empId) ?? { full: 0, half: 0 };
    if (isHalfDayLeave(r.half_period, r.leave_type)) agg.half += workingDays;
    else agg.full += workingDays;
    map.set(empId, agg);
  }
  return map;
}

interface WhereBuild {
  where: string;
  args: any[];
}

/** Base attendance filter, scoped to ACTIVE employees. `status` intentionally excluded. */
function buildBaseWhere(f: AttendanceFilters): WhereBuild {
  const args: any[] = [];
  const p = (v: any) => {
    args.push(v);
    return `$${args.length}`;
  };
  const clauses: string[] = [`e.employment_status = 'active'`];
  clauses.push(`a.date >= ${p(f.from)}::date`);
  clauses.push(`a.date <= ${p(f.to)}::date`);
  if (f.department) clauses.push(`e.department = ${p(f.department)}`);
  if (f.employeeId != null) clauses.push(`a.employee_id = ${p(f.employeeId)}`);
  return { where: `WHERE ${clauses.join(' AND ')}`, args };
}

/** Active-employee roster (id + join date + department) for working-day expectations. */
async function getActiveRoster(
  f: AttendanceFilters,
): Promise<Array<{ id: number; joinISO: string | null; department: string }>> {
  const args: any[] = [];
  const p = (v: any) => {
    args.push(v);
    return `$${args.length}`;
  };
  const clauses: string[] = [`e.employment_status = 'active'`];
  if (f.department) clauses.push(`e.department = ${p(f.department)}`);
  if (f.employeeId != null) clauses.push(`e.id = ${p(f.employeeId)}`);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e.join_date, e.department FROM employees e WHERE ${clauses.join(' AND ')};`,
    ...args,
  );
  return rows.map((r) => ({
    id: num(r.id),
    joinISO: r.join_date ? toISODate(r.join_date) : null,
    department: r.department || '—',
  }));
}

/**
 * REUSABLE CORE — per-employee status aggregation. LEFT JOIN so employees with no
 * attendance still appear (fully absent). Reused by rankings (M3.1), the employee
 * report (M3.2) and the future Employee Profile.
 */
async function aggregateByEmployee(
  f: AttendanceFilters,
  opts: { search?: string } = {},
): Promise<EmployeeStatusRow[]> {
  const args: any[] = [];
  const p = (v: any) => {
    args.push(v);
    return `$${args.length}`;
  };
  const pFrom = p(f.from);
  const pTo = p(f.to);
  const clauses: string[] = [`e.employment_status = 'active'`];
  if (f.department) clauses.push(`e.department = ${p(f.department)}`);
  if (f.employeeId != null) clauses.push(`e.id = ${p(f.employeeId)}`);
  if (opts.search) {
    // Server-side search on employee name (users.name) OR employee code. Parameterised.
    const like = p(`%${opts.search}%`);
    clauses.push(`(u.name ILIKE ${like} OR e.employee_code ILIKE ${like})`);
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id AS employee_id, u.name, e.employee_code, e.department, e.designation, e.join_date,
       ${STATUS_COUNT_SELECT}
     FROM employees e
     LEFT JOIN users u ON e.user_id = u.id
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.date >= ${pFrom}::date AND a.date <= ${pTo}::date
     WHERE ${clauses.join(' AND ')}
     GROUP BY e.id, u.name, e.employee_code, e.department, e.designation, e.join_date;`,
    ...args,
  );
  // Override attendance-status leave counts with leaves-table-derived approved
  // leave (source of truth). All downstream surfaces that use this core — Employee
  // Report, Rankings, Department Ranking — become leave-aware in one place.
  const leaveMap = await approvedLeaveByEmployee(f, createWorkingCalendar());
  return rows.map((r) => {
    const counts = parseStatusCounts(r);
    // `leaves` is the source of truth: always replace the attendance-status leave
    // counts (default 0 when no approved leave), so stale attendance.status =
    // leave_* rows never survive without a matching approved leave.
    const lv = leaveMap.get(num(r.employee_id));
    counts.fullLeave = lv?.full ?? 0;
    counts.halfDay = lv?.half ?? 0;
    return {
      employeeId: num(r.employee_id),
      name: r.name || 'Unknown',
      employeeCode: r.employee_code || '',
      department: r.department || '—',
      designation: r.designation || '—',
      joinDate: r.join_date ? toISODate(r.join_date) : null,
      ...counts,
    };
  });
}

function bucketExpr(g: Granularity): string {
  if (g === 'week') return `date_trunc('week', a.date::timestamp)::date`;
  if (g === 'month') return `date_trunc('month', a.date::timestamp)::date`;
  return `a.date`;
}

/** Status counts grouped by a time bucket. */
async function aggregateByBucket(
  f: AttendanceFilters,
  g: Granularity,
): Promise<Array<{ bucket: string } & StatusCounts>> {
  const { where, args } = buildBaseWhere(f);
  const expr = bucketExpr(g);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ${expr} AS bucket, ${STATUS_COUNT_SELECT}
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     ${where}
     GROUP BY ${expr}
     ORDER BY ${expr};`,
    ...args,
  );
  return rows.map((r) => ({ bucket: toISODate(r.bucket), ...parseStatusCounts(r) }));
}

// ═════════════════════════════════════════════════════════════════════════════
// Metric formulas (ONE place — reused by every surface)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Finalized business rules:
 *   Attendance % = Present ÷ (WorkingDays − ApprovedLeave) × 100  (approved leave
 *   excluded from the denominator), capped 0–100.
 *   Present-equivalent counts a half-day as 0.5 present + 0.5 leave.
 *   LOP / Payable are Estimated for Payroll Reference (absence-based proxy).
 */
export function computeAttendanceMetrics(c: StatusCounts, workingDays: number): AttendanceMetrics {
  const presentEquivalent = c.presentFull + 0.5 * c.halfDay;
  const approvedLeaveDays = c.fullLeave + 0.5 * c.halfDay;
  const absent = Math.max(0, workingDays - c.presentFull - c.fullLeave - c.halfDay);
  const denom = workingDays - approvedLeaveDays;
  const attendancePct = denom > 0 ? Math.min(100, round1((presentEquivalent / denom) * 100)) : 0;
  const absenteeismPct = workingDays > 0 ? Math.min(100, round1((absent / workingDays) * 100)) : 0;
  const punctualityPct =
    c.presentFull > 0 ? round1(((c.presentFull - c.lateCount) / c.presentFull) * 100) : 0;
  const lopDays = absent; // unapproved-absence proxy (approved leave is not LOP)
  const payableDays = Math.max(0, workingDays - lopDays);
  return {
    present: c.presentFull,
    late: c.lateCount,
    halfDay: c.halfDay,
    fullDayLeave: c.fullLeave,
    absent,
    workingDays,
    approvedLeaveDays: round1(approvedLeaveDays),
    attendancePct,
    absenteeismPct,
    punctualityPct,
    lopDays,
    payableDays,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Payroll worked-day aggregation (single home of the monthly paid-leave policy)
// ═════════════════════════════════════════════════════════════════════════════

export interface PayrollDayBreakdown {
  calendarDays: number; // days in the month (28/29/30/31)
  officeWorkingDays: number; // calendar − Sundays − company holidays
  presentDays: number; // physical presence (present + 0.5 × half-day)
  approvedLeaveDays: number; // approved leave day-units (full=1, half=0.5)
  paidLeaveDays: number; // min(approvedLeaveDays, quota) → counts as worked
  unpaidLeaveDays: number; // beyond quota → Loss Of Pay
  workedDays: number; // Employee Worked Days = present + paid leave
  lossOfPay: number; // Office Working Days − Employee Worked Days
}

/**
 * Worked-day aggregation for PAYROLL — the ONE place the monthly paid-leave
 * policy lives. Office Working Days = calendar − Sundays − company holidays. The
 * first {@link MONTHLY_PAID_LEAVE_QUOTA} approved-leave day-units count as worked
 * (paid); the remainder become Loss Of Pay. Half-day leave = 0.5. Physical
 * presence comes from attendance rows; the `leaves` table is the source of truth
 * for leave (reusing {@link approvedLeaveByEmployee}). Payroll consumes the
 * returned snapshot and never re-derives these numbers.
 */
export async function getPayrollDayBreakdown(
  employeeId: number,
  year: number,
  monthIndex: number, // 0 = January … 11 = December
  holidays: Set<string> = new Set(),
): Promise<PayrollDayBreakdown> {
  const calendarDays = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const mm = String(monthIndex + 1).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-${String(calendarDays).padStart(2, '0')}`;

  const cal = createWorkingCalendar({ holidays });
  const officeWorkingDays = countWorkingDays(from, to, cal);

  // Physical presence only (Sundays excluded; leave rows are NOT counted here).
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ${STATUS_COUNT_SELECT}
       FROM attendance a
      WHERE a.employee_id = $1
        AND a.date::date BETWEEN $2::date AND $3::date
        AND EXTRACT(DOW FROM a.date::date) <> 0;`,
    employeeId,
    from,
    to,
  );
  const c = parseStatusCounts(rows[0] ?? {});

  // Approved leave from the leaves table (source of truth), holiday-aware.
  const leaveMap = await approvedLeaveByEmployee({ from, to, employeeId }, cal);
  const lv = leaveMap.get(employeeId) ?? { full: 0, half: 0 };

  const quota = PAYROLL_CONFIG.monthlyPaidLeaveQuota;
  const presentDays = c.presentFull + 0.5 * lv.half;
  const approvedLeaveDays = lv.full + 0.5 * lv.half;
  const paidLeaveDays = Math.min(approvedLeaveDays, quota);
  const unpaidLeaveDays = Math.max(0, approvedLeaveDays - quota);
  // Cap at Office Working Days so inconsistent rows can never over-credit a month.
  const workedDays = Math.min(presentDays + paidLeaveDays, officeWorkingDays);
  const lossOfPay = Math.max(0, officeWorkingDays - workedDays);

  return {
    calendarDays,
    officeWorkingDays,
    presentDays,
    approvedLeaveDays,
    paidLeaveDays,
    unpaidLeaveDays,
    workedDays,
    lossOfPay,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Computations
// ═════════════════════════════════════════════════════════════════════════════

/** GET /hr/analytics/summary */
export async function computeAttendanceSummary(
  f: AttendanceFilters,
  calendar: WorkingCalendar = createWorkingCalendar(),
): Promise<AnalyticsSummary> {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const { where, args } = buildBaseWhere(f);
  const aggRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ${STATUS_COUNT_SELECT}
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     ${where};`,
    ...args,
  );
  const counts = parseStatusCounts(aggRows[0] ?? {});

  // Align leave with the `leaves` table (source of truth) instead of attendance
  // leave statuses: replace the company-wide leave counts with approved-leave
  // working-days summed across employees.
  const leaveMap = await approvedLeaveByEmployee(f, calendar);
  let fullLeaveDays = 0;
  let halfLeaveDays = 0;
  for (const v of leaveMap.values()) {
    fullLeaveDays += v.full;
    halfLeaveDays += v.half;
  }
  counts.fullLeave = fullLeaveDays;
  counts.halfDay = halfLeaveDays;

  const roster = await getActiveRoster(f);
  const workingDays = sumWorkingDays(roster, f.from, f.to, calendar);
  const m = computeAttendanceMetrics(counts, workingDays);

  return {
    totalEmployees: roster.length,
    present: m.present,
    late: m.late,
    halfDay: m.halfDay,
    fullDayLeave: m.fullDayLeave,
    absent: m.absent,
    workingDays: m.workingDays,
    approvedLeaveDays: m.approvedLeaveDays,
    attendancePct: m.attendancePct,
    range,
  };
}

const STATUS_LABELS: Record<string, string> = {
  present: 'Present',
  late: 'Late',
  late_after_lunch: 'Late After Lunch',
  leave_full_day: 'Full Day Leave',
  leave_half_day: 'Half Day',
  absent: 'Absent',
};
function labelFor(status: string): string {
  return (
    STATUS_LABELS[status] ?? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** GET /hr/analytics/status-distribution */
export async function computeStatusDistribution(f: AttendanceFilters): Promise<StatusDistribution> {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const { where, args } = buildBaseWhere(f);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT a.status, COUNT(*) AS c
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     ${where}
     GROUP BY a.status;`,
    ...args,
  );
  const counts = rows.map((row) => ({ status: String(row.status), count: num(row.c) }));
  const total = counts.reduce((s, c) => s + c.count, 0);
  const segments: StatusDistributionSegment[] = counts
    .map((c) => ({
      status: c.status,
      label: labelFor(c.status),
      count: c.count,
      pct: total > 0 ? round1((c.count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
  return { total, segments, range };
}

/** GET /hr/analytics/trend  (supports granularity + day-of-week pattern + compare) */
export async function computeAttendanceTrend(
  f: AttendanceFilters,
  opts: { granularity?: string; compare?: boolean } = {},
): Promise<AttendanceTrend> {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const granularity = resolveGranularity(opts.granularity, range.days);
  const cal = createWorkingCalendar();

  const [roster, bucketCounts] = await Promise.all([
    getActiveRoster(f),
    aggregateByBucket(f, granularity),
  ]);
  const countsByBucket = new Map<string, StatusCounts>(
    bucketCounts.map((b) => [
      b.bucket,
      {
        presentFull: b.presentFull,
        lateCount: b.lateCount,
        halfDay: b.halfDay,
        fullLeave: b.fullLeave,
        totalRows: b.totalRows,
      },
    ]),
  );

  const expectedFn = makeExpectedFn(roster, f.from, f.to, cal);
  const points: AttendanceTrendPoint[] = generateBuckets(f.from, f.to, granularity).map((bk) => {
    const c = countsByBucket.get(bk.start) ?? zeroCounts();
    const m = computeAttendanceMetrics(c, expectedFn(bk.start, bk.end));
    return {
      bucket: bk.start,
      label: bk.label,
      present: m.present,
      absent: m.absent,
      late: m.late,
      leave: m.fullDayLeave + m.halfDay,
      attendancePct: m.attendancePct,
    };
  });

  const dayOfWeek = await computeDayOfWeekPattern(f, roster, cal);

  let comparison: AttendanceTrend['comparison'];
  if (opts.compare) {
    const pw = previousWindow(f);
    const prevF: AttendanceFilters = { ...f, from: pw.from, to: pw.to };
    const [curSum, prevSum, prevTrend] = await Promise.all([
      computeAttendanceSummary(f, cal),
      computeAttendanceSummary(prevF, cal),
      computeAttendanceTrend(prevF, { granularity, compare: false }),
    ]);
    comparison = {
      range: { from: pw.from, to: pw.to, days: daysBetweenInclusive(pw.from, pw.to) },
      points: prevTrend.points,
      attendancePct: prevSum.attendancePct,
      deltaPct: round1(curSum.attendancePct - prevSum.attendancePct),
    };
  }

  return { granularity, points, dayOfWeek, comparison, range };
}

const ISO_DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function computeDayOfWeekPattern(
  f: AttendanceFilters,
  roster: Array<{ joinISO: string | null }>,
  cal: WorkingCalendar,
): Promise<DayOfWeekPoint[]> {
  const { where, args } = buildBaseWhere(f);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT EXTRACT(ISODOW FROM a.date)::int AS dow, ${STATUS_COUNT_SELECT}
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     ${where}
     GROUP BY dow
     ORDER BY dow;`,
    ...args,
  );
  const counts = new Map<number, StatusCounts>();
  for (const r of rows) counts.set(num(r.dow), parseStatusCounts(r));

  // Expected occurrences per weekday × headcount (aggregate insight; join clamp not
  // applied here — this is a pattern, not a payroll figure).
  const headcount = roster.length;
  const occ = new Map<number, number>();
  let cur = f.from;
  while (cur <= f.to) {
    if (cal.isWorkingDay(cur)) {
      const dowUTC = dayOfWeekUTC(cur);
      const isodow = dowUTC === 0 ? 7 : dowUTC;
      occ.set(isodow, (occ.get(isodow) ?? 0) + 1);
    }
    cur = addDaysISO(cur, 1);
  }

  const out: DayOfWeekPoint[] = [];
  for (let dow = 1; dow <= 6; dow++) {
    // Mon–Sat working days
    const c = counts.get(dow) ?? zeroCounts();
    const expected = (occ.get(dow) ?? 0) * headcount;
    const m = computeAttendanceMetrics(c, expected);
    out.push({
      dow,
      day: ISO_DOW_LABELS[dow],
      present: m.present,
      absent: m.absent,
      late: m.late,
      attendancePct: m.attendancePct,
    });
  }
  return out;
}

/** GET /hr/analytics/by-department  (Department Ranking; supports compare) */
export async function computeDepartmentRanking(
  f: AttendanceFilters,
  opts: { compare?: boolean } = {},
): Promise<DepartmentRankingResponse> {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const cal = createWorkingCalendar();
  const employees = await aggregateByEmployee(f);

  const departments = rollupDepartments(employees, f.from, f.to, cal);

  // Company average attendance % (single roll-up over all in-scope employees).
  const totalCounts = employees.reduce(
    (acc, e) => ({
      presentFull: acc.presentFull + e.presentFull,
      lateCount: acc.lateCount + e.lateCount,
      halfDay: acc.halfDay + e.halfDay,
      fullLeave: acc.fullLeave + e.fullLeave,
      totalRows: acc.totalRows + e.totalRows,
    }),
    zeroCounts(),
  );
  const totalWorkingDays = sumWorkingDays(
    employees.map((e) => ({ joinISO: e.joinDate })),
    f.from,
    f.to,
    cal,
  );
  const companyAvgAttendancePct = computeAttendanceMetrics(totalCounts, totalWorkingDays).attendancePct;

  let comparisonRange: Range | undefined;
  if (opts.compare) {
    const pw = previousWindow(f);
    const prevEmployees = await aggregateByEmployee({ ...f, from: pw.from, to: pw.to });
    const prevByDept = new Map(
      rollupDepartments(prevEmployees, pw.from, pw.to, cal).map((d) => [d.department, d.attendancePct]),
    );
    for (const d of departments) {
      const prevPct = prevByDept.get(d.department);
      if (prevPct != null) d.deltaPct = round1(d.attendancePct - prevPct);
    }
    comparisonRange = { from: pw.from, to: pw.to, days: daysBetweenInclusive(pw.from, pw.to) };
  }

  return { departments, companyAvgAttendancePct, range, comparisonRange };
}

/** Pure roll-up of per-employee rows into ranked departments. */
function rollupDepartments(
  employees: EmployeeStatusRow[],
  from: string,
  to: string,
  cal: WorkingCalendar,
): DepartmentRanking[] {
  const wdFor = makeEmployeeWorkingDays(from, to, cal);

  const groups = new Map<string, { counts: StatusCounts; workingDays: number; headcount: number }>();
  for (const e of employees) {
    const g = groups.get(e.department) ?? { counts: zeroCounts(), workingDays: 0, headcount: 0 };
    g.counts.presentFull += e.presentFull;
    g.counts.lateCount += e.lateCount;
    g.counts.halfDay += e.halfDay;
    g.counts.fullLeave += e.fullLeave;
    g.counts.totalRows += e.totalRows;
    g.workingDays += wdFor(e.joinDate);
    g.headcount += 1;
    groups.set(e.department, g);
  }

  return [...groups.entries()]
    .map(([department, g]) => {
      const m = computeAttendanceMetrics(g.counts, g.workingDays);
      return {
        rank: 0,
        department,
        headcount: g.headcount,
        present: m.present,
        absent: m.absent,
        late: m.late,
        leaveDays: m.fullDayLeave + m.halfDay,
        workingDays: m.workingDays,
        attendancePct: m.attendancePct,
        absenteeismPct: m.absenteeismPct,
        punctualityPct: m.punctualityPct,
        lopDays: m.lopDays,
        payableDays: m.payableDays,
      } as DepartmentRanking;
    })
    .sort((a, b) => b.attendancePct - a.attendancePct)
    .map((d, i) => ({ ...d, rank: i + 1 }));
}

/** GET /hr/analytics/rankings */
export async function computeRankings(
  f: AttendanceFilters,
  opts: { metric?: RankingMetric; limit: number; threshold: number },
): Promise<RankingsResponse> {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const cal = createWorkingCalendar();
  const employees = await aggregateByEmployee(f);

  const wdFor = makeEmployeeWorkingDays(f.from, f.to, cal);
  const items = employees.map((e) => ({ employee: e, metrics: computeAttendanceMetrics(e, wdFor(e.joinDate)) }));
  const boards = buildRankingBoards(items, opts);
  return { boards, threshold: opts.threshold, range };
}

/** Pure ranking-board builder (exported for unit verification). */
export function buildRankingBoards(
  items: Array<{ employee: EmployeeStatusRow; metrics: AttendanceMetrics }>,
  opts: { metric?: RankingMetric; limit: number; threshold: number },
): RankingBoard[] {
  const entry = (
    it: { employee: EmployeeStatusRow; metrics: AttendanceMetrics },
    value: number,
  ): RankingEntry => ({
    rank: 0,
    employeeId: it.employee.employeeId,
    name: it.employee.name,
    employeeCode: it.employee.employeeCode,
    department: it.employee.department,
    designation: it.employee.designation,
    value,
    attendancePct: it.metrics.attendancePct,
  });
  const rankify = (entries: RankingEntry[]): RankingEntry[] =>
    entries.map((e, i) => ({ ...e, rank: i + 1 }));
  const take = <T>(arr: T[]): T[] => arr.slice(0, opts.limit);

  const build = (metric: RankingMetric): RankingBoard => {
    switch (metric) {
      case 'perfect_attendance': {
        const list = items
          .filter((i) => i.metrics.workingDays > 0 && i.metrics.attendancePct >= 100)
          .sort(
            (a, b) =>
              b.metrics.workingDays - a.metrics.workingDays ||
              a.employee.name.localeCompare(b.employee.name),
          );
        return {
          metric,
          label: 'Perfect Attendance',
          entries: rankify(take(list).map((i) => entry(i, i.metrics.attendancePct))),
        };
      }
      case 'most_absent': {
        const list = items.filter((i) => i.metrics.absent > 0).sort((a, b) => b.metrics.absent - a.metrics.absent);
        return {
          metric,
          label: 'Most Absences',
          entries: rankify(take(list).map((i) => entry(i, i.metrics.absent))),
        };
      }
      case 'most_late': {
        const list = items.filter((i) => i.metrics.late > 0).sort((a, b) => b.metrics.late - a.metrics.late);
        return {
          metric,
          label: 'Most Late Arrivals',
          entries: rankify(take(list).map((i) => entry(i, i.metrics.late))),
        };
      }
      case 'low_attendance': {
        const list = items
          .filter((i) => i.metrics.workingDays > 0 && i.metrics.attendancePct < opts.threshold)
          .sort((a, b) => a.metrics.attendancePct - b.metrics.attendancePct);
        return {
          metric,
          label: `Low Attendance (< ${opts.threshold}%)`,
          entries: rankify(take(list).map((i) => entry(i, i.metrics.attendancePct))),
        };
      }
    }
  };

  const metrics: RankingMetric[] = opts.metric
    ? [opts.metric]
    : ['perfect_attendance', 'most_absent', 'most_late', 'low_attendance'];
  return metrics.map(build);
}

// ═════════════════════════════════════════════════════════════════════════════
// Employee Report (M3.2) — reuses aggregateByEmployee + computeAttendanceMetrics
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Whitelisted sort keys. Sorting runs in the SERVICE over already-computed
 * metrics (join-clamped working days come from the calendar, so a SQL ORDER BY on
 * derived columns isn't possible) — which also makes it injection-proof: a key
 * only ever selects a fixed accessor and is never interpolated into SQL.
 */
export const EMPLOYEE_REPORT_SORT_KEYS: string[] = [
  'name',
  'department',
  'designation',
  'employeeCode',
  'workingDays',
  'present',
  'absent',
  'late',
  'halfDay',
  'fullDayLeave',
  'attendancePct',
  'absenteeismPct',
  'punctualityPct',
  'lopDays',
  'payableDays',
  'totalLateCount',
];

const SORTABLE: Record<string, (r: EmployeeReportRow) => number | string> = {
  name: (r) => r.name.toLowerCase(),
  department: (r) => r.department.toLowerCase(),
  designation: (r) => r.designation.toLowerCase(),
  employeeCode: (r) => r.employeeCode.toLowerCase(),
  workingDays: (r) => r.workingDays,
  present: (r) => r.present,
  absent: (r) => r.absent,
  late: (r) => r.late,
  halfDay: (r) => r.halfDay,
  fullDayLeave: (r) => r.fullDayLeave,
  attendancePct: (r) => r.attendancePct,
  absenteeismPct: (r) => r.absenteeismPct,
  punctualityPct: (r) => r.punctualityPct,
  lopDays: (r) => r.lopDays,
  payableDays: (r) => r.payableDays,
  totalLateCount: (r) => r.totalLateCount,
};

function sortReportRows(rows: EmployeeReportRow[], key: string, order: 'asc' | 'desc'): void {
  const accessor = SORTABLE[key] ?? SORTABLE.attendancePct;
  const dir = order === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    let cmp: number;
    if (typeof av === 'string' && typeof bv === 'string') cmp = av.localeCompare(bv);
    else cmp = (av as number) - (bv as number);
    if (cmp === 0) cmp = a.name.localeCompare(b.name); // stable tiebreak
    return cmp * dir;
  });
}

export interface EmployeeReportOptions {
  page: number;
  pageSize: number;
  sort: string;
  order: 'asc' | 'desc';
  search?: string;
  threshold: number; // at-risk threshold (attendance % below this = at risk)
}

/**
 * Pure assembly of the employee report from pre-aggregated per-employee rows
 * (exported for unit verification). Computes metrics (reusing
 * computeAttendanceMetrics), a totals footer over the FULL filtered set (true
 * aggregate, consistent with the company-average roll-up), then whitelisted sort
 * + pagination.
 */
export function assembleEmployeeReport(
  employees: EmployeeStatusRow[],
  f: AttendanceFilters,
  opts: EmployeeReportOptions,
  calendar: WorkingCalendar = createWorkingCalendar(),
): EmployeeReportResponse {
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const wd = makeEmployeeWorkingDays(f.from, f.to, calendar);

  const allRows: EmployeeReportRow[] = employees.map((e) => {
    const m = computeAttendanceMetrics(e, wd(e.joinDate));
    return {
      employeeId: e.employeeId,
      name: e.name,
      employeeCode: e.employeeCode,
      department: e.department,
      designation: e.designation,
      workingDays: m.workingDays,
      present: m.present,
      absent: m.absent,
      late: m.late,
      halfDay: m.halfDay,
      fullDayLeave: m.fullDayLeave,
      attendancePct: m.attendancePct,
      absenteeismPct: m.absenteeismPct,
      punctualityPct: m.punctualityPct,
      lopDays: m.lopDays,
      payableDays: m.payableDays,
      totalLateCount: m.late,
      perfectAttendance: m.workingDays > 0 && m.attendancePct >= 100,
      atRisk: m.workingDays > 0 && m.attendancePct < opts.threshold,
    };
  });

  const totalCounts = employees.reduce(
    (acc, e) => ({
      presentFull: acc.presentFull + e.presentFull,
      lateCount: acc.lateCount + e.lateCount,
      halfDay: acc.halfDay + e.halfDay,
      fullLeave: acc.fullLeave + e.fullLeave,
      totalRows: acc.totalRows + e.totalRows,
    }),
    zeroCounts(),
  );
  const totalWorkingDays = allRows.reduce((s, r) => s + r.workingDays, 0);
  const tm = computeAttendanceMetrics(totalCounts, totalWorkingDays);
  const totals: EmployeeReportTotals = {
    employees: allRows.length,
    workingDays: tm.workingDays,
    present: tm.present,
    absent: tm.absent,
    late: tm.late,
    halfDay: tm.halfDay,
    fullDayLeave: tm.fullDayLeave,
    attendancePct: tm.attendancePct,
    absenteeismPct: tm.absenteeismPct,
    punctualityPct: tm.punctualityPct,
    lopDays: tm.lopDays,
    payableDays: tm.payableDays,
    totalLateCount: tm.late,
  };

  sortReportRows(allRows, opts.sort, opts.order);
  const total = allRows.length;
  const totalPages = Math.max(1, Math.ceil(total / opts.pageSize));
  const page = Math.min(Math.max(1, opts.page), totalPages);
  const startIdx = (page - 1) * opts.pageSize;
  const rows = allRows.slice(startIdx, startIdx + opts.pageSize);

  return {
    rows,
    pagination: { page, pageSize: opts.pageSize, total, totalPages },
    totals,
    threshold: opts.threshold,
    range,
  };
}

/** GET /hr/analytics/employee-report */
export async function computeEmployeeReport(
  f: AttendanceFilters,
  opts: EmployeeReportOptions,
): Promise<EmployeeReportResponse> {
  const employees = await aggregateByEmployee(f, { search: opts.search });
  return assembleEmployeeReport(employees, f, opts);
}

// ═════════════════════════════════════════════════════════════════════════════
// Employee Drill-down (M3.3) — profile + metrics + calendar + timeline + leave +
// insights. Reuses aggregateByEmployee + computeAttendanceMetrics (no new math).
// Purely status/calendar/leave based — no punch / work-hours / overtime metrics.
// ═════════════════════════════════════════════════════════════════════════════

export interface EmployeeProfile {
  employeeId: number;
  name: string;
  employeeCode: string;
  department: string;
  designation: string;
  joinDate: string | null;
  phone: string | null;
  employmentStatus: string;
}

/** One cell of the monthly attendance grid. */
export interface EmployeeCalendarDay {
  date: string; // YYYY-MM-DD
  dow: number; // 0=Sun … 6=Sat
  inRange: boolean; // within the selected [from,to] window
  working: boolean; // company working day (Mon–Sat, non-holiday, on/after join)
  isFuture: boolean; // date is after today (IST)
  status: string | null; // attendance status, or null when no record exists
  leaveType: string | null; // attendance.leave_type (half_day/full_day) when applicable
}
export interface EmployeeCalendarMonth {
  month: string; // YYYY-MM
  label: string; // e.g. "July 2026"
  days: EmployeeCalendarDay[];
}

/** Status-only timeline entry (no punch/check-in/out fields by design). */
export interface EmployeeTimelineEntry {
  date: string;
  status: string;
  leaveType: string | null;
  notes: string | null; // HR Notes
}

export interface EmployeeLeaveBreakdownItem {
  leaveType: string;
  requests: number;
  days: number;
  approved: number;
  pending: number;
  rejected: number;
}
export interface EmployeeLeaveBreakdown {
  items: EmployeeLeaveBreakdownItem[];
  totalRequests: number;
  totalDays: number;
}

export type InsightType = 'positive' | 'warning' | 'critical' | 'info';
export interface EmployeeInsight {
  type: InsightType;
  code: string;
  title: string;
  detail: string;
}

export interface EmployeeDetailResponse {
  profile: EmployeeProfile;
  metrics: AttendanceMetrics;
  calendar: EmployeeCalendarMonth[];
  timeline: EmployeeTimelineEntry[];
  leaveBreakdown: EmployeeLeaveBreakdown;
  insights: EmployeeInsight[];
  today: string;
  range: Range;
}

/** Per-date status lookup shared by the calendar, insights and absence-run scan. */
interface CalendarStatus {
  status: string;
  leaveType: string | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Pure monthly-grid builder (Mon–Sat working, Sunday weekly-off). Every day of
 * each spanned calendar month is emitted (with `inRange` marking the selected
 * window) so the frontend can lay out a real grid without any date math.
 * Exported for unit verification.
 */
export function buildEmployeeCalendar(
  from: string,
  to: string,
  statusMap: Map<string, CalendarStatus>,
  cal: WorkingCalendar,
  joinISO: string | null,
  today: string,
): EmployeeCalendarMonth[] {
  return generateBuckets(from, to, 'month').map((bk) => {
    const [y, m] = bk.start.split('-').map(Number);
    const days: EmployeeCalendarDay[] = [];
    let cur = bk.start; // first day of the month
    while (cur <= bk.end) {
      // bk.end = last day of the month
      const rec = statusMap.get(cur);
      const beforeJoin = joinISO ? cur < joinISO : false;
      days.push({
        date: cur,
        dow: dayOfWeekUTC(cur),
        inRange: cur >= from && cur <= to,
        working: cal.isWorkingDay(cur) && !beforeJoin,
        isFuture: cur > today,
        status: rec?.status ?? null,
        leaveType: rec?.leaveType ?? null,
      });
      cur = addDaysISO(cur, 1);
    }
    return { month: bk.start.slice(0, 7), label: `${MONTH_NAMES[m - 1]} ${y}`, days };
  });
}

/** Longest run of consecutive absent working days (no record OR status='absent'). */
function maxConsecutiveAbsences(
  from: string,
  to: string,
  statusMap: Map<string, CalendarStatus>,
  cal: WorkingCalendar,
  joinISO: string | null,
  today: string,
): number {
  const start = joinISO && joinISO > from ? joinISO : from;
  const end = today < to ? today : to; // don't count future working days
  let cur = start;
  let run = 0;
  let max = 0;
  while (cur <= end) {
    if (cal.isWorkingDay(cur)) {
      const rec = statusMap.get(cur);
      const absence = !rec || rec.status === 'absent';
      if (absence) {
        run += 1;
        if (run > max) max = run;
      } else {
        run = 0;
      }
    }
    cur = addDaysISO(cur, 1);
  }
  return max;
}

/**
 * Pure rule-based insight builder — uses attendance STATUS only (no punch data).
 * Exported for unit verification.
 */
export function buildEmployeeInsights(
  m: AttendanceMetrics,
  statusMap: Map<string, CalendarStatus>,
  cal: WorkingCalendar,
  joinISO: string | null,
  today: string,
  from: string,
  to: string,
  recordedDays: number,
): EmployeeInsight[] {
  // Nothing recorded yet — surface that instead of raising false absence alarms.
  if (m.workingDays > 0 && recordedDays === 0) {
    return [
      {
        type: 'info',
        code: 'no_data',
        title: 'No Attendance Recorded',
        detail: 'No attendance has been recorded for this employee in the selected period.',
      },
    ];
  }

  const insights: EmployeeInsight[] = [];
  const hasWork = m.workingDays > 0;
  const maxAbsRun = maxConsecutiveAbsences(from, to, statusMap, cal, joinISO, today);

  if (hasWork && m.attendancePct >= 100) {
    insights.push({
      type: 'positive',
      code: 'perfect_attendance',
      title: 'Perfect Attendance',
      detail: `100% attendance across ${m.workingDays} working day(s).`,
    });
  } else if (hasWork && m.attendancePct >= 95) {
    insights.push({
      type: 'positive',
      code: 'excellent_attendance',
      title: 'Excellent Attendance',
      detail: `${m.attendancePct}% attendance — comfortably above target.`,
    });
  }

  if (hasWork && m.attendancePct < 75) {
    insights.push({
      type: 'critical',
      code: 'at_risk',
      title: 'Attendance Below Target',
      detail: `${m.attendancePct}% attendance is below the 75% threshold.`,
    });
  } else if (hasWork && m.attendancePct >= 75 && m.attendancePct < 90) {
    insights.push({
      type: 'warning',
      code: 'attendance_watch',
      title: 'Attendance Needs Attention',
      detail: `${m.attendancePct}% attendance — worth monitoring.`,
    });
  }

  if (maxAbsRun >= 3) {
    insights.push({
      type: 'critical',
      code: 'consecutive_absences',
      title: 'Consecutive Absences',
      detail: `${maxAbsRun} working days absent in a row.`,
    });
  } else if (m.absent > 0) {
    insights.push({
      type: 'warning',
      code: 'absences',
      title: 'Absences Recorded',
      detail: `${m.absent} absent working day(s) in this period.`,
    });
  }

  if (m.late >= 3) {
    insights.push({
      type: 'warning',
      code: 'frequent_late',
      title: 'Frequent Late Arrivals',
      detail: `${m.late} late arrival(s) recorded.`,
    });
  }

  if (m.present > 0 && m.late === 0) {
    insights.push({
      type: 'positive',
      code: 'punctual',
      title: 'Always On Time',
      detail: `No late arrivals across ${m.present} present day(s).`,
    });
  }

  if (insights.length === 0) {
    insights.push({
      type: 'info',
      code: 'stable',
      title: 'Stable Attendance',
      detail: 'No attendance risks detected in this period.',
    });
  }
  return insights;
}

/**
 * Pure assembly of grouped (leave_type, status, requests, days) rows into the
 * breakdown DTO. Shared by the per-employee drill-down and the company-wide
 * export breakdown so the tally/sort logic lives in ONE place. Exported for
 * unit verification.
 */
export function assembleLeaveBreakdown(rows: any[]): EmployeeLeaveBreakdown {
  const byType = new Map<string, EmployeeLeaveBreakdownItem>();
  let totalRequests = 0;
  let totalDays = 0;
  for (const r of rows) {
    const type = String(r.leave_type || '—');
    const item =
      byType.get(type) ??
      { leaveType: type, requests: 0, days: 0, approved: 0, pending: 0, rejected: 0 };
    const reqs = num(r.requests);
    const days = num(r.days);
    item.requests += reqs;
    item.days += days;
    const st = String(r.status || '').toLowerCase();
    if (st === 'approved') item.approved += reqs;
    else if (st === 'pending') item.pending += reqs;
    else if (st === 'rejected') item.rejected += reqs;
    byType.set(type, item);
    totalRequests += reqs;
    totalDays += days;
  }
  const items = [...byType.values()].sort(
    (a, b) => b.days - a.days || a.leaveType.localeCompare(b.leaveType),
  );
  return { items, totalRequests, totalDays };
}

/** Leave breakdown for one employee, over leaves overlapping [from,to]. */
async function computeEmployeeLeaveBreakdown(
  employeeId: number,
  from: string,
  to: string,
): Promise<EmployeeLeaveBreakdown> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT l.leave_type, l.status,
       COUNT(*)::int AS requests,
       COALESCE(SUM(l.days), 0)::int AS days
     FROM leaves l
     WHERE l.employee_id = $1
       AND l.start_date::date <= $3::date
       AND l.end_date::date   >= $2::date
     GROUP BY l.leave_type, l.status;`,
    employeeId,
    from,
    to,
  );
  return assembleLeaveBreakdown(rows);
}

/**
 * Row-level status categorisation mirroring STATUS_COUNT_SELECT. Used by the
 * Employee drill-down so its metrics come from the SAME fetched attendance rows
 * as its calendar/timeline (single source of truth — see computeEmployeeDetail).
 * Each clause is an INDEPENDENT filter, exactly like the SQL COUNT … FILTER (a
 * 'late' row increments both presentFull and lateCount).
 */
function countStatusRows(rows: Array<{ status: string }>): StatusCounts {
  const c = zeroCounts();
  for (const r of rows) {
    const s = r.status;
    c.totalRows += 1;
    if (s === 'present' || s === 'late' || s === 'late_after_lunch') c.presentFull += 1;
    if (s === 'late' || s === 'late_after_lunch') c.lateCount += 1;
    if (s === 'leave_half_day') c.halfDay += 1;
    if (s === 'leave_full_day') c.fullLeave += 1;
  }
  return c;
}

/**
 * GET /hr/analytics/employee/:id — full drill-down for one employee.
 * Returns `null` when the employee id does not exist (controller → 404).
 *
 * SINGLE SOURCE OF TRUTH (F2): one attendance query (`attRows`, NOT scoped to
 * active) feeds the Overview metrics, Calendar, Timeline and Insights, so an
 * inactive employee can never return conflicting numbers across those surfaces.
 * The Leave Breakdown reads the `leaves` table (a different domain entity),
 * likewise unscoped by employment status. `computeAttendanceMetrics` (the shared
 * formula) is still reused — only the double-source count path is removed.
 */
export async function computeEmployeeDetail(
  f: AttendanceFilters,
  calendar: WorkingCalendar = createWorkingCalendar(),
): Promise<EmployeeDetailResponse | null> {
  if (f.employeeId == null) return null;
  const employeeId = f.employeeId;
  const range: Range = { from: f.from, to: f.to, days: daysBetweenInclusive(f.from, f.to) };
  const today = todayIST();

  // Profile — validates existence. Not scoped to active so the drawer resolves
  // for any employee id, consistent with the single-source attendance query below.
  const profileRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, u.name, e.employee_code, e.department, e.designation,
            e.join_date, e.phone, e.employment_status
     FROM employees e
     LEFT JOIN users u ON e.user_id = u.id
     WHERE e.id = $1
     LIMIT 1;`,
    employeeId,
  );
  if (profileRows.length === 0) return null;
  const pr = profileRows[0];
  const joinISO = pr.join_date ? toISODate(pr.join_date) : null;

  // THE single attendance dataset for this employee/window (no active filter).
  const attRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT a.date, a.status, a.leave_type, a.notes
     FROM attendance a
     WHERE a.employee_id = $1 AND a.date >= $2::date AND a.date <= $3::date
     ORDER BY a.date ASC;`,
    employeeId,
    f.from,
    f.to,
  );

  // Build the per-date lookup (calendar/insights) and status counts (metrics)
  // from the ONE dataset in a single pass.
  const statusMap = new Map<string, CalendarStatus>();
  const normalizedRows: Array<{ date: string; status: string; leaveType: string | null; notes: string | null }> = [];
  for (const r of attRows) {
    const status = String(r.status || 'absent');
    const date = toISODate(r.date);
    const leaveType = r.leave_type ?? null;
    statusMap.set(date, { status, leaveType });
    normalizedRows.push({ date, status, leaveType, notes: r.notes ?? null });
  }
  const counts = countStatusRows(normalizedRows);

  const workingDays = makeEmployeeWorkingDays(f.from, f.to, calendar)(joinISO);
  const metrics = computeAttendanceMetrics(counts, workingDays);

  const profile: EmployeeProfile = {
    employeeId,
    name: pr.name || 'Unknown',
    employeeCode: pr.employee_code || '',
    department: pr.department || '—',
    designation: pr.designation || '—',
    joinDate: joinISO,
    phone: pr.phone || null,
    employmentStatus: pr.employment_status || 'active',
  };

  const calendarMonths = buildEmployeeCalendar(f.from, f.to, statusMap, calendar, joinISO, today);

  const timeline: EmployeeTimelineEntry[] = normalizedRows
    .map((r) => ({ date: r.date, status: r.status, leaveType: r.leaveType, notes: r.notes }))
    .reverse(); // most recent first

  const leaveBreakdown = await computeEmployeeLeaveBreakdown(employeeId, f.from, f.to);
  const insights = buildEmployeeInsights(
    metrics,
    statusMap,
    calendar,
    joinISO,
    today,
    f.from,
    f.to,
    counts.totalRows,
  );

  return {
    profile,
    metrics,
    calendar: calendarMonths,
    timeline,
    leaveBreakdown,
    insights,
    today,
    range,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Export aggregations (M4.1) — reuse the same service core; no new metric math.
// Consumed by the export controller only (read-only).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Company-wide leave breakdown over leaves overlapping [from,to], scoped to
 * ACTIVE employees and honouring the department / employee filters (consistent
 * with every other analytics surface). Reuses `assembleLeaveBreakdown`.
 */
export async function computeCompanyLeaveBreakdown(
  f: AttendanceFilters,
): Promise<EmployeeLeaveBreakdown> {
  const args: any[] = [];
  const p = (v: any) => {
    args.push(v);
    return `$${args.length}`;
  };
  const pFrom = p(f.from);
  const pTo = p(f.to);
  const clauses: string[] = [
    `e.employment_status = 'active'`,
    `l.start_date::date <= ${pTo}::date`,
    `l.end_date::date   >= ${pFrom}::date`,
  ];
  if (f.department) clauses.push(`e.department = ${p(f.department)}`);
  if (f.employeeId != null) clauses.push(`l.employee_id = ${p(f.employeeId)}`);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT l.leave_type, l.status,
       COUNT(*)::int AS requests,
       COALESCE(SUM(l.days), 0)::int AS days
     FROM leaves l
     JOIN employees e ON l.employee_id = e.id
     WHERE ${clauses.join(' AND ')}
     GROUP BY l.leave_type, l.status;`,
    ...args,
  );
  return assembleLeaveBreakdown(rows);
}

/**
 * Employee report for EXPORT — every filtered row, no pagination. Reuses
 * `aggregateByEmployee` + `assembleEmployeeReport` (single page sized to the full
 * result), so the sort/metric/totals logic is identical to the paginated report.
 */
export async function computeEmployeeReportExport(
  f: AttendanceFilters,
  opts: { sort: string; order: 'asc' | 'desc'; threshold: number; search?: string },
): Promise<{ rows: EmployeeReportRow[]; totals: EmployeeReportTotals }> {
  const employees = await aggregateByEmployee(f, { search: opts.search });
  const pageSize = Math.max(1, employees.length);
  const full = assembleEmployeeReport(employees, f, {
    page: 1,
    pageSize,
    sort: opts.sort,
    order: opts.order,
    search: opts.search,
    threshold: opts.threshold,
  });
  return { rows: full.rows, totals: full.totals };
}
