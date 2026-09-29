import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { getSalesAuth } from '../utils/salesAuth.js';
import { getUsersForModule } from '../utils/userScope.js';
import {
  canViewTeamAttendance, canSelfAttend, ATTENDANCE_STATUS_LABELS,
} from '../services/marketingAttendance.service.js';
import {
  buildMonth, monthDays, isYearMonth, currentMonth, SUMMARY_COLUMNS,
} from '../services/marketingAttendanceReport.service.js';

/**
 * MK-003.3 monthly calendar and MK-003.4 summary + XLSX export.
 *
 * All three read from buildMonth(), so the calendar, the on-screen table and
 * the downloaded spreadsheet cannot disagree about a single number.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Which members may this caller report on?
 *
 * Team-view permission → the whole Marketing roster. Otherwise → only
 * themselves, so a plain member can still see their own month without being
 * able to enumerate the team. The roster comes from the existing module
 * resolver, so HR-only staff never appear.
 */
async function reportableMembers(ctx: { userId: number; isAdmin: boolean; permissions: string[]; roleName: string }) {
  const roster = await getUsersForModule('marketing');
  if (canViewTeamAttendance(ctx as any)) return roster;
  return roster.filter((m) => m.id === ctx.userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/attendance/month?month=YYYY-MM&userId=
// ─────────────────────────────────────────────────────────────────────────────
export const getAttendanceMonth = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canSelfAttend(ctx) && !canViewTeamAttendance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing attendance.' });
    }

    const month = isYearMonth(req.query.month) ? String(req.query.month).trim() : currentMonth();
    const allowed = await reportableMembers(ctx);
    if (!allowed.length) {
      return res.json({ success: true, month, members: [], statuses: ATTENDANCE_STATUS_LABELS, canViewTeam: canViewTeamAttendance(ctx) });
    }

    // A userId narrows the result, but only WITHIN what the caller may already
    // see — it can never widen the scope.
    const requested = intId(req.query.userId);
    const members = requested ? allowed.filter((m) => m.id === requested) : allowed;
    if (requested && !members.length) {
      return res.status(404).json({ error: 'That member is not in your Marketing attendance scope.' });
    }

    const built = await buildMonth(members.map((m) => ({ id: m.id, name: m.name })), month);

    return res.json({
      success: true,
      month,
      days: monthDays(month),
      canViewTeam: canViewTeamAttendance(ctx),
      statusLabels: ATTENDANCE_STATUS_LABELS,
      roster: allowed.map((m) => ({ id: m.id, name: m.name })),
      members: built,
    });
  } catch (error) {
    console.error('Error building attendance month:', error);
    return res.status(500).json({ error: 'Failed to load the attendance calendar' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/attendance/summary?month=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────────
export const getAttendanceSummary = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canSelfAttend(ctx) && !canViewTeamAttendance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing attendance.' });
    }

    const month = isYearMonth(req.query.month) ? String(req.query.month).trim() : currentMonth();
    const members = await reportableMembers(ctx);
    const built = await buildMonth(members.map((m) => ({ id: m.id, name: m.name })), month);

    return res.json({
      success: true,
      month,
      columns: SUMMARY_COLUMNS,
      // An empty month is a legitimate result, not an error: every member is
      // present with zeroed counts rather than the endpoint failing.
      rows: built.map((m) => ({ userId: m.userId, userName: m.userName, joinDate: m.joinDate, ...m.totals })),
    });
  } catch (error) {
    console.error('Error building attendance summary:', error);
    return res.status(500).json({ error: 'Failed to load the attendance summary' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/attendance/summary.xlsx?month=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────────
export const exportAttendanceSummaryXlsx = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canSelfAttend(ctx) && !canViewTeamAttendance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing attendance.' });
    }

    const month = isYearMonth(req.query.month) ? String(req.query.month).trim() : currentMonth();
    const members = await reportableMembers(ctx);
    /* THE SAME call the on-screen table makes. The export cannot drift from the
     * UI because there is no second calculation to drift from — and it is scoped
     * by the same permission, so an export can never reveal rows the caller
     * could not already see. */
    const built = await buildMonth(members.map((m) => ({ id: m.id, name: m.name })), month);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SDEC ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet(`Attendance ${month}`);

    ws.columns = SUMMARY_COLUMNS.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.key === 'userName' ? 28 : 14,
    }));
    ws.getRow(1).font = { bold: true };

    for (const m of built) {
      ws.addRow({
        userName: m.userName,
        present: m.totals.present,
        halfDay: m.totals.halfDay,
        absent: m.totals.absent,
        leave: m.totals.leave,
        holidays: m.totals.holidays,
        countedDays: m.totals.countedDays,
        // null (nothing to divide) exports blank rather than a misleading 0.
        attendancePercent: m.totals.attendancePercent ?? '',
      });
    }

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="marketing-attendance-${month}.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Error exporting attendance summary:', error);
    return res.status(500).json({ error: 'Failed to export the attendance summary' });
  }
};
