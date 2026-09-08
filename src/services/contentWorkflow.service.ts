import type { SalesAuthContext } from '../utils/salesAuth.js';
import { can } from '../utils/salesAuth.js';

/**
 * M03 — Content Strategy & Copy workflow rules.
 *
 * The single authoritative implementation of who may edit Strategy/Copy, when
 * Copy unlocks, who may flip the readiness gates, and when a card may enter
 * Stage 4 (Creative / Design). The controller calls these; the frontend mirrors
 * the same helpers for affordances only — the server is the enforcement point.
 */

/** Stage 4 of the linear workflow. */
export const DESIGN_STAGE = 'design';

/* ── Roles → capabilities ──────────────────────────────────────────────────
 * Expressed through the EXISTING permission system, never role-name checks
 * scattered in components:
 *   • edit Strategy / Copy  → marketing.content.edit  (Content Strategist,
 *     assigned Writer and Admin are the roles an admin grants this to)
 *   • flip a readiness gate → marketing.content.approve, the workflow-authority
 *     key. Deliberately NOT implied by edit, so a Writer who can author copy
 *     still cannot declare it Ready.
 * Admin/SuperAdmin bypass everything via the existing isGlobalAdmin path inside
 * `can()`, so no Admin special-case exists here.
 */
export const canEditStrategy = (ctx: SalesAuthContext): boolean => can(ctx, 'marketing.content.edit');
export const canEditCopyFields = (ctx: SalesAuthContext): boolean => can(ctx, 'marketing.content.edit');
export const canToggleReady = (ctx: SalesAuthContext): boolean => can(ctx, 'marketing.content.approve');

export interface WorkflowCard {
  id: number;
  title: string;
  stage: string;
  strategy_ready: boolean;
  copy_ready: boolean;
  copy_data: unknown;
}

/** Does this card already contain authored Copy? Used to protect real work. */
export function hasCopyContent(card: { copy_data?: unknown }): boolean {
  const c = (card.copy_data ?? {}) as Record<string, unknown>;
  const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return (
    filled(c.mainCopy) || filled(c.supportingInfo) || filled(c.requiredText) ||
    (Array.isArray(c.referenceLinks) && c.referenceLinks.length > 0) ||
    // legacy fields from the pre-M03 Script/Copy section still count as work
    filled(c.script) || filled(c.caption) || filled(c.hook) || filled(c.voiceover)
  );
}

export interface Denial { status: number; message: string }

/**
 * May this actor write Copy fields right now?
 * Copy is locked until Strategy is Ready — a WORKFLOW gate, not a permission
 * one, so it applies to Admin too (the spec's stated workflow is preserved
 * rather than bypassed for privilege).
 */
export function checkCopyEditable(ctx: SalesAuthContext, card: WorkflowCard): Denial | null {
  if (!canEditCopyFields(ctx)) {
    return { status: 403, message: 'You do not have permission to edit Copy' };
  }
  if (!card.strategy_ready) {
    return { status: 409, message: 'Copy is locked until Strategy is marked Ready.' };
  }
  return null;
}

/** May this actor flip Strategy Ready, and is the requested transition legal? */
export function checkStrategyReady(ctx: SalesAuthContext, card: WorkflowCard, next: boolean): Denial | null {
  if (!canToggleReady(ctx)) {
    return { status: 403, message: 'Only a Content Strategist or Admin can change Strategy readiness' };
  }
  if (!next) {
    // Un-marking is allowed only while Copy has not started. Copy content is
    // NEVER deleted to make this possible — the action is refused instead.
    if (card.copy_ready) {
      return { status: 409, message: 'Unmark Copy Ready before unmarking Strategy Ready.' };
    }
    if (hasCopyContent(card)) {
      return { status: 409, message: 'Strategy cannot be unmarked once Copy has been started. Existing Copy is preserved.' };
    }
  }
  return null;
}

/** May this actor flip Copy Ready, and is the requested transition legal? */
export function checkCopyReady(ctx: SalesAuthContext, card: WorkflowCard, next: boolean): Denial | null {
  if (!canToggleReady(ctx)) {
    return { status: 403, message: 'Only a Content Strategist or Admin can change Copy readiness' };
  }
  if (next && !card.strategy_ready) {
    // Prevents the invalid combination strategyReady=false + copyReady=true.
    return { status: 409, message: 'Strategy must be marked Ready before Copy can be marked Ready.' };
  }
  if (!next && card.stage === DESIGN_STAGE) {
    return { status: 409, message: 'Move the card out of Creative / Design before unmarking Copy Ready.' };
  }
  return null;
}

/**
 * Stage guard — a card may only ENTER Stage 4 (Creative / Design) once Copy is
 * Ready. Called from the one stage-transition path, so Kanban drag/drop, the
 * detail page selector and a direct API call are all covered identically.
 */
export const REVIEW_STAGE_KEY = 'review';

export interface StageMoveOptions {
  /** Acting user id — Stage 7 forward moves are restricted to the assigned Approver. */
  actorId?: number;
  /** Mandatory free-text reason for a BACKWARD move. */
  reason?: string;
  /** Admin/SuperAdmin bypass the Approver restriction, matching every other gate. */
  isAdmin?: boolean;
}

