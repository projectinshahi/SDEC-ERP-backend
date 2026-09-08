import type { SalesAuthContext } from '../utils/salesAuth.js';
import { can } from '../utils/salesAuth.js';
import type { Denial } from './contentWorkflow.service.js';
import {
  REVIEW_STAGE, APPROVED_STAGE, CHANGES_REQUESTED_STAGE, REJECTED_STAGE,
} from './contentStage.service.js';

/**
 * M07 — Review & Approval business rules.
 *
 * THE single authority for: the six internal-review checklist items, who may
 * decide, what a decision requires, and which stage each outcome routes to.
 * The controller calls these; the frontend mirrors them for affordances only.
 *
 * Deliberate separation of three distinct concepts, none of which is merged:
 *   • CURRENT checklist state  → stage_data.review.checklist (resettable)
 *   • checklist AUDIT history  → activity_logs (append-only, never reset)
 *   • approval REVISION history → activity_logs (append-only, never reset)
 */

/* ── #34: the six checklist items ──────────────────────────────────────────── */

export const REVIEW_CHECKLIST_ITEMS = [
  { key: 'contentChecked', label: 'Content Checked' },
  { key: 'designChecked', label: 'Design Checked' },
  { key: 'brandChecked', label: 'Brand Checked' },
  { key: 'ctaChecked', label: 'CTA Checked' },
  { key: 'grammarChecked', label: 'Grammar Checked' },
  { key: 'infoVerified', label: 'Info Verified' },
] as const;

export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_ITEMS)[number]['key'];

export const isReviewChecklistKey = (v: unknown): v is ReviewChecklistKey =>
  typeof v === 'string' && REVIEW_CHECKLIST_ITEMS.some((i) => i.key === v);

export const reviewItemLabel = (key: string): string =>
  REVIEW_CHECKLIST_ITEMS.find((i) => i.key === key)?.label ?? key;

/** One checked item's CURRENT state. `by`/`at` are always server-derived. */
export interface ReviewCheckState {
  checked: boolean;
  by?: number | null;
  at?: string | null;
}
export type ReviewChecklist = Partial<Record<ReviewChecklistKey, ReviewCheckState>>;

/** Read the current checklist out of a card's stage_data, defensively. */
export function readChecklist(stageData: unknown): ReviewChecklist {
  const sd = (stageData && typeof stageData === 'object' ? stageData : {}) as Record<string, unknown>;
  const review = (sd.review && typeof sd.review === 'object' ? sd.review : {}) as Record<string, unknown>;
  const raw = (review.checklist && typeof review.checklist === 'object' ? review.checklist : {}) as Record<string, unknown>;
  const out: ReviewChecklist = {};
  for (const item of REVIEW_CHECKLIST_ITEMS) {
    const v = raw[item.key];
    if (v && typeof v === 'object') {
      const s = v as ReviewCheckState;
      out[item.key] = {
        checked: s.checked === true,
        by: typeof s.by === 'number' ? s.by : null,
        at: typeof s.at === 'string' ? s.at : null,
      };
    }
  }
  return out;
}

/** Are ALL six items currently checked? The gate for approval. */
export const isChecklistComplete = (checklist: ReviewChecklist): boolean =>
  REVIEW_CHECKLIST_ITEMS.every((i) => checklist[i.key]?.checked === true);

export const missingChecklistItems = (checklist: ReviewChecklist): string[] =>
  REVIEW_CHECKLIST_ITEMS.filter((i) => checklist[i.key]?.checked !== true).map((i) => i.label);

/**
 * Merge one item's new state into the stored stage_data, preserving every other
 * stage section AND the review section's own sibling keys (the decision, its
 * notes). `by`/`at` are stamped from the authenticated actor and the server
 * clock — a client-supplied user or timestamp is never honoured.
 */
