import prisma from '../config/db.js';
import {
  ATTENDANCE_STATUS_LABELS, DEFAULT_STATUS, todayYmd, ymdToDate, dateToYmd,
  type AttendanceStatus,
} from './marketingAttendance.service.js';

/**
 * MK-003.3 / MK-003.4 — the ONE attendance calculation.
 *
 * The monthly calendar, the summary table and the XLSX export all call
 * `buildMonth()`. That is deliberate: the requirement is that the export match
 * the visible table exactly, and the only way to guarantee that is for there to
 * be a single place where a day is turned into a status.
 *
 * DAY CLASSIFICATION, in priority order:
 *   1. a persisted marketing_attendance row  — a real, deliberate record wins
 *   2. an approved leave covering that day   — HR fact, read-only here
 *   3. a company holiday                     — not a working day, never absent
 *   4. before the member's join date         — they did not work here yet
 *   5. in the future                         — unknown, NEVER projected as absent
 *   6. otherwise                             — the virtual Absent default
 *
 * Only 1-2 and the past working days in 6 are counted; 3, 4 and 5 are excluded
 * from BOTH numerator and denominator, which is what makes the percentage
 * meaningful for a mid-month joiner.
 */

/** What a single calendar cell is. `null` = nothing to show at all. */
export type DayKind =
  | 'present' | 'absent' | 'half_day' | 'on_leave'
  | 'holiday' | 'future' | 'before_join';

export interface DayCell {
  date: string;                 // 'YYYY-MM-DD'
  kind: DayKind;
  /** True only when a marketing_attendance row exists for this day. */
  persisted: boolean;
  checkIn: string | null;
  checkOut: string | null;
  notes: string | null;
  holidayName: string | null;
  leaveType: string | null;
  overriddenBy: number | null;
  overrideReason: string | null;
  /** Does this day count toward the attendance percentage? */
  counted: boolean;
}

