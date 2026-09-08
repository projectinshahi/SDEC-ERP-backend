import prisma from '../config/db.js';
import type { SalesAuthContext } from '../utils/salesAuth.js';
import {
  canEditStrategy, canToggleReady, checkStageTransition, isValidUrl, REVIEW_STAGE_KEY,
  type Denial, type StageMoveOptions, type WorkflowCard,
} from './contentWorkflow.service.js';

/**
 * M04 — Creative Direction & Production Briefing rules.
 *
 * Extends the M03 workflow service rather than duplicating it: permission
 * helpers (`canToggleReady`) and URL validation (`isValidUrl`) are imported, so
 * there is still one implementation of each.
 *
 * Creative Direction and Production Briefing are deliberately SEPARATE concepts
 * and separate stores — Creative Direction lives in `creative_direction`,
 * production details in the existing `production_data`.
 */

/** Creative Style / Tone presets. Free text is also allowed alongside a preset. */
export const STYLE_TONE_PRESETS = ['minimal', 'corporate', 'cinematic', 'funny', 'premium'] as const;

export interface CreativeDirection {
  styleTone?: string | null;
  styleToneCustom?: string | null;
  visualReferences?: string[];
  brandRequirements?: string | null;
  specialInstructions?: string | null;
}

/**
 * Merge a Creative Direction patch. Absent keys are untouched, so saving here
 * can never disturb Production, Strategy or Copy. Long free text keeps its line
 * breaks verbatim — only the outer whitespace is trimmed.
 */
export function mergeCreativeDirection(
  existing: unknown,
  patch: unknown,
): { data: CreativeDirection; invalidUrls: string[] } {
  const base = (existing && typeof existing === 'object' ? existing : {}) as CreativeDirection;
  if (!patch || typeof patch !== 'object') return { data: base, invalidUrls: [] };
  const p = patch as CreativeDirection;
  const out: CreativeDirection = { ...base };
  const invalidUrls: string[] = [];

  if (p.styleTone !== undefined) {
    const v = typeof p.styleTone === 'string' ? p.styleTone.trim().toLowerCase() : '';
    out.styleTone = (STYLE_TONE_PRESETS as readonly string[]).includes(v) ? v : null;
  }
  if (p.styleToneCustom !== undefined) {
    out.styleToneCustom = typeof p.styleToneCustom === 'string' ? (p.styleToneCustom.trim() || null) : null;
  }
  if (p.brandRequirements !== undefined) {
    out.brandRequirements = typeof p.brandRequirements === 'string' ? (p.brandRequirements.trim() || null) : null;
  }
  if (p.specialInstructions !== undefined) {
    out.specialInstructions = typeof p.specialInstructions === 'string' ? (p.specialInstructions.trim() || null) : null;
  }
  if (p.visualReferences !== undefined) {
    const raw = Array.isArray(p.visualReferences) ? p.visualReferences : [];
    const valid: string[] = [];
    for (const item of raw) {
      const url = typeof item === 'string' ? item.trim() : '';
      if (!url) continue;                        // blank rows ignored, not errors
      if (!isValidUrl(url)) { invalidUrls.push(url); continue; }
      if (!valid.includes(url)) valid.push(url);  // separate entries, de-duplicated
    }
    out.visualReferences = valid;
  }
  return { data: out, invalidUrls };
}

/* ── Production briefing ───────────────────────────────────────────────────── */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Date-only fields stay 'YYYY-MM-DD' STRINGS end to end. They are never passed
 * through `new Date(...).toISOString()`, which is exactly what shifts a
 * date-only value to the previous/next calendar day across timezones.
 */
const dateOrNull = (v: unknown): string | null => (typeof v === 'string' && YMD.test(v) ? v : null);

export const isShootFormat = (t?: string | null): boolean => t === 'reel' || t === 'video';
export const isDesignFormat = (t?: string | null): boolean => t === 'poster' || t === 'carousel';

export interface ProductionPatchResult {
  fields: Record<string, unknown>;
  errors: { field: string; message: string }[];
}

/**
 * Validate + normalise a production patch for ONE content-type family. The
 * caller writes only this family, so saving Poster details can never touch the
 * stored Reel values (and vice versa) — switching Content Type changes
 * visibility only, never the data.
 */