export function writeChecklistItem(
  stageData: unknown,
  key: ReviewChecklistKey,
  checked: boolean,
  actorId: number,
  nowIso: string,
): Record<string, unknown> {
  const sd = (stageData && typeof stageData === 'object' ? { ...(stageData as Record<string, unknown>) } : {});
  const review = { ...((sd.review && typeof sd.review === 'object' ? sd.review : {}) as Record<string, unknown>) };
  const checklist = { ...((review.checklist && typeof review.checklist === 'object' ? review.checklist : {}) as Record<string, unknown>) };
  // Unchecking clears the CURRENT attribution only; the activity_logs entry that
  // recorded the original check is never touched.
  checklist[key] = checked ? { checked: true, by: actorId, at: nowIso } : { checked: false, by: null, at: null };
  review.checklist = checklist;
  sd.review = review;
  return sd;
}

/**
 * Reset the CURRENT checklist for a fresh review cycle (used by Changes
 * Requested / Rejected). Only `stage_data.review.checklist` is emptied: the
 * decision keys beside it and every historical activity_logs row survive.
 */
export function resetChecklist(stageData: unknown): Record<string, unknown> {
  const sd = (stageData && typeof stageData === 'object' ? { ...(stageData as Record<string, unknown>) } : {});
  const review = { ...((sd.review && typeof sd.review === 'object' ? sd.review : {}) as Record<string, unknown>) };
  review.checklist = {};
  sd.review = review;
  return sd;
}

/* ── #35/#36: decisions ────────────────────────────────────────────────────── */

export const APPROVAL_STATUSES = ['pending', 'approved', 'changes_requested', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const isApprovalStatus = (v: unknown): v is ApprovalStatus =>
  typeof v === 'string' && (APPROVAL_STATUSES as readonly string[]).includes(v);

/** Decisions that must carry Revision Notes. */
export const NOTES_REQUIRED: readonly ApprovalStatus[] = ['changes_requested', 'rejected'];

/** Decisions that reset the current checklist for the next cycle. */
export const RESETS_CHECKLIST: readonly ApprovalStatus[] = ['changes_requested', 'rejected'];

/**
 * Outcome → destination stage. 'pending' is not a decision and moves nothing.
 * Named constants only — no stage string is hardcoded at a call site.
 */
export const OUTCOME_STAGE: Record<ApprovalStatus, string | null> = {
  pending: null,
  approved: APPROVED_STAGE,             // Stage 8 — Scheduled
  changes_requested: CHANGES_REQUESTED_STAGE, // Stage 6 — Editing
  rejected: REJECTED_STAGE,             // Stage 2 — Strategy & Planning
};

export const DECISION_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  rejected: 'Rejected',
};

export interface ReviewCard {
  id: number;
  title: string;
  stage: string;
  approver_id?: number | null;
  owner_id?: number | null;
  stage_data?: unknown;
}

/**
 * May this actor act as the Approver on THIS card?
 *
 * The `marketing.content.approve` permission alone is NOT enough: it says the
 * user may approve *something*, while the card's `approver_id` says who may
 * approve *this*. Requiring both closes the gap where any permission holder
 * could decide on a card they were never assigned. Admin keeps the standard
 * bypass via the existing isAdmin path.
 */
export function canDecide(ctx: SalesAuthContext, card: ReviewCard): boolean {
  if (ctx.isAdmin) return true;
  if (!can(ctx, 'marketing.content.approve')) return false;
  return card.approver_id != null && card.approver_id === ctx.userId;
}

/**
 * May this actor tick review checklist items?
 *
 * The checklist is the INTERNAL review, performed by the team before the
 * Approver decides — so anyone who can edit the card, plus the assigned
 * Approver, plus Admin. It is not the approval authority itself.
 */
export function canCheckReviewItem(ctx: SalesAuthContext, card: ReviewCard): boolean {
  if (ctx.isAdmin) return true;
  if (can(ctx, 'marketing.content.edit')) return true;
  return can(ctx, 'marketing.content.approve') && card.approver_id === ctx.userId;
}