export function checkStageTransition(
  card: WorkflowCard & { owner_id?: number | null; approver_id?: number | null },
  target: string,
  /** The CANONICAL pipeline order, passed in by the caller so this module never
   *  keeps a second copy of the stage list that could drift. */
  stageOrder: readonly string[] = [],
  opts: StageMoveOptions = {},
): Denial | null {
  const fromIdx = stageOrder.indexOf(card.stage);
  const toIdx = stageOrder.indexOf(target);
  const isBackward = fromIdx > -1 && toIdx > -1 && toIdx < fromIdx;
  const isForward = fromIdx > -1 && toIdx > -1 && toIdx > fromIdx;

  // M06 — BACKWARD moves are always permitted but require a meaningful reason.
  // Whitespace-only is rejected; the reason is persisted by the caller through
  // the existing activity-log audit.
  if (isBackward && !String(opts.reason ?? '').trim()) {
    return { status: 400, message: 'A reason is required when moving a card backward.' };
  }

  // M06 — Stage 7 (Review / Approval) may only be advanced FORWARD by the card's
  // assigned Approver (resolved by stable user id from Team Assignment, never a
  // name/email comparison). Backward moves are unaffected — they only need the
  // reason above. Admin retains the standard bypass.
  if (card.stage === REVIEW_STAGE_KEY && isForward && !opts.isAdmin) {
    if (!card.approver_id || card.approver_id !== opts.actorId) {
      return { status: 403, message: 'Only the assigned Approver can move this card forward from Review / Approval.' };
    }
  }

  // M05 #19 — a card cannot move PAST Stage 1 (Backlog) without a Content Owner.
  // Expressed against the real stage ORDER, not a hardcoded "stage 2" check, so
  // Backlog → Script / Design / anything downstream is blocked too. Evaluated on
  // the freshly-read row, so it reflects the CURRENT persisted owner.
  const backlog = stageOrder[0];
  if (backlog && card.stage === backlog && !card.owner_id) {
    const targetIdx = stageOrder.indexOf(target);
    if (targetIdx > 0) {
      return { status: 409, message: 'A Content Owner must be assigned before moving past Backlog.' };
    }
  }
  if (target === DESIGN_STAGE && card.stage !== DESIGN_STAGE && !card.copy_ready) {
    return { status: 409, message: 'Copy must be marked Ready before moving to Creative / Design.' };
  }
  return null;
}

/* ── Field sanitisation ────────────────────────────────────────────────────── */
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

export interface StrategyData { coreMessage?: string | null; hook?: string | null; notes?: string | null }

/**
 * Merge a Strategy patch. Only the three narrative fields live here; CTA and
 * Content Pillar are handled by the caller against their existing columns.
 * Absent keys are left untouched, so a partial save never blanks a sibling.
 */
export function mergeStrategyData(existing: unknown, patch: unknown): StrategyData {
  const base = (existing && typeof existing === 'object' ? existing : {}) as StrategyData;
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as StrategyData;
  return {
    ...base,
    ...(p.coreMessage !== undefined ? { coreMessage: text(p.coreMessage, 5000) } : {}),
    ...(p.hook !== undefined ? { hook: text(p.hook, 5000) } : {}),
    ...(p.notes !== undefined ? { notes: text(p.notes, 20000) } : {}),
  };
}

/** http(s) URL check for reference links. */
export function isValidUrl(v: unknown): boolean {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CopyData {
  mainCopy?: string | null;
  supportingInfo?: string | null;
  requiredText?: string | null;
  referenceLinks?: string[];
  [legacy: string]: unknown;
}

/**
 * Merge a Copy patch over what is stored. Long multi-line text is preserved
 * verbatim (no line-break normalisation, generous limits). Reference links are
 * stored as a real list, de-duplicated, and every entry is validated — an
 * invalid URL is reported rather than silently dropped.
 */
export function mergeCopyData(existing: unknown, patch: unknown): { data: CopyData; invalidUrls: string[] } {
  const base = (existing && typeof existing === 'object' ? existing : {}) as CopyData;
  if (!patch || typeof patch !== 'object') return { data: base, invalidUrls: [] };
  const p = patch as CopyData;
  const out: CopyData = { ...base };
  const invalidUrls: string[] = [];

  // Trim only the outer whitespace: internal newlines/paragraphs are untouched.
  if (p.mainCopy !== undefined) out.mainCopy = typeof p.mainCopy === 'string' ? (p.mainCopy.trim() || null) : null;
  if (p.supportingInfo !== undefined) out.supportingInfo = typeof p.supportingInfo === 'string' ? (p.supportingInfo.trim() || null) : null;
  if (p.requiredText !== undefined) out.requiredText = typeof p.requiredText === 'string' ? (p.requiredText.trim() || null) : null;

  if (p.referenceLinks !== undefined) {
    const raw = Array.isArray(p.referenceLinks) ? p.referenceLinks : [];
    const valid: string[] = [];
    for (const item of raw) {
      const url = typeof item === 'string' ? item.trim() : '';
      if (!url) continue;                 // blank rows are ignored, not errors
      if (!isValidUrl(url)) { invalidUrls.push(url); continue; }
      if (!valid.includes(url)) valid.push(url);
    }
    out.referenceLinks = valid;
  }
  return { data: out, invalidUrls };
}
