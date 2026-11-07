import prisma from '../config/db.js';

export interface AttendanceSettingsData {
  present_color: string;
  absent_color: string;
  leave_color: string;
  half_day_color: string;
  late_color: string;
  /** Scheduled lunch break start, 24h "HH:mm" (default 13:00). A form default, never a punch. */
  lunch_start_time: string;
  /** Scheduled lunch break end / expected return, 24h "HH:mm" (default 14:00). The late-after-lunch threshold. */
  lunch_end_time: string;
}

export const ATTENDANCE_SETTINGS_DEFAULTS: AttendanceSettingsData = {
  present_color: '#10b981',
  absent_color: '#f43f5e',
  leave_color: '#3b82f6',
  half_day_color: '#8b5cf6',
  late_color: '#f59e0b',
  lunch_start_time: '13:00',
  lunch_end_time: '14:00',
};

const KEYS = Object.keys(ATTENDANCE_SETTINGS_DEFAULTS) as (keyof AttendanceSettingsData)[];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A client-side mistake (→ 400), as opposed to a DB failure (→ 500). */
export class AttendanceSettingsValidationError extends Error {}

/** "14:00" → 840 (minutes since midnight). */
export function hhmmToMinutes(hhmm: string): number {
  if (!HHMM.test(hhmm)) throw new Error(`Invalid HH:mm time: ${hhmm}`);
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "14:00" → "02:00 PM" (the 12h style the attendance API emits). */
export function hhmmTo12h(hhmm: string): string {
  const [hStr, m] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
}

function pick(record: Record<string, any> | null): AttendanceSettingsData {
  const out = { ...ATTENDANCE_SETTINGS_DEFAULTS };
  if (record) for (const k of KEYS) if (record[k] != null) out[k] = record[k];
  return out;
}

/**
 * Fetch the single attendance_settings row.
 * Returns defaults if the table is somehow empty.
 */
export async function getAttendanceSettings(): Promise<AttendanceSettingsData> {
  return pick(await prisma.attendance_settings.findUnique({ where: { id: 1 } }));
}

/** The configured late-after-lunch threshold, in minutes since midnight (default 840 = 02:00 PM). */
export async function getLunchEndMinutes(): Promise<number> {
  return hhmmToMinutes((await getAttendanceSettings()).lunch_end_time);
}

/** Validated against the MERGED result, so start < end holds even when only one side is patched. */
function validate(merged: AttendanceSettingsData) {
  for (const k of ['lunch_start_time', 'lunch_end_time'] as const) {
    if (typeof merged[k] !== 'string' || !HHMM.test(merged[k])) {
      throw new AttendanceSettingsValidationError(`${k} must be a 24-hour time in HH:mm format`);
    }
  }
  if (hhmmToMinutes(merged.lunch_start_time) >= hhmmToMinutes(merged.lunch_end_time)) {
    throw new AttendanceSettingsValidationError('Lunch break start must be earlier than lunch break end');
  }
}

/**
 * Update the single attendance_settings row. Only known keys are written; the
 * lunch times are validated server-side (format + ordering) before any write.
 */
export async function updateAttendanceSettings(patch: Partial<AttendanceSettingsData>): Promise<AttendanceSettingsData> {
  const updateData: Record<string, any> = {};
  for (const k of KEYS) {
    if (patch[k] === undefined) continue;
    if (typeof patch[k] !== 'string') throw new AttendanceSettingsValidationError(`${k} must be a string`);
    updateData[k] = patch[k];
  }
  validate({ ...(await getAttendanceSettings()), ...updateData });
  updateData.updated_at = new Date();

  const record = await prisma.attendance_settings.upsert({
    where: { id: 1 },
    update: updateData,
    create: { id: 1, ...ATTENDANCE_SETTINGS_DEFAULTS, ...updateData },
  });
  return pick(record);
}