/** The checklist only exists while the card is under review. */
export function checkChecklistEditable(ctx: SalesAuthContext, card: ReviewCard): Denial | null {
  if (card.stage !== REVIEW_STAGE) {
    return { status: 409, message: 'The review checklist applies only while the card is in Review / Approval.' };
  }
  if (!canCheckReviewItem(ctx, card)) {
    return { status: 403, message: 'You are not authorized to complete the review checklist for this card.' };
  }
  return null;
}

export interface DecisionInput {
  status: ApprovalStatus;
  /** Raw notes as supplied; trimmed and validated here. */
  notes?: unknown;
}

export interface ValidatedDecision {
  status: ApprovalStatus;
  notes: string;
  targetStage: string | null;
  resetsChecklist: boolean;
}

/**
 * THE approval validation. Every rule the spec defines is checked here against
 * the freshly-read card, in the order that produces the most useful message.
 */
export function validateDecision(
  ctx: SalesAuthContext,
  card: ReviewCard,
  input: DecisionInput,
): Denial | ValidatedDecision {
  if (!isApprovalStatus(input.status)) {
    return { status: 400, message: `Decision must be one of: ${APPROVAL_STATUSES.join(', ')}` };
  }
  // Authorization before anything else, so an unauthorized caller learns
  // nothing about the card's checklist state.
  if (!canDecide(ctx, card)) {
    return { status: 403, message: 'You are not authorized to perform this approval action.' };
  }
  // Stale-page protection: the decision is only meaningful while the card is
  // actually under review, and the stage is read from the database.
  if (card.stage !== REVIEW_STAGE) {
    return { status: 409, message: 'This card is no longer in Review & Approval.' };
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (NOTES_REQUIRED.includes(input.status) && !notes) {
    return { status: 400, message: `Revision notes are required for ${DECISION_LABELS[input.status]}.` };
  }

  if (input.status === 'approved') {
    // Checklist completeness is read from the PERSISTED card, never from a
    // client-sent flag.
    const missing = missingChecklistItems(readChecklist(card.stage_data));
    if (missing.length) {
      return {
        status: 409,
        message: `All review checklist items must be completed before approval. Outstanding: ${missing.join(', ')}.`,
      };
    }
  }

  return {
    status: input.status,
    notes: notes.slice(0, 2000),
    targetStage: OUTCOME_STAGE[input.status],
    resetsChecklist: RESETS_CHECKLIST.includes(input.status),
  };
}

export const isDenial = (v: Denial | ValidatedDecision): v is Denial =>
  typeof (v as Denial).status === 'number' && typeof (v as Denial).message === 'string';

/* ── M09 #40: resubmission after Changes Requested ─────────────────────────── */

/** Stage 6. Where a card sits after a Changes Requested decision. */
export const EDITING_STAGE = CHANGES_REQUESTED_STAGE;

/**
 * Who may resubmit a card for review and attach the optional response note?
 * The card's OWNER — plus Admin. The note explains what the owner changed, so
 * it is theirs to write; being able to see the card is not enough.
 */
export function canResubmit(ctx: SalesAuthContext, card: ReviewCard): boolean {
  if (ctx.isAdmin) return true;
  return card.owner_id != null && card.owner_id === ctx.userId;
}

/**
 * Resubmission is only meaningful for a card sitting in Editing because an
 * Approver asked for changes. Both facts are read from the persisted row, so a
 * stale page cannot resubmit a card that already moved on.
 */
export function checkResubmit(
  ctx: SalesAuthContext,
  card: ReviewCard & { approval_status?: string | null },
): Denial | null {
  if (!canResubmit(ctx, card)) {
    return { status: 403, message: 'Only the Content Owner can resubmit this card for review.' };
  }
  if (card.stage !== EDITING_STAGE) {
    return { status: 409, message: 'Only a card in Editing can be resubmitted for review.' };
  }
  if (card.approval_status !== 'changes_requested') {
    return { status: 409, message: 'This card was not sent back for changes, so there is nothing to resubmit.' };
  }
  return null;
}
