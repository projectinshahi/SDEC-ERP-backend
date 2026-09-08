import type { SalesAuthContext } from '../utils/salesAuth.js';
import { can } from '../utils/salesAuth.js';
import { isValidUrl, type Denial } from './contentWorkflow.service.js';
import { SCHEDULED_STAGE, PUBLISHED_STAGE } from './contentStage.service.js';

/**
 * M08 — Scheduling (#38) and the Publishing Record (#39).
 *
 * THE single authority for what a schedule requires, who may publish, and what
 * the publishing event records. Both flows persist into the EXISTING
 * `stage_data` JSONB the detail page already reads, and both route their stage
 * change through the shared `applyStageMove` service — there is no second
 * pipeline and no second audit trail.
 *
 * Three concepts are kept deliberately separate:
 *   • stage_data.schedule      — what was PLANNED (editable)
 *   • stage_data.published     — per-platform links (editable)
 *   • stage_data.publishRecord — the actual publication EVENT (write-once)
 *
 * Nothing here posts to an external social platform. Scheduling records intent
 * inside the ERP only.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Date-only and time-only values stay STRINGS end to end ('YYYY-MM-DD' /
 * 'HH:MM'), exactly as every other date field in this module. They are never
 * routed through `new Date(...).toISOString()`, which is what shifts a planned
 * publishing date to the previous or next calendar day across timezones.
 */
const asYmd = (v: unknown): string | null => (typeof v === 'string' && YMD.test(v.trim()) ? v.trim() : null);
const asHhmm = (v: unknown): string | null => (typeof v === 'string' && HHMM.test(v.trim()) ? v.trim() : null);

export interface ScheduleData {
  /** Multi-select. The legacy single `platform` key is preserved alongside it. */
  platforms?: string[];
  platform?: string | null;
  date?: string | null;         // YYYY-MM-DD — planned publishing date
  time?: string | null;         // HH:MM — optional
  caption?: string | null;
  hashtags?: string[];
  scheduled?: boolean;
  scheduledAt?: string | null;  // when Mark as Scheduled ran (server clock)
  scheduledBy?: number | null;
  captionReady?: boolean;       // pre-M08 field, kept so no existing value is lost
}

export interface FieldError { field: string; message: string }

/**
 * Normalise a hashtag list. Accepts either a real array or free text (comma,
 * whitespace or newline separated) so both input styles round-trip into one
 * stored shape. Values are de-duplicated case-insensitively but the user's
 * original casing is preserved.
 */
