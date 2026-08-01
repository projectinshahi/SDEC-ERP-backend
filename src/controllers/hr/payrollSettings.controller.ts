import { Request, Response } from 'express';
import { getPayrollSettings, updatePayrollSettings } from '../../services/payrollSettings.service.js';

/** GET /api/hr/payroll/settings — the current payroll rules (for the Settings UI). */
export const getPayrollSettingsHandler = async (_req: Request, res: Response) => {
  try {
    const settings = await getPayrollSettings();
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    console.error('[Payroll Settings Get]', error);
    res.status(500).json({ success: false, message: 'Failed to load payroll settings' });
  }
};

/** PUT /api/hr/payroll/settings — update payroll rules. Applies to NEW payrolls only. */
export const updatePayrollSettingsHandler = async (req: Request, res: Response) => {
  try {
    const settings = await updatePayrollSettings(req.body ?? {});
    res.status(200).json({ success: true, message: 'Payroll settings updated', data: settings });
  } catch (error) {
    console.error('[Payroll Settings Update]', error);
    res.status(500).json({ success: false, message: 'Failed to update payroll settings' });
  }
};
