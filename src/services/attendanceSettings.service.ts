import prisma from '../config/db.js';

export interface AttendanceSettingsData {
  present_color: string;
  absent_color: string;
  leave_color: string;
  half_day_color: string;
  late_color: string;
}

/**
 * Fetch the single attendance_settings row.
 * Returns defaults if the table is somehow empty.
 */
export async function getAttendanceSettings(): Promise<AttendanceSettingsData> {
  const record = await prisma.attendance_settings.findUnique({ where: { id: 1 } });
  if (record) {
    return {
      present_color: record.present_color,
      absent_color: record.absent_color,
      leave_color: record.leave_color,
      half_day_color: record.half_day_color,
      late_color: record.late_color,
    };
  }
  return {
    present_color: '#10b981',
    absent_color: '#f43f5e',
    leave_color: '#3b82f6',
    half_day_color: '#8b5cf6',
    late_color: '#f59e0b',
  };
}

/**
 * Update the single attendance_settings row.
 */
export async function updateAttendanceSettings(patch: Partial<AttendanceSettingsData>): Promise<AttendanceSettingsData> {
  const updateData: any = {};
  if (patch.present_color !== undefined) updateData.present_color = patch.present_color;
  if (patch.absent_color !== undefined) updateData.absent_color = patch.absent_color;
  if (patch.leave_color !== undefined) updateData.leave_color = patch.leave_color;
  if (patch.half_day_color !== undefined) updateData.half_day_color = patch.half_day_color;
  if (patch.late_color !== undefined) updateData.late_color = patch.late_color;
  updateData.updated_at = new Date();

  const record = await prisma.attendance_settings.upsert({
    where: { id: 1 },
    update: updateData,
    create: {
      id: 1,
      present_color: updateData.present_color ?? '#10b981',
      absent_color: updateData.absent_color ?? '#f43f5e',
      leave_color: updateData.leave_color ?? '#3b82f6',
      half_day_color: updateData.half_day_color ?? '#8b5cf6',
      late_color: updateData.late_color ?? '#f59e0b',
    },
  });

  return {
    present_color: record.present_color,
    absent_color: record.absent_color,
    leave_color: record.leave_color,
    half_day_color: record.half_day_color,
    late_color: record.late_color,
  };
}
