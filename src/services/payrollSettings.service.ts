/**
 * PAYROLL SETTINGS SERVICE — the runtime source of configurable payroll rules.
 *
 * A single row (id = 1) in `payroll_settings` holds HR-editable rates/rules. Only
 * PF% and ESI% currently FEED the calculation (via resolvePayrollConfig →
 * computePayroll); the rest (professional tax, TDS, overtime, late/half-day/LOP
 * rules) are STORED for now and wired in later — the schema and this service are
 * shaped so adding a rule to the formula is a small, localized change.
 *
 * Money rules that must stay faithful to each payroll are ALSO snapshotted onto
 * the payroll row at generation (pf_pct, esi_pct) so editing an old record uses the
 * rate it was generated with, never the latest settings.
 */

import prisma from '../config/db.js';
import { PAYROLL_CONFIG, type PayrollConfig } from '../config/payroll.config.js';

export interface PayrollSettings {
  providentFundPct: number; // feeds calc: PF = Gross × this%
  esiPct: number; // feeds calc: ESI = Gross × this%
  professionalTax: number; // reserved (flat ₹/month)
  tdsPct: number; // reserved (% of Gross)
  overtimeRate: number; // reserved (₹ per OT hour)
  lateDeductionRule: string; // reserved (rule text/value)
  halfDayRule: string; // reserved (day-unit rule, default "0.5")
  lossOfPayRule: string; // reserved (rule text, default "OWD - WorkedDays")
}

const DEFAULTS: PayrollSettings = {
  providentFundPct: 12,
  esiPct: 0.75,
  professionalTax: 0,
  tdsPct: 0,
  overtimeRate: 0,
  lateDeductionRule: '',
  halfDayRule: '0.5',
  lossOfPayRule: 'OWD - WorkedDays',
};

const num = (v: unknown, fallback: number): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/** Read the settings row, falling back to DEFAULTS for any missing value. */
export async function getPayrollSettings(): Promise<PayrollSettings> {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM payroll_settings WHERE id = 1 LIMIT 1;`,
    );
    if (!rows.length) return { ...DEFAULTS };
    const r = rows[0];
    return {
      providentFundPct: num(r.provident_fund_pct, DEFAULTS.providentFundPct),
      esiPct: num(r.esi_pct, DEFAULTS.esiPct),
      professionalTax: num(r.professional_tax, DEFAULTS.professionalTax),
      tdsPct: num(r.tds_pct, DEFAULTS.tdsPct),
      overtimeRate: num(r.overtime_rate, DEFAULTS.overtimeRate),
      lateDeductionRule: r.late_deduction_rule ?? DEFAULTS.lateDeductionRule,
      halfDayRule: r.half_day_rule ?? DEFAULTS.halfDayRule,
      lossOfPayRule: r.loss_of_pay_rule ?? DEFAULTS.lossOfPayRule,
    };
  } catch {
    // Table missing / DB error → safe defaults so payroll never hard-fails.
    return { ...DEFAULTS };
  }
}

/**
 * Merge current settings into a PayrollConfig for computePayroll. Basic/DA split
 * and the leave quota stay from the compile-time config; ESI% and PF% come from
 * the settings row.
 */
export async function resolvePayrollConfig(): Promise<PayrollConfig> {
  const s = await getPayrollSettings();
  return {
    ...PAYROLL_CONFIG,
    esiRatePct: s.esiPct,
    providentFundRatePct: s.providentFundPct,
  };
}

/** Partial update of the settings row (only provided keys change). Numbers are
 *  clamped to ≥ 0; unknown keys are ignored. */
export async function updatePayrollSettings(patch: Partial<PayrollSettings>): Promise<PayrollSettings> {
  const current = await getPayrollSettings();
  const nn = (v: unknown, fb: number) => Math.max(0, num(v, fb));
  const merged: PayrollSettings = {
    providentFundPct: patch.providentFundPct != null ? nn(patch.providentFundPct, current.providentFundPct) : current.providentFundPct,
    esiPct: patch.esiPct != null ? nn(patch.esiPct, current.esiPct) : current.esiPct,
    professionalTax: patch.professionalTax != null ? nn(patch.professionalTax, current.professionalTax) : current.professionalTax,
    tdsPct: patch.tdsPct != null ? nn(patch.tdsPct, current.tdsPct) : current.tdsPct,
    overtimeRate: patch.overtimeRate != null ? nn(patch.overtimeRate, current.overtimeRate) : current.overtimeRate,
    lateDeductionRule: patch.lateDeductionRule != null ? String(patch.lateDeductionRule) : current.lateDeductionRule,
    halfDayRule: patch.halfDayRule != null ? String(patch.halfDayRule) : current.halfDayRule,
    lossOfPayRule: patch.lossOfPayRule != null ? String(patch.lossOfPayRule) : current.lossOfPayRule,
  };

  await prisma.$executeRawUnsafe(
    `INSERT INTO payroll_settings
       (id, provident_fund_pct, esi_pct, professional_tax, tds_pct, overtime_rate,
        late_deduction_rule, half_day_rule, loss_of_pay_rule, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       provident_fund_pct = EXCLUDED.provident_fund_pct,
       esi_pct            = EXCLUDED.esi_pct,
       professional_tax   = EXCLUDED.professional_tax,
       tds_pct            = EXCLUDED.tds_pct,
       overtime_rate      = EXCLUDED.overtime_rate,
       late_deduction_rule = EXCLUDED.late_deduction_rule,
       half_day_rule       = EXCLUDED.half_day_rule,
       loss_of_pay_rule    = EXCLUDED.loss_of_pay_rule,
       updated_at          = NOW();`,
    merged.providentFundPct,
    merged.esiPct,
    merged.professionalTax,
    merged.tdsPct,
    merged.overtimeRate,
    merged.lateDeductionRule,
    merged.halfDayRule,
    merged.lossOfPayRule,
  );
  return merged;
}
