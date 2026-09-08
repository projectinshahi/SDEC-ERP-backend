import prisma from '../config/db.js';
import { notificationService } from './notification.service.js';

/**
 * Marketing / Content notification DISPATCH service.
 *
 * The single authoritative place where the four Content notification events are
 * DETECTED and dispatched. Event detection ("did this actually change?") lives
 * here, separate from notification PERSISTENCE, which stays in the existing
 * `notificationService` — so there is still exactly one notification writer.
 *
 * Dispatch is server-side only: the controller performs the business action and
 * passes the before/after state, so the frontend can never create an
 * authoritative notification (which would double-fire).
 */

export type ContentNotificationEvent = 'assignment' | 'stage' | 'approver' | 'decision';

export interface NotificationSettings {
  assignment_enabled: boolean;
  stage_enabled: boolean;
  approver_enabled: boolean;
  decision_enabled: boolean;
}

const DEFAULTS: NotificationSettings = {
  assignment_enabled: true,
  stage_enabled: true,
  approver_enabled: true,
  decision_enabled: true,
};

/** Single-row settings (id=1); defaults if the row is somehow missing. */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    const r = await prisma.notification_settings.findUnique({ where: { id: 1 } });
    if (!r) return DEFAULTS;
    return {
      assignment_enabled: r.assignment_enabled,
      stage_enabled: r.stage_enabled,
      approver_enabled: r.approver_enabled,
      decision_enabled: r.decision_enabled,
    };
  } catch {
    return DEFAULTS; // a settings read must never break the card operation
  }
}

export async function updateNotificationSettings(
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const data: Partial<NotificationSettings> = {};
  for (const k of ['assignment_enabled', 'stage_enabled', 'approver_enabled', 'decision_enabled'] as const) {
    if (typeof patch[k] === 'boolean') data[k] = patch[k];
  }
  const r = await prisma.notification_settings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...DEFAULTS, ...data },
  });
  return {
    assignment_enabled: r.assignment_enabled,
    stage_enabled: r.stage_enabled,
    approver_enabled: r.approver_enabled,
    decision_enabled: r.decision_enabled,
  };
}

const enabledFor = (s: NotificationSettings, e: ContentNotificationEvent): boolean =>
  e === 'assignment' ? s.assignment_enabled
    : e === 'stage' ? s.stage_enabled
      : e === 'approver' ? s.approver_enabled
        : s.decision_enabled;

/**
 * Only ACTIVE, existing users receive notifications, so a stale or removed
 * assignee can never produce an orphaned row. Excludes the actor when asked.
 */
