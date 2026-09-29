import prisma from '../config/db.js';
import { can, type SalesAuthContext } from '../utils/salesAuth.js';

/**
 * MK-003 — Marketing attendance rules.
 *
 * Deliberately separate from the HR attendance module: that one is keyed on
 * `employees` and owned by HR. Nothing in this file reads or writes an HR
 * attendance row. The only HR table touched is `leaves`, read-only, to prove an
 * "On Leave" claim.
 */

export const ATTENDANCE_STATUSES = ['present', 'absent', 'half_day', 'on_leave'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  half_day: 'Half-Day',
  on_leave: 'On Leave',
};

/**
 * The DEFAULT state of a day with no record.
 *
 * It is virtual. No row is ever written to represent it, so a background job or
 * a page load can never overwrite real attendance with a default — the only way
 * a row exists is a deliberate check-in or a manager override.
 */
export const DEFAULT_STATUS: AttendanceStatus = 'absent';

/* ── Permission keys ─────────────────────────────────────────────────────── */
/** Check in / out for YOURSELF. */
export const ATTENDANCE_SELF_KEY = 'marketing.attendance.self';
/** See the team's attendance. */
export const ATTENDANCE_VIEW_KEY = 'marketing.attendance.view';
/** Manually set another member's record (manager). */
export const ATTENDANCE_OVERRIDE_KEY = 'marketing.attendance.override';

export const canSelfAttend = (ctx: SalesAuthContext) => can(ctx, ATTENDANCE_SELF_KEY);
export const canViewTeamAttendance = (ctx: SalesAuthContext) => can(ctx, ATTENDANCE_VIEW_KEY);
export const canOverrideAttendance = (ctx: SalesAuthContext) => can(ctx, ATTENDANCE_OVERRIDE_KEY);

/**
 * How many days into the past a non-Admin may override.
 *
 * The backlog says "editing a record more than N days in the past requires Admin
 * permission" but never defines N, and no such window is configured anywhere in
 * this codebase (searched: no edit-window / backdate / retro setting exists).
 *
 * Guessing a number would silently invent a business rule, so this is left
 * explicitly UNCONFIGURED. `null` means "no threshold is defined", and
 * `pastDateDenial` below skips only the threshold test while still enforcing
 * every rule that IS defined (self-service is today-only; overrides need the
 * override permission and a reason).
 *
 * Set this to a number — or move it to a settings row — the day the business
 * decides what N is, and the check below starts applying with no other change.
 */
export const HISTORICAL_EDIT_WINDOW_DAYS: number | null = null;

/* ── Dates ───────────────────────────────────────────────────────────────── */

/**
 * "Today" in the ERP's operating timezone.
 *
 * Identical to the expression the HR attendance module already uses, so the two
 * can never disagree about which calendar day it is. NOT `toISOString()`, which
 * would roll over at 05:30 local and put early-morning check-ins on yesterday.
 */
export const todayYmd = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export const isYmd = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** 'YYYY-MM-DD' → the value to store in a DATE column (UTC midnight). */
export const ymdToDate = (ymd: string): Date => new Date(`${ymd.trim()}T00:00:00.000Z`);

/** DATE column → 'YYYY-MM-DD'. @db.Date is UTC midnight, so slicing is exact. */
export const dateToYmd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Whole days between two 'YYYY-MM-DD' strings (a - b). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((ymdToDate(a).getTime() - ymdToDate(b).getTime()) / 86_400_000);

export interface Denial { status: number; message: string }

/**
 * THE INVARIANT for an attendance row, and the reason P2-1 existed:
 *
 *   `status` is OWNED by whoever last decided it. Once a manager override has
 *   set it, only another override may change it.
 *   `check_in` / `check_out` are timestamps. They record when someone arrived
 *   and left, and must never rewrite an overridden `status`.
 *
 * Before this, checkIn() guarded on `existing.check_in` alone. A manager
 * override sets `status` WITHOUT a check_in, so the guard did not fire and the
 * upsert wrote `status: 'present'` over the override — while leaving
 * `overridden_by` / `override_reason` attached. The row then simultaneously
 * claimed "Present" and "a manager set this, because: <reason>".
 *
 * The chosen resolution (one of the options the requirement allows) is to BLOCK
 * self check-in on an overridden day and tell the user to talk to their manager.
 * Check-OUT stays allowed, because it only stamps a time and never touches
 * `status`, so it cannot contradict the override.
 */
