import { Request, Response } from 'express';
import prisma from '../../config/db.js';
import { error } from 'console';
import { createWorkingCalendar } from '../../services/attendanceAnalytics.service.js';

function parseTimeTo24h(timeStr?: string | null): string | null {
  if (!timeStr) return null;
  const cleaned = timeStr.trim().toUpperCase();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2];
  const meridiem = match[3];
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m}:00`;
}

function formatTimestampTo12h(val: any): string | null {
  if (!val) return null;

  if (val instanceof Date) {
    const iso = val.toISOString();
    const match = iso.match(/T(\d{2}):(\d{2})/);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = match[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12;
      h = h ? h : 12;
      return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
    }
  } else {
    const str = String(val);
    const match = str.match(/(\d{2}):(\d{2})/);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = match[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12;
      h = h ? h : 12;
      return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
    }
  }
  return null;
}

function parseTimeToMinutes(time?: string | null) {
  if (!time) return null;

  const cleaned = time.trim().toUpperCase();
  const [timePart, modifier] = cleaned.split(' ');

  if (!timePart || !modifier) return null;

  let [hours, minutes] = timePart.split(':').map(Number);

  if (modifier === 'PM' && hours !== 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

function calculateWorkHours(
  checkIn?: string | null,
  lunchOut?: string | null,
  lunchIn?: string | null,
  checkOut?: string | null
) {
  const inMinutes = parseTimeToMinutes(checkIn);
  const outMinutes = parseTimeToMinutes(checkOut);

  if (inMinutes == null || outMinutes == null) return 0;

  let total = outMinutes - inMinutes;

  // Deduct lunch ONLY when it was ACTUALLY recorded — both punches present AND in
  // order (out before in). Two previous defects modified the real duration:
  //   1) When lunch punches were MISSING, it deducted an ASSUMED 1:00–2:00 PM lunch
  //      (a hidden, shift-dependent 15/30/45/60-min cut) → 09:00–17:00 showed 7h,
  //      not the actual 8h.
  //   2) `lunchIn - lunchOut` was applied UNGUARDED, so equal/swapped lunch punches
  //      made it NEGATIVE and `total -= negative` ADDED time (e.g. 8h → 8h15m).
  // Now: no hidden break/grace is ever added or removed; only a genuine, ordered
  // lunch is subtracted. Attendance duration = exactly what was recorded.
  const lunchOutMinutes = parseTimeToMinutes(lunchOut);
  const lunchInMinutes = parseTimeToMinutes(lunchIn);
  if (lunchOutMinutes != null && lunchInMinutes != null && lunchInMinutes > lunchOutMinutes) {
    total -= lunchInMinutes - lunchOutMinutes;
  }

  if (total < 0) total = 0; // never report a negative duration (bad/overnight data)

  return Number((total / 60).toFixed(2));
}

function determineStatus(checkIn?: string | null) {
  if (!checkIn) return 'absent';

  const minutes = parseTimeToMinutes(checkIn);

  if (minutes == null) return 'absent';

  const lateLimit = 10 * 60; // 10:00 AM

  return minutes > lateLimit ? 'late' : 'present';
}

/**
 * GET /api/hr/attendance
 */
export const getAttendance = async (_req: Request, res: Response) => {
  try {
    const attendance = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        a.*,
        to_char(a.date, 'YYYY-MM-DD') AS date_ymd,
        e.employee_code,
        e.department,
        e.designation,
        u.name
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      ORDER BY a.date DESC;
    `);

    const mapped = attendance.map(({ date_ymd, ...a }) => ({
      ...a,
      // Emit the stored calendar date as TEXT ('YYYY-MM-DD') straight from Postgres.
      // The raw `a.date` is a Date that only becomes a string via JSON toISOString(),
      // which can shift by a day under UTC conversion (server/adapter/DB timezone) —
      // making the frontend look up the wrong day and fall back to "Absent". Sending
      // the date as text removes that conversion entirely: the day is always exact.
      date: date_ymd,
      check_in: formatTimestampTo12h(a.check_in),
      lunch_out: formatTimestampTo12h(a.lunch_out),
      lunch_in: formatTimestampTo12h(a.lunch_in),
      check_out: formatTimestampTo12h(a.check_out),
    }));

    res.status(200).json({
      success: true,
      data: mapped,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch attendance',
    });
  }
};

/**
 * POST /api/hr/attendance
 */
