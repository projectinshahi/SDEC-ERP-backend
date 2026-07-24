import prisma from '../config/db.js';
import { revenueOpportunity } from '../utils/opportunityRevenue.js';

/**
 * SE-040/041/042 — Target + incentive engine.
 *
 * Centralises (a) period→window math for monthly/quarterly/yearly targets, (b)
 * the per-metric "actual achieved" computation (sources match the BDE dashboard
 * so progress agrees with the productivity card), and (c) the incentive-slab
 * calculation. Reused by the BDE dashboard, target history and the manager/
 * executive dashboards.
 */

export type TargetType = 'revenue' | 'deal_count' | 'calls' | 'meetings' | 'conversions';
export type PeriodType = 'monthly' | 'quarterly' | 'yearly';

export const VALID_TARGET_TYPES: TargetType[] = ['revenue', 'deal_count', 'calls', 'meetings', 'conversions'];
export const VALID_PERIOD_TYPES: PeriodType[] = ['monthly', 'quarterly', 'yearly'];

export interface PeriodWindow {
  start: Date;
  end: Date;
}

/** Validate a period string against its period type. */
export function isValidPeriod(period: string, periodType: PeriodType): boolean {
  if (periodType === 'yearly') return /^\d{4}$/.test(period);
  if (periodType === 'quarterly') return /^\d{4}-Q[1-4]$/.test(period);
  return /^\d{4}-\d{2}$/.test(period);
}

/** Derive the period type from the period string shape. */
export function inferPeriodType(period: string): PeriodType {
  if (/^\d{4}-Q[1-4]$/.test(period)) return 'quarterly';
  if (/^\d{4}$/.test(period)) return 'yearly';
  return 'monthly';
}

/** Parse a period string + type into a [start, end) window. */
export function periodWindow(period: string, periodType: PeriodType): PeriodWindow {
  const year = Number(period.slice(0, 4));
  if (periodType === 'yearly') {
    return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
  }
  if (periodType === 'quarterly') {
    const q = Number(period.slice(6, 7)) || 1;
    const startMonth = (q - 1) * 3;
    return { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + 3, 1) };
  }
  const month = Number(period.slice(5, 7)) || 1;
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

/** True when two windows overlap (used for overlapping-target validation). */
export function windowsOverlap(a: PeriodWindow, b: PeriodWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Compute the actual achieved value for a metric type within a window for an
 * owner. Sources mirror the BDE dashboard precedent:
 *   revenue     = Σ won-opportunity amount by closedAt
 *   deal_count  = count of won opportunities by closedAt
 *   calls       = lead interactions of type 'Call' by interactionDate
 *   meetings    = lead interactions of type 'Meeting' by interactionDate
 *   conversions = leads with status 'converted' by updatedAt
 *
 * Phase 3 (3B): "won deals" are now won REVENUE OPPORTUNITIES in the Pipeline
 * (Lead) — gated by `revenueOpportunity()` so early-stage leads never count. The
 * migrated opportunities are a 1:1 copy of the old deals (amount→leadValue,
 * status→oppStatus, closedAt, ownerId), so these totals equal the pre-migration
 * deal-based totals by construction.
 */
export async function computeActual(ownerId: number, type: TargetType, win: PeriodWindow): Promise<number> {
  const { start, end } = win;
  switch (type) {
    case 'revenue': {
      const opps = await prisma.lead.findMany({
        where: revenueOpportunity({ ownerId, oppStatus: 'won', closedAt: { gte: start, lt: end } }),
        select: { leadValue: true },
      });
      return opps.reduce((s, o) => s + (o.leadValue || 0), 0);
    }
    case 'deal_count':
      return prisma.lead.count({ where: revenueOpportunity({ ownerId, oppStatus: 'won', closedAt: { gte: start, lt: end } }) });
    case 'calls':
      return prisma.leadInteraction.count({ where: { authorId: ownerId, type: 'Call', interactionDate: { gte: start, lt: end } } });
    case 'meetings':
      return prisma.leadInteraction.count({ where: { authorId: ownerId, type: 'Meeting', interactionDate: { gte: start, lt: end } } });
    case 'conversions':
      return prisma.lead.count({ where: { ownerId, status: 'converted', updatedAt: { gte: start, lt: end } } });
    default:
      return 0;
  }
}

// Target Management — lifecycle status is COMPUTED, never stored, so it always
// reflects the current clock + live actuals.
export type TargetStatus = 'not_started' | 'in_progress' | 'achieved' | 'exceeded' | 'missed' | 'expired';

/** Achievement at/above this percentage is treated as "Exceeded". */
export const EXCEEDED_PCT = 110;

/**
 * Derive a target's status from its period window vs `now` and live achievement:
 *   exceeded    — achievement >= EXCEEDED_PCT (well past target, any time)
 *   achieved    — achievement >= 100 (met target, any time)
 *   not_started — window is entirely in the future (and not yet met)
 *   in_progress — window is currently active (and not yet met)
 *   missed      — window has ended unmet but with some progress
 *   expired     — window has ended with zero progress
 */
export function computeStatus(achievementPct: number, win: PeriodWindow, now: Date): TargetStatus {
  if (achievementPct >= EXCEEDED_PCT) return 'exceeded';
  if (achievementPct >= 100) return 'achieved';
  if (now < win.start) return 'not_started';
  if (now < win.end) return 'in_progress';
  return achievementPct > 0 ? 'missed' : 'expired';
}

export interface IncentiveResult {
  incentiveEarned: number;
  slabId: number | null;
  incentivePct: number | null;
  incentiveAmount: number | null;
}

const NO_INCENTIVE: IncentiveResult = { incentiveEarned: 0, slabId: null, incentivePct: null, incentiveAmount: null };

/**
 * SE-042.2 — incentive engine. Picks the owner's active slab matching the
 * achievement % (min inclusive, max exclusive; the open-ended top slab has a
 * null max), then resolves it to a value: a fixed `incentiveAmount`, or
 * `incentivePct` applied to the target value (meaningful for revenue targets).
 * Zero/negative achievement → zero incentive.
 */
export async function computeIncentive(
  ownerId: number,
  achievementPct: number,
  targetAmount: number,
): Promise<IncentiveResult> {
  if (achievementPct <= 0) return NO_INCENTIVE;
  const slabs = await prisma.incentiveSlab.findMany({ where: { ownerId, active: true } });
  const slab = slabs.find(
    (s) => achievementPct >= s.minAchievementPct && (s.maxAchievementPct == null || achievementPct < s.maxAchievementPct),
  );
  if (!slab) return NO_INCENTIVE;

  let earned = 0;
  if (slab.incentiveAmount != null) earned = slab.incentiveAmount;
  else if (slab.incentivePct != null) earned = Math.round((targetAmount * slab.incentivePct) / 100);

  return {
    incentiveEarned: earned,
    slabId: slab.id,
    incentivePct: slab.incentivePct ?? null,
    incentiveAmount: slab.incentiveAmount ?? null,
  };
}

export const targetService = {
  periodWindow,
  inferPeriodType,
  isValidPeriod,
  windowsOverlap,
  computeActual,
  computeIncentive,
  computeStatus,
  EXCEEDED_PCT,
  VALID_TARGET_TYPES,
  VALID_PERIOD_TYPES,
};