export const isOverridden = (row: { overridden_by?: number | null } | null | undefined): boolean =>
  !!row?.overridden_by;

/** Refusal used when self-service would otherwise overwrite a manager's decision. */
export const overriddenDenial = (): Denial => ({
  status: 409,
  message: 'A manager has already set your attendance for today. Ask them to change it if it is wrong.',
});

/**
 * May this actor write a record for `targetUserId` on `date`?
 *
 * Three distinct cases, in order of privilege:
 *   • self, today            → needs the self key. This is check-in/check-out.
 *   • self, any other day    → refused. A member cannot back-date their own
 *                              attendance through the UI or the API.
 *   • somebody else, any day → a manager override: needs the override key AND a
 *                              reason, and is subject to the (unconfigured)
 *                              historical window for non-Admins.
 */
export function checkWritable(
  ctx: SalesAuthContext,
  targetUserId: number,
  date: string,
  opts: { isOverride: boolean; reason?: string | null },
): Denial | null {
  const today = todayYmd();

  if (!isYmd(date)) return { status: 400, message: 'Enter a valid date.' };
  if (date > today) return { status: 400, message: 'Attendance cannot be recorded for a future date.' };

  const isSelf = targetUserId === ctx.userId;

  if (!opts.isOverride) {
    if (!isSelf) return { status: 403, message: 'You can only record your own attendance.' };
    if (!canSelfAttend(ctx)) return { status: 403, message: 'You do not have permission to record attendance.' };
    // The whole point of the self-service restriction.
    if (date !== today) {
      return { status: 403, message: 'You can only record attendance for today. Ask a manager to correct an earlier day.' };
    }
    return null;
  }

  // ── Manager / Admin override ────────────────────────────────────────────
  if (!canOverrideAttendance(ctx)) {
    return { status: 403, message: 'You do not have permission to override attendance.' };
  }
  if (!opts.reason || !opts.reason.trim()) {
    return { status: 400, message: 'A reason is required for a manual attendance change.' };
  }

  // Only applies once the business defines N — see HISTORICAL_EDIT_WINDOW_DAYS.
  if (HISTORICAL_EDIT_WINDOW_DAYS !== null && !ctx.isAdmin) {
    const age = daysBetween(today, date);
    if (age > HISTORICAL_EDIT_WINDOW_DAYS) {
      return {
        status: 403,
        message: `Editing attendance more than ${HISTORICAL_EDIT_WINDOW_DAYS} days in the past requires an Administrator.`,
      };
    }
  }
  return null;
}

/**
 * The approved leave covering `date` for this USER, or null.
 *
 * `leaves` is keyed on `employees`, so the user is resolved through
 * `employees.user_id`. A Marketing member with no employee record simply has no
 * approved leave — which correctly means they cannot be marked On Leave.
 */
export async function findApprovedLeave(userId: number, date: string): Promise<{ id: number; leave_type: string } | null> {
  const employee = await prisma.employees.findFirst({ where: { user_id: userId }, select: { id: true } });
  if (!employee) return null;

  const day = ymdToDate(date);
  const rows = await prisma.leaves.findMany({
    where: {
      employee_id: employee.id,
      status: 'approved',
      start_date: { lte: day },
      end_date: { gte: day },
    },
    select: { id: true, leave_type: true },
    take: 1,
  });
  return rows[0] ?? null;
}

/**
 * Validate a status change, resolving the leave link when required.
 * "On Leave" is a claim about an HR fact, so it must be backed by one.
 */
export async function resolveStatus(
  status: string,
  userId: number,
  date: string,
): Promise<{ status: AttendanceStatus; leaveId: number | null } | Denial> {
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
    return { status: 400, message: 'Choose a valid attendance status.' };
  }
  const value = status as AttendanceStatus;

  if (value !== 'on_leave') return { status: value, leaveId: null };

  const leave = await findApprovedLeave(userId, date);
  if (!leave) {
    return {
      status: 400,
      message: 'On Leave requires an approved leave request covering that date. None was found for this member.',
    };
  }
  return { status: value, leaveId: leave.id };
}

const isDenial = (v: unknown): v is Denial =>
  typeof v === 'object' && v !== null && 'status' in v && 'message' in v && typeof (v as Denial).status === 'number';
export { isDenial };