async function validRecipients(
  ids: (number | null | undefined)[],
  exceptUserId?: number,
): Promise<number[]> {
  const unique = [...new Set(ids.filter((i): i is number => typeof i === 'number' && i > 0))]
    .filter((i) => i !== exceptUserId);
  if (!unique.length) return [];
  const users = await prisma.users.findMany({
    where: { id: { in: unique }, status: 'active' },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Stage → responsible ROLE FIELD on the card.
 *
 * Derived from the Content Production module's own per-stage section ownership:
 * the Creative/Design section belongs to the Designer, Production to the
 * Videographer, Editing to the Editor. Stages with no dedicated role column fall
 * to the Content Owner, who owns planning, copy and scheduling.
 *
 * SPEC GAP (reported, not invented): the card has owner/designer/videographer/
 * editor columns only — there is no `writer_id`, so Script/Copy cannot target a
 * Writer and routes to the Owner. `review` is intentionally absent here: it is
 * the Approver event, resolved through RBAC below.
 */
const STAGE_ROLE_FIELD: Record<string, 'owner_id' | 'designer_id' | 'videographer_id' | 'editor_id'> = {
  idea: 'owner_id',
  strategy: 'owner_id',
  script: 'owner_id',
  design: 'designer_id',
  production: 'videographer_id',
  editing: 'editor_id',
  scheduled: 'owner_id',
  published: 'owner_id',
  analytics: 'owner_id',
};

/** "Review & Approval" — stage 7 of the linear workflow. */
export const REVIEW_STAGE = 'review';

interface CardRoles {
  id: number;
  title: string;
  owner_id: number | null;
  designer_id: number | null;
  videographer_id: number | null;
  editor_id: number | null;
}

/**
 * Approvers resolved through the EXISTING RBAC system when the card carries no
 * assigned approver_id: active users whose role set grants
 * `marketing.content.approve` — the Approver role, or any role an admin has
 * granted that key. Falls back to the card owner only when nobody holds it, so a
 * review hand-off is never silently lost.
 */
async function resolveApprovers(
  card: { id: number; title: string; owner_id: number | null },
  exceptUserId?: number,
): Promise<number[]> {
  const roles = await prisma.$queryRawUnsafe<{ name: string; permissions: unknown }[]>(
    'SELECT name, permissions FROM roles;',
  );
  const approverRoles = roles
    .filter((r) => {
      let perms: string[] = [];
      try {
        const raw = r.permissions;
        perms = Array.isArray(raw) ? (raw as string[]) : JSON.parse(String(raw ?? '[]'));
      } catch {
        perms = [];
      }
      return Array.isArray(perms) && perms.includes('marketing.content.approve');
    })
    .map((r) => String(r.name).toLowerCase());
  if (!approverRoles.length) return validRecipients([card.owner_id], exceptUserId);

  // `users.role` is a comma-separated list of role names — match ANY of them, so
  // multi-role users resolve correctly.
  const users = await prisma.users.findMany({
    where: { status: 'active' },
    select: { id: true, role: true },
  });
  const ids = users
    .filter((u) =>
      String(u.role ?? '')
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .some((r) => approverRoles.includes(r)),
    )
    .map((u) => u.id);
  const valid = await validRecipients(ids, exceptUserId);
  return valid.length ? valid : validRecipients([card.owner_id], exceptUserId);
}

/** Structured payload — navigation never depends on parsing the message text. */
function payload(type: string, title: string, message: string, cardId: number) {
  return { type, title, message, entityType: 'marketing_content', entityId: cardId };
}

/* ── EVENT 1 — a role field was assigned/changed ───────────────────────────── */
export async function dispatchAssignment(
  card: { id: number; title: string },
  newlyAssigned: number[],
  actorId?: number,
): Promise<void> {
  const s = await getNotificationSettings();
  if (!enabledFor(s, 'assignment')) return;
  const to = await validRecipients(newlyAssigned, actorId);
  if (!to.length) return;
  await notificationService.createNotifications(
    to,
    payload('assignment', 'Assigned to marketing content', `You were assigned to '${card.title}'`, card.id),
  );
}

/* ── EVENTS 2 & 3 — stage reached / entered Review & Approval ──────────────── */
export async function dispatchStageChange(
  card: CardRoles,
  fromStage: string,
  toStage: string,
  stageLabel: string,
  actorId?: number,
): Promise<void> {
  if (fromStage === toStage) return; // real transitions only — never a plain save
  const s = await getNotificationSettings();

  if (toStage === REVIEW_STAGE) {
    // EVENT 3 — entering Review & Approval targets the Approver.
    if (!enabledFor(s, 'approver')) return;
    const to = await resolveApprovers(card, actorId);
    if (!to.length) return;
    await notificationService.createNotifications(
      to,
      payload(
        'approval_request',
        'Content awaiting approval',
        `'${card.title}' entered ${stageLabel} and needs your approval`,
        card.id,
      ),
    );
    return;
  }

  // EVENT 2 — the responsible role member for the DESTINATION stage only.
  if (!enabledFor(s, 'stage')) return;
  const field = STAGE_ROLE_FIELD[toStage];
  if (!field) return; // e.g. 'blocked' has no responsible role
  const to = await validRecipients([card[field]], actorId);
  if (!to.length) return;
  await notificationService.createNotifications(
    to,
    payload('status_change', 'Content moved to your stage', `'${card.title}' moved to ${stageLabel}`, card.id),
  );
}

/** Human wording per decision, so the message never prints a raw enum. */
const DECISION_TEXT: Record<string, string> = {
  approved: 'was approved',
  rejected: 'was rejected',
  changes_requested: 'needs changes',
};

/* ── EVENT 4 — approval decision → Content Owner ───────────────────────────── */
export async function dispatchApprovalDecision(
  card: { id: number; title: string; owner_id: number | null },
  previousStatus: string | null,
  status: string,
  note: string | undefined,
  actorId?: number,
): Promise<void> {
  if (previousStatus === status) return; // no duplicate when re-saving the same decision
  // Every real OUTCOME notifies the Content Owner. 'changes_requested' used to
  // fall through this guard, so that outcome silently reached nobody.
  if (status !== 'approved' && status !== 'rejected' && status !== 'changes_requested') return;
  const s = await getNotificationSettings();
  if (!enabledFor(s, 'decision')) return;
  const to = await validRecipients([card.owner_id], actorId);
  if (!to.length) return;
  await notificationService.createNotifications(
    to,
    payload(
      status === 'approved' ? 'approval' : status === 'rejected' ? 'rejection' : 'status_change',
      status === 'changes_requested' ? 'Changes requested' : `Content ${status}`,
      `'${card.title}' - ${DECISION_TEXT[status] ?? status}${note ? ` - ${note}` : ''}`,
      card.id,
    ),
  );
}
