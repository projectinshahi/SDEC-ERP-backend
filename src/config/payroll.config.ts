/**
 * PAYROLL CONFIGURATION — the one place business rates live.
 *
 * Constants for now, intentionally shaped as a single object so a future version
 * can load them from a settings table with no change at call sites. `computePayroll`,
 * `splitSalary` and the worked-day aggregation all READ these instead of embedding
 * numbers. Percentages are stored as whole numbers (75 = 75%, 0.75 = 0.75%).
 */
export interface PayrollConfig {
  /** Basic Salary as a % of the employee's total salary. */
  basicSalaryPct: number;
  /** Dearness Allowance as a % of the employee's total salary. */
  dearnessAllowancePct: number;
  /** Employee State Insurance as a % of Gross Salary. */
  esiRatePct: number;
  /**
   * Provident Fund as a % of Gross Salary (eligible = payable Basic + DA).
   * When null, PF is taken from the manual `providentFund` input instead
   * (legacy records generated before PF% config existed).
   */
  providentFundRatePct: number | null;
  /** Approved leave day-units paid per month; the rest become Loss Of Pay. */
  monthlyPaidLeaveQuota: number;
}

/**
 * Compile-time DEFAULTS. Basic/DA split and the leave quota live here permanently;
 * ESI% and PF% are overridden at runtime from the payroll_settings table (see
 * payrollSettings.service.resolvePayrollConfig). Kept as the safe fallback when
 * settings can't be read.
 */
export const PAYROLL_CONFIG: PayrollConfig = {
  basicSalaryPct: 75,
  dearnessAllowancePct: 25,
  esiRatePct: 0.75,
  providentFundRatePct: 12,
  monthlyPaidLeaveQuota: 3,
};
