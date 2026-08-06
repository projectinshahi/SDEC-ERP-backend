import { Request, Response } from 'express';
import { getAttendanceSettings, updateAttendanceSettings } from '../../services/attendanceSettings.service.js';

/** GET /api/hr/attendance/settings */
export const getAttendanceSettingsHandler = async (_req: Request, res: Response) => {
  try {
    const settings = await getAttendanceSettings();
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    console.error('[Attendance Settings Get]', error);
    res.status(500).json({ success: false, message: 'Failed to load attendance settings' });
  }
};

/** PUT /api/hr/attendance/settings */
export const updateAttendanceSettingsHandler = async (req: Request, res: Response) => {
  try {
    const settings = await updateAttendanceSettings(req.body ?? {});
    res.status(200).json({ success: true, message: 'Attendance settings updated', data: settings });
  } catch (error) {
    console.error('[Attendance Settings Update]', error);
    res.status(500).json({ success: false, message: 'Failed to update attendance settings' });
  }
};
