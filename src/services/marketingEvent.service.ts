import type { Denial } from './contentWorkflow.service.js';

/**
 * MK-001.2 / MK-001.3 — calendar event rules.
 *
 * DATE/TIME CONTRACT (the whole reason this file exists separately):
 *
 *   - `event_date` is a DATE column. It is written at UTC midnight and read back
 *     with `ymd()`, never with `new Date(...).toLocaleDateString()` and never by
 *     slicing a timestamp built in local time. 15 September stays 15 September.
 *   - `start_time` / `end_time` are 'HH:MM' strings in the project's local wall
 *     clock — exactly how the existing `Meeting` model stores them. They are
 *     deliberately NOT timestamps: combining a date and a time into a Date is
 *     what produces the off-by-one-day bug this module has hit before.
 *
 * Nothing here touches the database, so the same rules can be applied by the
 * controller before a write and asserted in tests without a connection.
 */

export const EVENT_TYPES = ['shoot', 'meeting', 'deadline', 'publish', 'review', 'other'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<string, string> = {
  shoot: 'Shoot', meeting: 'Meeting', deadline: 'Deadline',
  publish: 'Publish', review: 'Review', other: 'Other',
};

/** Minutes a timed event lasts when the user gives a start but no end. */
export const DEFAULT_EVENT_MINUTES = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isYmd = (v: unknown): v is string => typeof v === 'string' && YMD.test(v.trim());
export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v.trim());

/** 'HH:MM' → minutes since midnight. Assumes `isHhmm` already passed. */
export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** minutes since midnight → 'HH:MM', clamped to the same day. */
export const fromMinutes = (mins: number): string => {
  const capped = Math.min(mins, 23 * 60 + 59);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
};

/**
 * A 'YYYY-MM-DD' string → the Date to store in a DATE column.
 * UTC midnight, matching how `marketing_contents.deadline` is written, so the
 * two date columns can never disagree about what day a value means.
 */
export const ymdToDate = (ymd: string): Date => new Date(`${ymd.trim()}T00:00:00.000Z`);

export interface EventInput {
  title?: unknown;
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  eventType?: unknown;
  assigneeId?: unknown;
  notes?: unknown;
}

export interface NormalisedEvent {
  title: string;
  date: string;          // 'YYYY-MM-DD'
  startTime: string | null;
  endTime: string | null;
  eventType: string | null;
  assigneeId: number | null;
  notes: string | null;
}

/** Field-keyed errors, so the client can mark the offending input rather than
 *  showing one toast for a form with six fields. */
export type FieldErrors = Record<string, string>;

export interface ValidationResult {
  value?: NormalisedEvent;
  errors?: FieldErrors;
  denial?: Denial;
}

/**
 * Validate and normalise an event payload.
 *
 * @param partial  true for PATCH-style edits: only the keys present are checked,
 *                 and the caller merges the result over the stored row.
 */
export function validateEvent(body: EventInput, existing?: NormalisedEvent): ValidationResult {
  const errors: FieldErrors = {};
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  // ── Title (required) ──────────────────────────────────────────────────────
  const title = body.title !== undefined ? str(body.title) : (existing?.title ?? '');
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 255) errors.title = 'Title must be 255 characters or fewer.';

  // ── Date (required) ───────────────────────────────────────────────────────
  let date = existing?.date ?? '';
  if (body.date !== undefined) {
    const raw = str(body.date);
    if (!raw) errors.date = 'Date is required.';
    else if (!isYmd(raw)) errors.date = 'Enter a valid date.';
    else if (Number.isNaN(ymdToDate(raw).getTime())) errors.date = 'Enter a valid date.';
    else date = raw;
  }
  if (!date && !errors.date) errors.date = 'Date is required.';

  // ── Times ─────────────────────────────────────────────────────────────────
  // '' is a deliberate clear (all-day), which is different from "not supplied".
  const readTime = (v: unknown, fallback: string | null): string | null => {
    if (v === undefined) return fallback;
    const raw = str(v);
    return raw === '' ? null : raw;
  };
  const startTime = readTime(body.startTime, existing?.startTime ?? null);
  let endTime = readTime(body.endTime, existing?.endTime ?? null);

  if (startTime !== null && !isHhmm(startTime)) errors.startTime = 'Enter a valid start time.';
  if (endTime !== null && !isHhmm(endTime)) errors.endTime = 'Enter a valid end time.';

  if (!errors.startTime && !errors.endTime) {
    if (endTime !== null && startTime === null) {
      // An end with no start has no meaning and would render as a zero-length
      // block; rejected rather than silently dropped.
      errors.startTime = 'Add a start time, or clear the end time.';
    } else if (startTime !== null && endTime === null) {
      // The stated rule: a timed event with no end lasts one hour.
      endTime = fromMinutes(toMinutes(startTime) + DEFAULT_EVENT_MINUTES);
    } else if (startTime !== null && endTime !== null) {
      // Never silently swapped — the user is told which field is wrong.
      if (toMinutes(endTime) <= toMinutes(startTime)) {
        errors.endTime = 'End time must be after the start time.';
      }
    }
  }

  // ── Optional fields ───────────────────────────────────────────────────────
  let eventType = existing?.eventType ?? null;
  if (body.eventType !== undefined) {
    const raw = str(body.eventType);
    if (raw === '') eventType = null;
    else if (!(EVENT_TYPES as readonly string[]).includes(raw)) errors.eventType = 'Choose a valid event type.';
    else eventType = raw;
  }

  let assigneeId = existing?.assigneeId ?? null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId === null || str(body.assigneeId) === '') assigneeId = null;
    else {
      const n = Number(body.assigneeId);
      if (!Number.isInteger(n) || n <= 0) errors.assigneeId = 'Choose a valid team member.';
      else assigneeId = n;
    }
  }

  const notes = body.notes !== undefined
    ? (str(body.notes) || null)
    : (existing?.notes ?? null);

  if (Object.keys(errors).length) return { errors };
  return { value: { title, date, startTime, endTime, eventType, assigneeId, notes } };
}
