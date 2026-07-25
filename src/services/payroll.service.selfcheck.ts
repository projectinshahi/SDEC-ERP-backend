/**
 * Runnable self-check for the payroll money formula (no test framework).
 *   npx tsx src/services/payroll.service.selfcheck.ts
 * Fails loudly if computePayroll / splitSalary drift from the agreed model.
 * Day/leave aggregation is DB-coupled and verified separately (Phase 2).
 */
import { computePayroll, splitSalary } from './payroll.service.js';

let failed = 0;
const near = (got: number, want: number, label: string, tol = 1e-6) => {
  if (Math.abs(got - want) > tol) {
    console.error(`✗ ${label}: got ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`✓ ${label} = ${got}`);
  }
};

// 75 / 25 split
const s = splitSalary(20000);
near(s.basicSalary, 15000, 'split.basicSalary');
near(s.dearnessAllowance, 5000, 'split.dearnessAllowance');

// Full attendance: worked = OWD → payable = full salary.
const full = computePayroll({
  basicSalary: 15000, dearnessAllowance: 5000,
  officeWorkingDays: 26, employeeWorkedDays: 26,
  fine: 0, specialAllowance: 0, providentFund: 0, bonus: 0, incentive: 0, arrears: 0,
});
near(full.grossSalary, 20000, 'full.gross');
near(full.employeeStateInsurance, 150, 'full.esi'); // 20000 × 0.75%
near(full.netSalary, 20000 - 150, 'full.net');

// Plan example: July OWD 26, present 20 + 3 paid leave → worked 23.
const owd = 26, worked = 23;
const p = computePayroll({
  basicSalary: 15000, dearnessAllowance: 5000,
  officeWorkingDays: owd, employeeWorkedDays: worked,
  fine: 500, specialAllowance: 3000, providentFund: 2168,
  bonus: 1500, incentive: 2000, arrears: 2000,
});
const ratio = worked / owd;
const gross = 20000 * ratio;
const esi = gross * 0.0075;
const totalDed = 500 + 3000 + esi + 2168;
near(p.payableBasicSalary, 15000 * ratio, 'example.payableBasic');
near(p.payableDearnessAllowance, 5000 * ratio, 'example.payableDA');
near(p.grossSalary, gross, 'example.gross');
near(p.employeeStateInsurance, esi, 'example.esi');
near(p.totalDeductions, totalDed, 'example.totalDeductions');
near(p.netSalary, gross - totalDed + 1500 + 2000 + 2000, 'example.net');

// Guard: zero Office Working Days must not divide-by-zero.
const z = computePayroll({
  basicSalary: 15000, dearnessAllowance: 5000,
  officeWorkingDays: 0, employeeWorkedDays: 0,
  fine: 0, specialAllowance: 0, providentFund: 0, bonus: 0, incentive: 0, arrears: 0,
});
near(z.grossSalary, 0, 'zeroOWD.gross');

if (failed) {
  console.error(`\n${failed} payroll self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll payroll self-checks passed.');