export function buildProductionPatch(
  family: 'design' | 'shoot',
  patch: Record<string, unknown>,
): ProductionPatchResult {
  const out: ProductionPatchResult = { fields: {}, errors: [] };
  const t = (v: unknown, max: number) => (typeof v === 'string' ? (v.trim() ? v.trim().slice(0, max) : null) : null);

  if (family === 'design') {
    if (patch.dimensions !== undefined) out.fields.dimensions = t(patch.dimensions, 60);
    if (patch.slideCount !== undefined) {
      const raw = patch.slideCount;
      if (raw === null || raw === '') out.fields.slideCount = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          out.errors.push({ field: 'slideCount', message: 'Number of Slides must be a whole number of 0 or more' });
        } else out.fields.slideCount = n;
      }
    }
    if (patch.designReference !== undefined) {
      const url = typeof patch.designReference === 'string' ? patch.designReference.trim() : '';
      if (!url) out.fields.designReference = null;
      else if (!isValidUrl(url)) out.errors.push({ field: 'designReference', message: `Invalid URL: ${url}` });
      else out.fields.designReference = url;
    }
    if (patch.firstDraftDeadline !== undefined) out.fields.firstDraftDeadline = dateOrNull(patch.firstDraftDeadline);
    if (patch.finalDeadline !== undefined) out.fields.finalDeadline = dateOrNull(patch.finalDeadline);
    // Ordering is checked only when BOTH dates are present — neither is invented
    // as mandatory here.
    const fd = out.fields.firstDraftDeadline as string | null | undefined;
    const fl = out.fields.finalDeadline as string | null | undefined;
    if (fd && fl && fd > fl) {
      out.errors.push({ field: 'finalDeadline', message: 'Final Deadline cannot be earlier than the First Draft Deadline' });
    }
  } else {
    if (patch.location !== undefined) out.fields.location = t(patch.location, 500);
    if (patch.props !== undefined) out.fields.props = t(patch.props, 2000);
    if (patch.equipment !== undefined) out.fields.equipment = t(patch.equipment, 2000);
    if (patch.shootDate !== undefined) out.fields.shootDate = dateOrNull(patch.shootDate);
    if (patch.editDeadline !== undefined) out.fields.editDeadline = dateOrNull(patch.editDeadline);
    if (patch.finalDeadline !== undefined) out.fields.finalDeadline = dateOrNull(patch.finalDeadline);
    const sd = out.fields.shootDate as string | null | undefined;
    const ed = out.fields.editDeadline as string | null | undefined;
    const fl = out.fields.finalDeadline as string | null | undefined;
    if (ed && fl && ed > fl) {
      out.errors.push({ field: 'finalDeadline', message: 'Final Deadline cannot be earlier than the Edit Deadline' });
    }
    if (sd && fl && sd > fl) {
      out.errors.push({ field: 'finalDeadline', message: 'Final Deadline cannot be earlier than the Shoot Date' });
    }
  }
  return out;
}

/** The Final Deadline that applies to a card, chosen by its Content Type family. */
export function finalDeadlineFor(card: { format?: string | null; production_data?: unknown }): string | null {
  const pd = (card.production_data ?? {}) as { design?: Record<string, unknown>; shoot?: Record<string, unknown> };
  const v = isShootFormat(card.format) ? pd.shoot?.finalDeadline : pd.design?.finalDeadline;
  return typeof v === 'string' && YMD.test(v) ? v : null;
}

/**
 * Production Ready gate. For Reel/Video a Final Deadline is REQUIRED, so a
 * direct API call carrying `ready: true` without one is rejected exactly as the
 * UI would refuse it.
 */
export function checkProductionReady(
  ctx: SalesAuthContext,
  card: WorkflowCard & { format?: string | null; production_data?: unknown },
  next: boolean,
): Denial | null {
  if (!canToggleReady(ctx)) {
    return { status: 403, message: 'Only a Content Strategist or Admin can change Production readiness' };
  }
  if (next && isShootFormat(card.format) && !finalDeadlineFor(card)) {
    return { status: 409, message: 'A Final Deadline is required before Production can be marked Ready.' };
  }
  return null;
}

/**
 * TEAM assignment ids that the Production sections display READ-ONLY. Resolved
 * from the card's persisted team columns — Production never owns or edits them,
 * so Team stays the single source of truth and the two can never disagree.
 */
export const PRODUCTION_TEAM_FIELDS = [
  'designer_id', 'scriptwriter_id', 'talent_id', 'videographer_id', 'editor_id',
] as const;

/* ── M04 #27: Work Output links ────────────────────────────────────────────── */

export interface WorkOutputCard {
  id: number;
  designer_id?: number | null;
  editor_id?: number | null;
}

export interface WorkOutputRow {
  id: number;
  content_id: number;
  added_by: number | null;
}