export const saveAttendance = async (req: Request, res: Response) => {
  try {
    const {
      employee_id,
      date,
      check_in,
      lunch_out,
      lunch_in,
      check_out,
      leave_type,
      notes,
    } = req.body;

    if (!employee_id || !date) {
      return res.status(400).json({
        success: false,
        message: 'employee_id and date required',
      });
    }

    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date format' });
    }

    let status = 'present';
    let workHours = 0.0;
    let late_checkin = false;
    let late_after_lunch = false;

    if (leave_type === 'full_day') {
      status = 'leave_full_day';
      workHours = 0.0;
    } else if (leave_type === 'half_day') {
      status = 'leave_half_day';
      workHours = 3.75;
    } else {
      // Normal attendance check
      const checkInMinutes = parseTimeToMinutes(check_in);
      const lunchInMinutes = parseTimeToMinutes(lunch_in);
      const hasCheckIn = !!check_in;
      const hasLunchOut = !!lunch_out;
      const hasLunchIn = !!lunch_in;
      const hasCheckOut = !!check_out;

      late_checkin = checkInMinutes != null && checkInMinutes > 10 * 60; // 10:00 AM
      late_after_lunch = lunchInMinutes != null && lunchInMinutes > 14 * 60; // 2:00 PM

      workHours = calculateWorkHours(
        check_in,
        lunch_out,
        lunch_in,
        check_out
      );

      // ── Half Day detection (punch-based) ─────────────────────
      // Morning half: Morning In + Lunch Out, but no afternoon punches
      const morningOnly = hasCheckIn && hasLunchOut && !hasLunchIn && !hasCheckOut;
      // Afternoon half: Lunch In + Check Out, but no morning punches
      const afternoonOnly = !hasCheckIn && !hasLunchOut && hasLunchIn && hasCheckOut;

      if (morningOnly || afternoonOnly) {
        status = 'half_day';
      } else if (late_after_lunch) {
        status = 'late_after_lunch';
      } else if (late_checkin) {
        status = 'late';
      } else if (check_in) {
        status = 'present';
      } else {
        status = 'absent';
      }
    }

    // ATOMIC upsert keyed on the unique (employee_id, date). One statement, so there
    // is no read-then-write race and NO chance of a duplicate row (an earlier
    // read-then-INSERT could also throw on the unique index and leave the save
    // looking failed). A manual save therefore always persists in place for that
    // exact calendar date; `$2::date` keeps the day timezone-independent.
    await prisma.$executeRawUnsafe(
      `INSERT INTO attendance
         (employee_id, date, check_in, lunch_out, lunch_in, check_out,
          work_hours, status, late_checkin, late_after_lunch, leave_type, notes)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         check_in = EXCLUDED.check_in,
         lunch_out = EXCLUDED.lunch_out,
         lunch_in = EXCLUDED.lunch_in,
         check_out = EXCLUDED.check_out,
         work_hours = EXCLUDED.work_hours,
         status = EXCLUDED.status,
         late_checkin = EXCLUDED.late_checkin,
         late_after_lunch = EXCLUDED.late_after_lunch,
         leave_type = EXCLUDED.leave_type,
         notes = EXCLUDED.notes;`,
      Number(employee_id),
      date,
      leave_type ? null : parseTimeTo24h(check_in),
      leave_type ? null : parseTimeTo24h(lunch_out),
      leave_type ? null : parseTimeTo24h(lunch_in),
      leave_type ? null : parseTimeTo24h(check_out),
      workHours,
      status,
      late_checkin,
      late_after_lunch,
      leave_type || null,
      notes || null
    );

    res.status(200).json({
      success: true,
      message: 'Attendance saved successfully',
      workHours,
      status,
    });
  } catch (error: any) {
    // In development, dump the complete Prisma/PostgreSQL error (code, meta,
    // message, stack) so raw-query failures aren't opaque; in production keep
    // the log terse. The client response stays generic in every environment.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Save Attendance] Error:', error);
    } else {
      console.error('[Save Attendance] Error:', error?.message ?? error);
    }
    res.status(500).json({ success: false, message: 'Failed to save attendance' });
  }
};

/**
 * GET /api/hr/attendance/summary
 */