export function normaliseHashtags(v: unknown): string[] {
  const raw: string[] = Array.isArray(v)
    ? v.map((x) => String(x ?? ''))
    : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = item.trim().replace(/^#+/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;   // no accidental duplicates
    seen.add(key);
    out.push(`#${tag.slice(0, 100)}`);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * Merge a scheduling patch over what is stored. Absent keys are left untouched,
 * so saving the schedule can never blank a sibling field — and the publishing
 * record, which lives beside it, is not part of this object at all.
 */
export function mergeScheduleData(
  existing: unknown,
  patch: unknown,
  allowedPlatforms: readonly string[],
): { data: ScheduleData; errors: FieldError[] } {
  const base = (existing && typeof existing === 'object' ? existing : {}) as ScheduleData;
  const errors: FieldError[] = [];
  if (!patch || typeof patch !== 'object') return { data: base, errors };
  const p = patch as ScheduleData;
  const out: ScheduleData = { ...base };

  if (p.platforms !== undefined) {
    const list = Array.isArray(p.platforms) ? p.platforms : [];
    const valid: string[] = [];
    for (const item of list) {
      const v = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (!v) continue;
      if (!allowedPlatforms.includes(v)) { errors.push({ field: 'platforms', message: `Unknown platform: ${item}` }); continue; }
      if (!valid.includes(v)) valid.push(v);
    }
    out.platforms = valid;
    // Keep the legacy single column-style key in step so pre-M08 readers of
    // stage_data.schedule.platform keep working.
    out.platform = valid[0] ?? null;
  } else if (p.platform !== undefined) {
    const v = typeof p.platform === 'string' ? p.platform.trim().toLowerCase() : '';
    out.platform = v && allowedPlatforms.includes(v) ? v : null;
    out.platforms = out.platform ? [out.platform] : [];
  }

  if (p.date !== undefined) {
    const d = asYmd(p.date);
    if (p.date !== null && p.date !== '' && !d) errors.push({ field: 'date', message: 'Publishing Date must be a valid date' });
    out.date = d;
  }
  if (p.time !== undefined) {
    const t = asHhmm(p.time);
    // Time is OPTIONAL: clearing it is fine, but a malformed value is reported
    // rather than silently dropped, and nothing is invented when it is absent.
    if (p.time !== null && p.time !== '' && !t) errors.push({ field: 'time', message: 'Publishing Time must be a valid time (HH:MM)' });
    out.time = t;
  }
  if (p.caption !== undefined) {
    // Stored verbatim apart from outer whitespace — line breaks and spacing
    // inside the caption are part of the copy.
    out.caption = typeof p.caption === 'string' ? (p.caption.trim() || null) : null;
  }
  if (p.hashtags !== undefined) out.hashtags = normaliseHashtags(p.hashtags);
  if (p.captionReady !== undefined) out.captionReady = p.captionReady === true;

  return { data: out, errors };
}

/** May this actor edit / submit the schedule? */
export const canSchedule = (ctx: SalesAuthContext): boolean =>
  can(ctx, 'marketing.content.schedule') || can(ctx, 'marketing.content.edit');

/** May this actor record the publication? Content Strategist / Admin in practice. */
export const canPublish = (ctx: SalesAuthContext): boolean =>
  can(ctx, 'marketing.content.publish') || can(ctx, 'marketing.content.edit');

/**
 * Mark as Scheduled. A Publishing Date is the ONE hard requirement; platforms,
 * time, caption and hashtags are all optional. Checked against the MERGED
 * schedule, so a request that supplies the date in the same call is accepted
 * while one that leaves it unset anywhere is refused.
 */
export function checkScheduleReady(ctx: SalesAuthContext, schedule: ScheduleData): Denial | null {
  if (!canSchedule(ctx)) {
    return { status: 403, message: 'You do not have permission to schedule content.' };
  }
  if (!asYmd(schedule.date)) {
    return { status: 400, message: 'Publishing Date is required before marking the card as Scheduled.' };
  }
  return null;
}

/* ── #39 publishing record ─────────────────────────────────────────────────── */

export interface PublishedLink { done?: boolean; url?: string | null }
export type PublishedLinks = Record<string, PublishedLink>;

export interface PublishRecord {
  /** Server clock at the moment of publication. Written once, never rewritten. */
  publishedAt?: string | null;
  publishedBy?: number | null;
}

/**
 * Validate and merge the per-platform published links. One entry per platform:
 * the store is keyed BY platform, so a duplicate platform is impossible by
 * construction. A link is optional; an invalid one is reported, never dropped
 * silently and never invented.
 */
export function mergePublishedLinks(
  existing: unknown,
  patch: unknown,
  allowedPlatforms: readonly string[],
): { data: PublishedLinks; errors: FieldError[] } {
  const base = (existing && typeof existing === 'object' ? { ...(existing as PublishedLinks) } : {}) as PublishedLinks;
  const errors: FieldError[] = [];
  if (!patch || typeof patch !== 'object') return { data: base, errors };

  for (const [rawKey, rawVal] of Object.entries(patch as PublishedLinks)) {
    const platform = String(rawKey).trim().toLowerCase();
    if (!allowedPlatforms.includes(platform)) {
      errors.push({ field: 'publishedLinks', message: `Unknown platform: ${rawKey}` });
      continue;
    }
    const v = (rawVal ?? {}) as PublishedLink;
    const url = typeof v.url === 'string' ? v.url.trim() : '';
    if (url && !isValidUrl(url)) {
      errors.push({ field: `publishedLinks.${platform}`, message: `Invalid URL: ${url}` });
      continue;
    }
    base[platform] = {
      ...(base[platform] ?? {}),
      ...(v.done !== undefined ? { done: v.done === true } : {}),
      ...(v.url !== undefined ? { url: url || null } : {}),
    };
  }
  return { data: base, errors };
}

export interface PublishCard {
  id: number;
  title: string;
  stage: string;
  stage_data?: unknown;
}

export const readPublishRecord = (stageData: unknown): PublishRecord => {
  const sd = (stageData && typeof stageData === 'object' ? stageData : {}) as Record<string, unknown>;
  const r = (sd.publishRecord && typeof sd.publishRecord === 'object' ? sd.publishRecord : {}) as PublishRecord;
  return { publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null, publishedBy: typeof r.publishedBy === 'number' ? r.publishedBy : null };
};

/**
 * Mark as Published. Verifies authorization, that the card is genuinely in
 * Scheduled RIGHT NOW (which is what stops a stale tab from publishing a card
 * that already moved), and that it has not already been published.
 */
export function checkPublishReady(ctx: SalesAuthContext, card: PublishCard): Denial | null {
  if (!canPublish(ctx)) {
    return { status: 403, message: 'You do not have permission to mark content as published.' };
  }
  if (card.stage === PUBLISHED_STAGE || readPublishRecord(card.stage_data).publishedAt) {
    // Idempotent refusal: a second click cannot create a second publication
    // event or overwrite the original timestamp.
    return { status: 409, message: 'This card has already been published.' };
  }
  if (card.stage !== SCHEDULED_STAGE) {
    return { status: 409, message: 'This card is no longer in Scheduled.' };
  }
  return null;
}

/**
 * Build the publish event. The timestamp comes from the SERVER clock and the
 * actor from the authenticated session; a client-supplied `publishedAt` is
 * never honoured. An existing record is returned untouched, so the historical
 * publication time can never be silently rewritten.
 */
export function buildPublishRecord(existing: unknown, actorId: number, nowIso: string): PublishRecord {
  const current = readPublishRecord(existing);
  if (current.publishedAt) return current;
  return { publishedAt: nowIso, publishedBy: actorId };
}
