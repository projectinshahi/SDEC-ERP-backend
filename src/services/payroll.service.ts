/**
 * PAYROLL SERVICE — the single source of truth for payroll money math.
 *
 * `computePayroll()` is a PURE function: given the earnings, the day snapshot
 * (Office Working Days + Employee Worked Days, produced by the attendance layer)
 * and the manual adjustments, it returns every derived figure. The controller
 * persists the returned values as an immutable snapshot; analytics reads that
 * snapshot. The frontend keeps a byte-identical mirror of `computePayroll` for
 * instant live preview only — the backend stays authoritative.
 *
 * Day aggregation (Office Working Days, Employee Worked Days, Loss Of Pay, the
 * 3-paid-leave policy) lives ONCE in attendanceAnalytics.getPayrollDayBreakdown;
 * this service consumes those numbers and never re-derives them.
 */

import { PAYROLL_CONFIG, type PayrollConfig } from '../config/payroll.config.js';

export interface PayrollComputeInput {
  // Earnings (manual, auto-filled from the 75/25 split but editable)
  basicSalary: number;
  dearnessAllowance: number;
  // Day snapshot (auto — from attendance aggregation)
  officeWorkingDays: number;
  employeeWorkedDays: number;
  // Manual adjustments
  fine: number;
  specialAllowance: number;
  providentFund: number;
  bonus: number;
  incentive: number;
  arrears: number;
}

export interface PayrollComputeResult {
  payableBasicSalary: number;
  payableDearnessAllowance: number;
  grossSalary: number;
  employeeStateInsurance: number;
  totalDeductions: number;
  netSalary: number;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Split a total salary into Basic and Dearness Allowance per config (75% / 25%). */
export function splitSalary(
  totalSalary: number,
  cfg: PayrollConfig = PAYROLL_CONFIG,
): { basicSalary: number; dearnessAllowance: number } {
  const total = n(totalSalary);
  return {
    basicSalary: total * (cfg.basicSalaryPct / 100),
    dearnessAllowance: total * (cfg.dearnessAllowancePct / 100),
  };
}

/**
 * The canonical payroll formula. Raw (unrounded) floats — round only at display.
 *   Payable Basic    = Basic / OfficeWorkingDays × WorkedDays
 *   Payable DA       = DA    / OfficeWorkingDays × WorkedDays
 *   Gross            = Payable Basic + Payable DA
 *   ESI              = Gross × 0.75%
 *   Total Deductions = Fine + Special Allowance + ESI + PF
 *   Net              = Gross − Total Deductions + Bonus + Incentive + Arrears
 */
export function computePayroll(
  input: PayrollComputeInput,
  cfg: PayrollConfig = PAYROLL_CONFIG,
): PayrollComputeResult {
  const owd = n(input.officeWorkingDays);
  const workedRatio = owd > 0 ? n(input.employeeWorkedDays) / owd : 0;

  const payableBasicSalary = n(input.basicSalary) * workedRatio;
  const payableDearnessAllowance = n(input.dearnessAllowance) * workedRatio;
  const grossSalary = payableBasicSalary + payableDearnessAllowance;
  const employeeStateInsurance = grossSalary * (cfg.esiRatePct / 100);
  const totalDeductions =
    n(input.fine) + n(input.specialAllowance) + employeeStateInsurance + n(input.providentFund);
  const netSalary =
    grossSalary - totalDeductions + n(input.bonus) + n(input.incentive) + n(input.arrears);

  return {
    payableBasicSalary,
    payableDearnessAllowance,
    grossSalary,
    employeeStateInsurance,
    totalDeductions,
    netSalary,
  };
}