export const getAttendanceSummary = async (_req: Request, res: Response) => {
  try {
    const summary = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        status,
        COUNT(*) as count
      FROM attendance
      GROUP BY status;
    `);

    let present = 0;
    let late = 0;
    let late_after_lunch = 0;
    let leave_full_day = 0;
    let leave_half_day = 0;
    let half_day = 0;
    let absent = 0;

    summary.forEach((item) => {
      if (item.status === 'present') present = Number(item.count);
      if (item.status === 'late') late = Number(item.count);
      if (item.status === 'late_after_lunch') late_after_lunch = Number(item.count);
      if (item.status === 'leave_full_day') leave_full_day = Number(item.count);
      if (item.status === 'leave_half_day') leave_half_day = Number(item.count);
      if (item.status === 'half_day') half_day = Number(item.count);
      if (item.status === 'absent') absent = Number(item.count);
    });

    res.status(200).json({
      success: true,
      data: {
        present,
        late,
        late_after_lunch,
        leave_full_day,
        leave_half_day,
        half_day,
        absent,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch summary',
    });
  }
};

/**
 * GET /api/hr/attendance/leaves?date=YYYY-MM-DD
 *
 * Derived-attendance support: returns the APPROVED leaves that cover the given
 * selected date, for ACTIVE employees. The Daily Attendance page overlays these
 * so an employee on approved leave shows as On Leave instead of Absent. The
 * `leaves` table stays the single source of truth — nothing is materialized.
 * Gated by `hr.view` (same as the attendance list) in the router.
 */
export const getApprovedLeavesForDate = async (req: Request, res: Response) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'A valid date (YYYY-MM-DD) is required' });
    }
    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date format' });
    }

    // Overlap on calendar dates: leave covers `date` when start <= date <= end.
    // Deterministic order (full-day first, then by id) for stable output; the
    // frontend merge is also order-independent, but this keeps results reproducible.
    const leaves = await prisma.$queryRawUnsafe<any[]>(
      `SELECT l.employee_id, l.leave_type, l.half_period, l.start_date, l.end_date
         FROM leaves l
         JOIN employees e ON l.employee_id = e.id
        WHERE l.status = 'approved'
          AND e.employment_status = 'active'
          AND l.start_date::date <= $1::date
          AND l.end_date::date   >= $1::date
        ORDER BY (l.half_period IS NULL) DESC, l.id;`,
      date,
    );

    res.status(200).json({ success: true, data: leaves });
  } catch (error: any) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Approved Leaves For Date] Error:', error);
    } else {
      console.error('[Approved Leaves For Date] Error:', error?.message ?? error);
    }
    res.status(500).json({ success: false, message: 'Failed to fetch approved leaves' });
  }
};

/**
 * DELETE /api/hr/attendance/:id
 */
export const deleteAttendance = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`[Delete Attendance] Backend received ID: ${id}`);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Attendance record ID is required',
      });
    }

    const attendanceId = Number(id);
    if (isNaN(attendanceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attendance record ID',
      });
    }

    // Execute DELETE raw query
    const deleteResult = await prisma.$executeRawUnsafe(
      'DELETE FROM attendance WHERE id = $1;',
      attendanceId
    );

    console.log(`[Delete Attendance] DB delete result: ${deleteResult} row(s) deleted`);

    if (deleteResult === 0) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Attendance record deleted successfully',
    });
  } catch (error: any) {
    console.error('[Delete Attendance] Error:', error?.message ?? error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete attendance record',
    });
  }
};
/**
 * GET /api/hr/attendance/me?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * EMPLOYEE SELF-SERVICE (read-only). The employee is resolved from the
 * AUTHENTICATED session (req.userId) — a client-supplied id is never trusted, so
 * one employee can never read another's data by changing a param/body/URL.
 *
 * Single source of truth: reads the SAME `attendance` rows, `work_hours`,
 * `to_char` date and 12h time formatting as the HR/Admin module, so a given day
 * shows an identical status/times/hours in both views. A working day (Mon–Sat,
 * non-holiday, up to today) with NO record is shown as Absent — the existing
 * "missing working day = Absent" rule — never a fabricated future/holiday Absent.
 */
export const getMyAttendance = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);
    if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated' });

    // 1. Resolve THIS employee from the session (authorization boundary).
    const empRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT e.id, e.employee_code, e.department, e.designation, u.name
         FROM employees e LEFT JOIN users u ON e.user_id = u.id
        WHERE e.user_id = $1 LIMIT 1;`,
      userId,
    );
    if (!empRows.length) {
      // A VALID, authenticated user who genuinely has no employee row (employees.user_id
      // is the sole User↔Employee link and none points at this user). Return 200 with an
      // explicit flag — NOT a 404/error — so the client can show the dedicated
      // "no employee profile" state, cleanly separate from a network/server error or a
      // still-loading state. Only THIS branch should ever produce that message.
      return res.status(200).json({ success: true, hasEmployee: false });
    }
    const employee = empRows[0];

    // 2. Date range — LOCAL (Asia/Kolkata) calendar dates, same convention as the
    //    rest of the Attendance module. Defaults to the current month.
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const start = isYmd(req.query.startDate) ? req.query.startDate : `${today.slice(0, 7)}-01`;
    const endReq = isYmd(req.query.endDate) ? req.query.endDate : today;
    if (endReq < start) return res.status(400).json({ success: false, message: 'endDate must not be before startDate.' });

    // 3. This employee's attendance rows in range (same mapping as getAttendance).
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT a.*, to_char(a.date, 'YYYY-MM-DD') AS date_ymd
         FROM attendance a
        WHERE a.employee_id = $1 AND a.date::date BETWEEN $2::date AND $3::date
        ORDER BY a.date ASC;`,
      employee.id, start, endReq,
    );
    const byDate = new Map<string, any>(rows.map((r) => [r.date_ymd, r]));

    // 4. Company holidays in range → working calendar (Sundays + holidays excluded).
    const hol = await prisma.$queryRawUnsafe<any[]>(
      `SELECT holiday_date::text AS d FROM company_holidays
        WHERE is_optional = false AND holiday_date BETWEEN $1::date AND $2::date;`,
      start, endReq,
    );
    const cal = createWorkingCalendar({ holidays: new Set(hol.map((h) => h.d)) });

    // 5. Daily list over WORKING days up to today (future days are never "Absent").
    const listEnd = endReq < today ? endReq : today;
    const addDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
    const daily: any[] = [];
    for (let cur = start; cur <= listEnd; cur = addDay(cur)) {
      if (!cal.isWorkingDay(cur)) continue; // skip Sundays + holidays (not shown as Absent)
      const rec = byDate.get(cur);
      daily.push(rec
        ? {
            date: cur,
            check_in: formatTimestampTo12h(rec.check_in),
            lunch_out: formatTimestampTo12h(rec.lunch_out),
            lunch_in: formatTimestampTo12h(rec.lunch_in),
            check_out: formatTimestampTo12h(rec.check_out),
            work_hours: rec.work_hours,
            status: rec.status,
            late_checkin: rec.late_checkin,
            late_after_lunch: rec.late_after_lunch,
            leave_type: rec.leave_type,
          }
        : { date: cur, check_in: null, lunch_out: null, lunch_in: null, check_out: null, work_hours: 0, status: 'absent', late_checkin: false, late_after_lunch: false, leave_type: null });
    }

    // 6. Summary — tallied from the SAME daily rows (reconciles with the list).
    let present = 0, absent = 0, halfDay = 0, fullDayLeave = 0, lateMarks = 0, totalHours = 0;
    for (const d of daily) {
      const st = d.status;
      if (st === 'present' || st === 'late' || st === 'late_after_lunch') present++;
      else if (st === 'half_day' || st === 'leave_half_day') halfDay++;
      else if (st === 'leave_full_day') fullDayLeave++;
      else if (st === 'absent') absent++;
      if (st === 'late' || st === 'late_after_lunch') lateMarks++;
      totalHours += Number(d.work_hours) || 0;
    }
    const workingDays = daily.length;
    const presentEquivalent = present + 0.5 * halfDay + fullDayLeave;
    const attendancePct = workingDays > 0 ? Math.round((presentEquivalent / workingDays) * 1000) / 10 : 0;

    // 7. This employee's leave requests overlapping the range (leaves = source of truth).
    const leaves = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, leave_type,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD')   AS end_date,
              days, status, half_period
         FROM leaves
        WHERE employee_id = $1 AND start_date::date <= $3::date AND end_date::date >= $2::date
        ORDER BY start_date DESC;`,
      employee.id, start, endReq,
    );

    return res.status(200).json({
      success: true,
      hasEmployee: true,
      employee: { name: employee.name, employee_code: employee.employee_code, department: employee.department, designation: employee.designation },
      range: { startDate: start, endDate: endReq },
      summary: { workingDays, present, absent, halfDay, fullDayLeave, lateMarks, totalHours: Number(totalHours.toFixed(2)), attendancePct },
      daily,
      leaves,
    });
  } catch (err) {
    console.error('Error building My Attendance:', err);
    return res.status(500).json({ success: false, message: 'Failed to load your attendance.' });
  }
};