/**
 * Who may RECORD a Work Output on this card.
 *
 * Assignment is the authority, not a global role name: the seeded Designer /
 * Editor roles hold only `marketing.content.view`, so requiring an edit key
 * would lock out exactly the two roles the rule names. A user with the global
 * production-edit key keeps access (that is how the rest of the Production
 * section already works), and Admin bypasses via the existing `can()` path.
 *
 * A Designer who is NOT assigned to THIS card gets nothing from their role
 * alone — the check is against the card's persisted assignment columns.
 */
export function canAddWorkOutput(ctx: SalesAuthContext, card: WorkOutputCard): boolean {
  if (canEditStrategy(ctx)) return true;                    // includes the Admin bypass
  return card.designer_id === ctx.userId || card.editor_id === ctx.userId;
}

/**
 * Who may EDIT or REMOVE an existing Work Output: its original author, or an
 * Admin. Deliberately NOT the global edit key — one team member must not be
 * able to rewrite another's recorded deliverable.
 */
export function canModifyWorkOutput(ctx: SalesAuthContext, row: WorkOutputRow): boolean {
  return ctx.isAdmin || (row.added_by != null && row.added_by === ctx.userId);
}

/** Validate a Work Output payload. Label and URL are both required. */
export function validateWorkOutput(
  body: { label?: unknown; url?: unknown },
): { label: string; url: string } | { errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  // The URL is never rewritten — only surrounding whitespace is removed, so a
  // rejected value is reported rather than silently "fixed".
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!label) errors.push({ field: 'label', message: 'Label is required' });
  else if (label.length > 120) errors.push({ field: 'label', message: 'Label must be under 120 characters' });
  if (!url) errors.push({ field: 'url', message: 'URL is required' });
  else if (!isValidUrl(url)) errors.push({ field: 'url', message: `Invalid URL: ${url}` });
  return errors.length ? { errors } : { label, url };
}

/* ── M04 #28: Production Ready gate for Stage 7 (Review / Approval) ────────── */

/** Stage 7 of the canonical pipeline. */
/** Stage 7 of the canonical pipeline. Re-exported from the workflow service
 *  so there is exactly ONE definition of the key in the backend. */
export const REVIEW_STAGE = REVIEW_STAGE_KEY;

/**
 * THE authoritative Production Ready rule: a card may only ENTER Review once it
 * has BOTH a Final Deadline and at least one recorded Work Output link.
 *
 * Pure and side-effect free; the caller supplies the count it read from the
 * database in the same request, so no client-sent number can influence it.
 * Every stage-transition path funnels through `checkStageTransition`, which is
 * the single caller — there is no second copy of this rule anywhere.
 */
export function checkReviewEntry(
  card: { format?: string | null; production_data?: unknown },
  workOutputCount: number,
): Denial | null {
  const needsDeadline = !finalDeadlineFor(card);
  const needsOutput = workOutputCount < 1;
  if (needsDeadline && needsOutput) {
    return {
      status: 409,
      message: 'Final Deadline must be set and at least one Work Output link must be recorded before entering Review.',
    };
  }
  if (needsDeadline) return { status: 409, message: 'Final Deadline must be set before entering Review.' };
  if (needsOutput) {
    return { status: 409, message: 'At least one Work Output link must be recorded before entering Review.' };
  }
  return null;
}

/**
 * THE single entry point for every stage change — Kanban drag/drop, the detail
 * page selector and a raw API call all go through this one function.
 *
 * It runs the existing workflow gates (backward reason, Stage 7 Approver,
 * Backlog owner, Copy Ready) and then the M04 Production Ready gate, reading
 * the Work Output count from the DATABASE inside the same request. Nothing
 * about eligibility comes from the client: not the current stage, not the
 * deadline, not the count. Because the count is read here rather than passed
 * in, a caller cannot bypass the gate by forgetting an argument.
 */
export async function checkStageEntry(
  card: WorkflowCard & { id: number; format?: string | null; production_data?: unknown; owner_id?: number | null; approver_id?: number | null },
  target: string,
  stageOrder: readonly string[],
  opts: StageMoveOptions = {},
): Promise<Denial | null> {
  const denial = checkStageTransition(card, target, stageOrder, opts);
  if (denial) return denial;
  if (target !== REVIEW_STAGE || card.stage === REVIEW_STAGE) return null;
  const workOutputCount = await prisma.marketing_content_work_outputs.count({ where: { content_id: card.id } });
  return checkReviewEntry(card, workOutputCount);
}
