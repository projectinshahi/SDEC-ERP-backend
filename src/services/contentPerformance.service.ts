import type { SalesAuthContext } from '../utils/salesAuth.js';
import { can } from '../utils/salesAuth.js';
import type { Denial } from './contentWorkflow.service.js';
import { PUBLISHED_STAGE } from './contentStage.service.js';

/**
 * M09 #41/#42 — Performance & Analytics.
 *
 * THE single authority for: which metrics exist, how they validate, when they
 * may be edited, and — critically — what "has performance data" means. That last
 * rule is used by BOTH the metrics writer and the Awaiting Performance Data
 * filter, so the board, the list and the deadline view can never disagree about
 * which cards are still missing numbers.
 */

/** Stage 10 of the canonical pipeline. */
export const ANALYTICS_STAGE = 'analytics';

/** Performance may be recorded once the card is Published, and stays available
 *  after it moves on to Performance / Analytics. */
export const PERFORMANCE_STAGES: readonly string[] = [PUBLISHED_STAGE, ANALYTICS_STAGE];

/**
 * The numeric metrics. `shootOnly` marks metrics that apply solely to Reel and
 * Video — Watch Time is the only one today, and it is driven by CONTENT TYPE,
 * never by the stage the card happens to be in.
 */
export const PERFORMANCE_METRICS = [
  { key: 'reach', label: 'Reach' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'views', label: 'Views' },
  { key: 'watchTimeSeconds', label: 'Watch Time', shootOnly: true, unit: 'seconds' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
  { key: 'profileVisits', label: 'Profile Visits' },
  { key: 'leads', label: 'Leads' },
  { key: 'messages', label: 'Messages' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'adSpend', label: 'Ad Spend', currency: true },
] as const;

export type PerformanceMetricKey = (typeof PERFORMANCE_METRICS)[number]['key'];

/** Free-text learnings. Named `learnings` because that is the key already in use. */
export const NOTES_KEY = 'learnings';

/**
 * Legacy keys written before this module existed. They are still counted as
 * real performance data so an older card is never wrongly reported as awaiting
 * numbers, and they are never deleted.
 */
export const LEGACY_METRIC_KEYS = ['engagement', 'conversion'] as const;

const ALL_NUMERIC_KEYS: readonly string[] = [
  ...PERFORMANCE_METRICS.map((m) => m.key),
  ...LEGACY_METRIC_KEYS,
];

/** Watch Time is only meaningful for the shoot-side content types. */
export const metricApplies = (metric: { key: string; shootOnly?: boolean }, format?: string | null): boolean =>
  !metric.shootOnly || format === 'reel' || format === 'video';

export interface FieldError { field: string; message: string }
export type PerformanceMetrics = Record<string, unknown>;

/**
 * THE "has performance data" rule.
 *
 * A card has data when ANY numeric metric holds a real number, or the notes
 * field holds non-empty text. Crucially, ZERO IS DATA: `likes: 0` means the
 * metric was entered and its value is zero, which is a completely different
 * statement from "nobody has looked yet". Missing is null/undefined/''.
 */
export function hasPerformanceData(metrics: unknown): boolean {
  if (!metrics || typeof metrics !== 'object') return false;
  const m = metrics as PerformanceMetrics;
  for (const key of ALL_NUMERIC_KEYS) {
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) return true;
  }
  const notes = m[NOTES_KEY];
  return typeof notes === 'string' && notes.trim().length > 0;
}

/**
 * Merge a metrics patch.
 *
 * • Only keys present in the patch are touched — saving Reach alone can never
 *   blank the other twelve metrics.
 * • '' / null CLEAR a metric back to the missing state; 0 stores a real zero.
 * • Negative and non-numeric values are reported, never coerced to 0.
 * • A metric that does not apply to this Content Type is rejected as input but
 *   any previously stored value is preserved, matching how production_data
 *   already survives a Content Type change.
 */
export function mergeMetrics(
  existing: unknown,
  patch: unknown,
  format: string | null | undefined,
): { data: PerformanceMetrics; errors: FieldError[] } {
  const base: PerformanceMetrics = (existing && typeof existing === 'object' ? { ...(existing as PerformanceMetrics) } : {});
  const errors: FieldError[] = [];
  if (!patch || typeof patch !== 'object') return { data: base, errors };
  const p = patch as PerformanceMetrics;

  for (const metric of PERFORMANCE_METRICS) {
    if (!(metric.key in p)) continue;
    const raw = p[metric.key];

    if (raw === null || raw === '' || raw === undefined) {
      base[metric.key] = null;                 // explicitly cleared, not zero
      continue;
    }
    if (!metricApplies(metric, format)) {
      errors.push({ field: metric.key, message: `${metric.label} applies only to Reel and Video content.` });
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      errors.push({ field: metric.key, message: `${metric.label} must be a number.` });
      continue;
    }
    if (n < 0) {
      errors.push({ field: metric.key, message: `${metric.label} cannot be negative.` });
      continue;
    }
    base[metric.key] = n;
  }

  if (NOTES_KEY in p) {
    const raw = p[NOTES_KEY];
    // Free text: only the outer whitespace is trimmed, so paragraphs and line
    // breaks in the learnings survive verbatim. No length cap is imposed.
    base[NOTES_KEY] = typeof raw === 'string' ? (raw.trim() || null) : null;
  }
  return { data: base, errors };
}

export const canEditPerformance = (ctx: SalesAuthContext): boolean =>
  can(ctx, 'marketing.content.analytics') || can(ctx, 'marketing.content.edit');

export interface PerformanceCard { stage: string; format?: string | null }

/**
 * Performance may only be recorded on a Published (or Analytics) card, checked
 * against the PERSISTED stage — so an earlier-stage card cannot be given
 * numbers through a direct API call.
 */
export function checkPerformanceEditable(ctx: SalesAuthContext, card: PerformanceCard): Denial | null {
  if (!canEditPerformance(ctx)) {
    return { status: 403, message: 'You do not have permission to edit performance analytics.' };
  }
  if (!PERFORMANCE_STAGES.includes(card.stage)) {
    return { status: 409, message: 'Performance data can only be recorded once the card is Published.' };
  }
  return null;
}
