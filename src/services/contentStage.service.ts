import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { dispatchStageChange } from './contentNotification.service.js';
import { checkStageEntry } from './contentProduction.service.js';
import type { Denial, StageMoveOptions } from './contentWorkflow.service.js';

/**
 * THE stage-transition service.
 *
 * Previously the only stage write lived inline in the moveContentStage
 * controller, which meant any second caller (the M07 approval routing) would
 * have had to re-implement gate-check + write + audit + notify. Now every path
 * — Kanban drag/drop, the detail-page selector, a raw API call and the approval
 * outcome routing — funnels through `applyStageMove`, so the gates, the audit
 * entry and the notification can never diverge between them.
 */

/** The canonical pipeline. 'blocked' is a parking column, not part of the flow. */
export const CONTENT_STAGES = [
  'idea', 'strategy', 'script', 'design', 'production',
  'editing', 'review', 'scheduled', 'published', 'analytics',
] as const;
export const BLOCKED_STAGE = 'blocked';
export const ALL_STAGES: string[] = [...CONTENT_STAGES, BLOCKED_STAGE];

export const STAGE_LABELS: Record<string, string> = {
  idea: 'Ideas / Backlog', strategy: 'Strategy & Planning', script: 'Script / Copy',
  design: 'Creative / Design', production: 'Production', editing: 'Editing',
  review: 'Review / Approval', scheduled: 'Scheduled', published: 'Published',
  analytics: 'Performance / Analytics', blocked: 'Blocked / Waiting',
};

export const stageLabel = (key: string): string => STAGE_LABELS[key] ?? key;

/** M07 routing targets, named so no caller hardcodes a stage string.
 *  REVIEW_STAGE comes from the workflow service - one definition only. */
export { REVIEW_STAGE_KEY as REVIEW_STAGE } from './contentWorkflow.service.js';
export const APPROVED_STAGE = 'scheduled';
export const CHANGES_REQUESTED_STAGE = 'editing';
export const REJECTED_STAGE = 'strategy';

/** M08 stages. APPROVED_STAGE and SCHEDULED_STAGE are the same stage 8 — the
 *  two names describe the two flows that reach it, not two stages. */
export const SCHEDULED_STAGE = 'scheduled';
export const PUBLISHED_STAGE = 'published';

export interface StageMoveResult {
  denial?: Denial;
  card?: Record<string, unknown>;
  moved: boolean;
}

export interface ApplyStageMoveOptions extends StageMoveOptions {
  /**
   * Extra columns written in the SAME statement as the stage. Used by the
   * approval flow so the decision, the notes and the stage land atomically —
   * there is no window where the stage moved but the decision did not.
   */
  extraData?: Record<string, unknown>;
  /**
   * Suppress the stage-arrival notification. The approval flow sets this: its
   * own decision notification already reaches the Content Owner, and firing
   * both would deliver two notifications for one event.
   */
  skipStageNotification?: boolean;
  /** Audit description override (the approval flow names the decision). */
  auditDescription?: string;
  /** Extra audit metadata merged into the existing stage-change entry. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Validate and persist a stage transition.
 *
 * `existing` MUST be a freshly-read row: every gate is evaluated against the
 * persisted state, never against anything the client sent. Returns a denial
 * instead of throwing so callers can map it onto their own response shape.
 */
export async function applyStageMove(
  existing: Record<string, any>,
  target: string,
  opts: ApplyStageMoveOptions = {},
): Promise<StageMoveResult> {
  if (!ALL_STAGES.includes(target)) {
    return { moved: false, denial: { status: 400, message: 'Unknown stage' } };
  }
  const from = String(existing.stage);
  if (from === target && !opts.extraData) return { moved: false, card: existing };

  const denial = await checkStageEntry(existing as any, target, CONTENT_STAGES, opts);
  if (denial) {
    // Refusals are audited too, so a blocked attempt is visible in the history.
    await activityService.logActivity({
      actorUserId: Number(opts.actorId),
      type: 'marketing_content_stage_blocked',
      description: `Blocked move of '${existing.title}' to ${stageLabel(target)}: ${denial.message}`,
      metadata: { contentId: existing.id, from, to: target, denied: denial.message, status: denial.status },
    });
    return { moved: false, denial };
  }

  /* CONDITIONAL update: the row only moves if its stage is still what we read
   * and validated. Two concurrent requests (two Approvers deciding, two tabs
   * clicking Mark as Published) therefore cannot both win — the second matches
   * zero rows and is told the card already moved, instead of silently
   * overwriting the first transition or duplicating its event. */
  const written = await prisma.marketing_contents.updateMany({
    where: { id: existing.id, stage: from },
    data: { stage: target, ...(opts.extraData ?? {}) } as any,
  });
  if (written.count === 0) {
    const current = await prisma.marketing_contents.findUnique({ where: { id: existing.id }, select: { stage: true } });
    return {
      moved: false,
      denial: {
        status: 409,
        message: `This card has already moved to ${stageLabel(current?.stage ?? 'another stage')}. Reload and try again.`,
      },
    };
  }
  const row = await prisma.marketing_contents.findUniqueOrThrow({ where: { id: existing.id } });

  const reason = String(opts.reason ?? '').trim();
  await activityService.logActivity({
    actorUserId: Number(opts.actorId),
    type: 'marketing_content_stage_changed',
    description: opts.auditDescription
      ?? `Moved '${row.title}' from ${stageLabel(from)} to ${stageLabel(target)}`,
    metadata: {
      contentId: existing.id, from, to: target,
      ...(reason ? { reason } : {}),
      ...(opts.auditMetadata ?? {}),
    },
  });

  if (!opts.skipStageNotification) {
    await dispatchStageChange(row, from, target, stageLabel(target), opts.actorId);
  }
  return { moved: true, card: row as unknown as Record<string, unknown> };
}