export interface MemberMonth {
  userId: number;
  userName: string;
  joinDate: string | null;
  days: DayCell[];
  totals: {
    present: number;
    absent: number;
    halfDay: number;
    leave: number;
    holidays: number;
    /** Days that count toward the percentage (present + absent + halfDay + leave). */
    countedDays: number;
    /** present + halfDay/2, over countedDays. null when there is nothing to divide. */
    attendancePercent: number | null;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' → every 'YYYY-MM-DD' in it. Pure string maths: no Date, so no
 *  timezone can shift a day out of its own month. */
export function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month
  return Array.from({ length: count }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
}

export const isYearMonth = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v.trim());

/** The month containing "today" in the ERP's timezone. */
export const currentMonth = (): string => todayYmd().slice(0, 7);

const asStatus = (v: string): AttendanceStatus =>
  (['present', 'absent', 'half_day', 'on_leave'] as const).includes(v as AttendanceStatus)
    ? (v as AttendanceStatus)
    : DEFAULT_STATUS;

/**
 * Build the month for a set of users.
 *
 * Every lookup is ONE query over the whole set — attendance, leaves, holidays
 * and employee join dates — so adding members does not add queries (no N+1).
 */
export async function buildMonth(
  members: { id: number; name: string }[],
  month: string,
): Promise<MemberMonth[]> {
  const days = monthDays(month);
  if (!members.length || !days.length) return [];

  const first = days[0];
  const last = days[days.length - 1];
  const today = todayYmd();
  const userIds = members.map((m) => m.id);

  const [rows, employees, holidays] = await Promise.all([
    prisma.marketing_attendance.findMany({
      where: { user_id: { in: userIds }, attendance_date: { gte: ymdToDate(first), lte: ymdToDate(last) } },
    }),
    // join_date and the leaves link both hang off employees; one query for both.
    prisma.employees.findMany({
      where: { user_id: { in: userIds } },
      select: { id: true, user_id: true, join_date: true },
    }),
    /* Raw, and deliberately so. `company_holidays` has DRIFTED: schema.prisma
     * and initDb both declare `holiday_name`, but a table created before that
     * (CREATE TABLE IF NOT EXISTS never reconciles columns) has `name` instead —
     * the dev database is in exactly that state, and production may be either.
     * Selecting the column by name through Prisma therefore 500s on one of the
     * two shapes. `to_jsonb(row)` returns whatever columns actually exist, and
     * `to_char` keeps the date-only value from being shifted by a timezone.
     * Renaming the column is an HR-module migration, deliberately not done here. */
    prisma.$queryRaw<{ d: string; j: Record<string, unknown> }[]>`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d, to_jsonb(company_holidays.*) AS j
        FROM company_holidays
       WHERE holiday_date BETWEEN ${ymdToDate(first)}::date AND ${ymdToDate(last)}::date
    `,
  ]);

  const employeeByUser = new Map(employees.map((e) => [e.user_id!, e]));
  const leaveRows = employees.length
    ? await prisma.leaves.findMany({
        where: {
          employee_id: { in: employees.map((e) => e.id) },
          status: 'approved',
          start_date: { lte: ymdToDate(last) },
          end_date: { gte: ymdToDate(first) },
        },
        select: { employee_id: true, leave_type: true, start_date: true, end_date: true },
      })
    : [];

  const holidayByDate = new Map(
    (holidays as { d: string; j: Record<string, unknown> }[]).map((h) => [
      h.d,
      // Whichever spelling this database happens to use.
      String(h.j?.holiday_name ?? h.j?.name ?? 'Holiday'),
    ]),
  );
  const attendanceByUserDate = new Map<string, any>();
  for (const r of rows) attendanceByUserDate.set(`${r.user_id}|${dateToYmd(r.attendance_date)}`, r);

  // employee_id → the approved leave ranges, as plain 'YYYY-MM-DD' strings.
  const leavesByEmployee = new Map<number, { type: string; from: string; to: string }[]>();
  for (const l of leaveRows) {
    const list = leavesByEmployee.get(l.employee_id) ?? [];
    list.push({
      type: l.leave_type,
      from: dateToYmd(l.start_date as Date)!,
      to: dateToYmd(l.end_date as Date)!,
    });
    leavesByEmployee.set(l.employee_id, list);
  }

  return members.map((member) => {
    const employee = employeeByUser.get(member.id);
    const joinDate = employee?.join_date ? dateToYmd(employee.join_date as Date) : null;
    const memberLeaves = employee ? leavesByEmployee.get(employee.id) ?? [] : [];

    const cells: DayCell[] = days.map((date) => {
      const base: DayCell = {
        date, kind: 'absent', persisted: false, checkIn: null, checkOut: null,
        notes: null, holidayName: null, leaveType: null,
        overriddenBy: null, overrideReason: null, counted: false,
      };

      const row = attendanceByUserDate.get(`${member.id}|${date}`);
      if (row) {
        // 1. A real record always wins — nothing below may reinterpret it.
        const status = asStatus(row.status);
        return {
          ...base,
          kind: status,
          persisted: true,
          checkIn: row.check_in ? new Date(row.check_in).toISOString() : null,
          checkOut: row.check_out ? new Date(row.check_out).toISOString() : null,
          notes: row.notes ?? null,
          overriddenBy: row.overridden_by ?? null,
          overrideReason: row.override_reason ?? null,
          counted: true,
        };
      }

      // 2. Approved leave (no attendance row) reads as On Leave.
      const leave = memberLeaves.find((l) => date >= l.from && date <= l.to);
      if (leave) return { ...base, kind: 'on_leave', leaveType: leave.type, counted: true };

      // 3. Company holiday — not a working day, so neither present nor absent.
      const holiday = holidayByDate.get(date);
      if (holiday) return { ...base, kind: 'holiday', holidayName: holiday, counted: false };

      // 4. Before they joined — excluded from the denominator entirely.
      if (joinDate && date < joinDate) return { ...base, kind: 'before_join', counted: false };

      // 5. The future is unknown. NEVER projected as absent.
      if (date > today) return { ...base, kind: 'future', counted: false };

      // 6. A past working day with no record: the virtual Absent default.
      return { ...base, kind: 'absent', counted: true };
    });

    const count = (k: DayKind) => cells.filter((c) => c.kind === k).length;
    const present = count('present');
    const halfDay = count('half_day');
    const absent = count('absent');
    const leave = count('on_leave');
    const countedDays = cells.filter((c) => c.counted).length;

    return {
      userId: member.id,
      userName: member.name,
      joinDate,
      days: cells,
      totals: {
        present,
        absent,
        halfDay,
        leave,
        holidays: count('holiday'),
        countedDays,
        // A half day is half a day present. Leave is counted in the denominator
        // but not as attendance — it is authorised non-attendance.
        attendancePercent: countedDays > 0
          ? Math.round(((present + halfDay * 0.5) / countedDays) * 1000) / 10
          : null,
      },
    };
  });
}

/** Column order shared by the summary table and the XLSX export. */
export const SUMMARY_COLUMNS = [
  { key: 'userName', label: 'Team Member' },
  { key: 'present', label: 'Present' },
  { key: 'halfDay', label: 'Half-Day' },
  { key: 'absent', label: 'Absent' },
  { key: 'leave', label: 'Leave' },
  { key: 'holidays', label: 'Holidays' },
  { key: 'countedDays', label: 'Working Days' },
  { key: 'attendancePercent', label: 'Attendance %' },
] as const;

export { ATTENDANCE_STATUS_LABELS };
