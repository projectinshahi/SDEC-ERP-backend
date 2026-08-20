import { Request, Response } from 'express';
import prisma from '../../config/db.js';
import { error } from 'console';

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

  const lunchOutMinutes = parseTimeToMinutes(lunchOut);
  const lunchInMinutes = parseTimeToMinutes(lunchIn);

  let lunchDeduction = 0;
  if (lunchOutMinutes != null && lunchInMinutes != null) {
    lunchDeduction = lunchInMinutes - lunchOutMinutes;
  } else {
    // Standard lunch break is 1:00 PM to 2:00 PM (13 * 60 to 14 * 60)
    const overlapStart = Math.max(inMinutes, 13 * 60);
    const overlapEnd = Math.min(outMinutes, 14 * 60);
    lunchDeduction = Math.max(0, overlapEnd - overlapStart);
  }

  total -= lunchDeduction;

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