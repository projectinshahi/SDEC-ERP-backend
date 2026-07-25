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
  /** Approved leave day-units paid per month; the rest become Loss Of Pay. */
  monthlyPaidLeaveQuota: number;
}

export const PAYROLL_CONFIG: PayrollConfig = {
  basicSalaryPct: 75,
  dearnessAllowancePct: 25,
  esiRatePct: 0.75,
  monthlyPaidLeaveQuota: 3,
};
