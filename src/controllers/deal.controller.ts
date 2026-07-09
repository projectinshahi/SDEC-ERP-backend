import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import {
  dealEventService,
  defaultProbabilityForStage,
  weightedRevenue,
  STAGE_PROBABILITY,
  CLOSED_DEAL_STAGES,
} from '../services/dealEvent.service.js';

/**
 * Deal & Pipeline Management controller.
 *
 * Centralises all deal-stage logic (board moves + inline edits share one stage
 * transition path), the 360° deal workspace payload, the append-only activity
 * feed, and pipeline/forecast analytics. Reuses the shared activity-log,
 * notification and deal-event services rather than duplicating them.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the deal with the relations the detail workspace + cards need. */
const dealInclude = {
  customer: true,
  owner: { select: { id: true, name: true, email: true } },
  lead: { select: { id: true, title: true } },
} as const;

const isValidDate = (d: Date) => !isNaN(d.getTime());

type StagePrep =
  | { error: string; status: number }
  | { requiresReason: 'win' | 'loss' }
  | { data: Record<string, any> };

/**
 * Validates a stage transition and returns the column patch to apply. Terminal
 * stages (Closed Won/Lost) require a reason (SE-018.1) and sync status/closedAt;
 * probability follows the stage unless the caller set one explicitly. Re-opening
 * a closed deal clears its terminal markers.
 */
async function prepareStageChange(targetStage: string, body: any): Promise<StagePrep> {
  const validStage = await prisma.dealStage.findUnique({ where: { name: targetStage } });
  if (!validStage) return { error: `Invalid stage "${targetStage}".`, status: 400 };

  const data: Record<string, any> = { stage: targetStage };
  // Reset the stalled clock + flags on every stage move (SE-021.1) — the deal
  // is, by definition, progressing again.
  data.lastStageChangeAt = new Date();
  data.stalled = false;
  data.stalledNotifiedAt = null;
  // Probability auto-follows the stage unless the request set it explicitly.
  if (body?.probability === undefined) data.probability = defaultProbabilityForStage(targetStage);

  if (targetStage === 'Closed Won') {
    const reason = typeof body?.winReason === 'string' ? body.winReason.trim() : '';
    data.status = 'won';
    data.winReason = reason || null;
    data.lossReason = null;
    data.closedAt = new Date();
  } else if (targetStage === 'Closed Lost') {
    const reason = typeof body?.lossReason === 'string' ? body.lossReason.trim() : '';
    data.status = 'lost';
    data.lossReason = reason || null;
    data.winReason = null;
    data.closedAt = new Date();
  } else {
    // Re-opening from a closed stage resets terminal markers.
    data.status = 'open';
    data.closedAt = null;
  }
  return { data };
}

/** Logs the stage move + notifies the owner, and fires the Won event once. */
async function afterStageChange(
  deal: { id: number; title: string; ownerId: number; stalled?: boolean },
  fromStage: string,
  toStage: string,
  actorId: number,
) {
  if (fromStage === toStage || !actorId) return;
  const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
  const actorName = actor?.name || 'Someone';

  await activityService.logActivity({
    actorUserId: actorId,
    dealId: deal.id,
    type: toStage === 'Closed Won' ? 'deal_won' : toStage === 'Closed Lost' ? 'deal_lost' : 'deal_stage_changed',
    description: `${actorName} moved deal "${deal.title}" from ${fromStage} to ${toStage}.`,
  });

  // SE-021 — a stalled deal that moves stage has recovered; record it.
  if (deal.stalled) {
    await activityService.logActivity({
      actorUserId: actorId,
      dealId: deal.id,
      type: 'deal_recovered',
      description: `Deal "${deal.title}" recovered — moved out of ${fromStage}.`,
    });
  }

  if (deal.ownerId && deal.ownerId !== actorId) {
    await notificationService.createNotification({
      userId: deal.ownerId,
      type: 'status_change',
      title: 'Deal stage changed',
      message: `${actorName} moved "${deal.title}" from ${fromStage} to ${toStage}.`,
      entityType: 'deal',
      entityId: deal.id,
    });
  }

  // SE-016.2 — Deal Won Event (idempotent, fires exactly once).
  if (toStage === 'Closed Won') {
    await dealEventService.emitDealWon(deal.id, actorId);
  }
}

// ── SE-014 — Deal Stages (board columns) ─────────────────────────────────────

/** GET /sales/deal-stages — ordered deal pipeline stages (board columns). */
export const getDealStages = async (_req: Request, res: Response) => {
  try {
    const stages = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(stages);
  } catch (error) {
    console.error('Error fetching deal stages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Deal pipeline COLUMN management (mirrors lead-stages: DB-driven, name-based
//    Deal.stage so renames/deletes cascade so no deal is ever stranded) ─────────

/** Strip tags + trim; reject empty / over-long stage names. */
const validateDealStageName = (raw: unknown): { name: string } | { error: string } => {
  const name = typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Stage name cannot be empty.' };
  if (name.length > 100) return { error: 'Stage name must be 100 characters or fewer.' };
  return { name };
};

/** POST /sales/deal-stages — create a custom pipeline stage (appended last). */
export const createDealStage = async (req: Request, res: Response) => {
  try {
    const v = validateDealStageName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    const dup = await prisma.dealStage.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' } },
    });
    if (dup) return res.status(409).json({ error: `A stage named "${v.name}" already exists.` });

    const max = await prisma.dealStage.aggregate({ _max: { orderIndex: true } });
    const orderIndex = (max._max.orderIndex ?? 0) + 1;

    const stage = await prisma.dealStage.create({ data: { name: v.name, orderIndex, isDefault: false } });
    res.status(201).json(stage);
  } catch (error) {
    console.error('Error creating deal stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/deal-stages/:id — rename a stage. `Deal.stage` stores the stage
 * NAME, so the rename cascades to every deal in that stage in one transaction.
 */
export const updateDealStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const v = validateDealStageName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    const existing = await prisma.dealStage.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Stage not found' });
    if (existing.name === v.name) return res.json(existing);

    const dup = await prisma.dealStage.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' }, id: { not: id } },
    });
    if (dup) return res.status(409).json({ error: `A stage named "${v.name}" already exists.` });

    const [stage] = await prisma.$transaction([
      prisma.dealStage.update({ where: { id }, data: { name: v.name } }),
      prisma.deal.updateMany({ where: { stage: existing.name }, data: { stage: v.name } }),
    ]);
    res.json(stage);
  } catch (error) {
    console.error('Error updating deal stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /sales/deal-stages/:id — remove a stage. Any deals in it are relocated
 * (to an optional `reassignTo` stage, else the first remaining stage) so the
 * pipeline never loses deals. The last remaining stage cannot be deleted.
 */
export const deleteDealStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const stages = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
    const target = stages.find((s) => s.id === id);
    if (!target) return res.status(404).json({ error: 'Stage not found' });
    if (stages.length <= 1) {
      return res.status(400).json({ error: 'At least one pipeline stage is required.' });
    }

    const remaining = stages.filter((s) => s.id !== id);
    let fallback = remaining[0];
    const requested = req.body?.reassignTo;
    if (requested) {
      const match = remaining.find((s) => s.name.toLowerCase() === String(requested).toLowerCase());
      if (match) fallback = match;
    }

    await prisma.$transaction([
      prisma.deal.updateMany({ where: { stage: target.name }, data: { stage: fallback.name } }),
      prisma.dealStage.delete({ where: { id } }),
    ]);
    res.json({ success: true, reassignedTo: fallback.name });
  } catch (error) {
    console.error('Error deleting deal stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/deal-stages/reorder — persist a new column order. The body must
 * list EVERY stage id exactly once; order_index is rewritten 1..N to match.
 */
export const reorderDealStages = async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds must be a non-empty array.' });
    }
    const ids = orderedIds.map(Number).filter((n) => !isNaN(n));
    const stages = await prisma.dealStage.findMany();

    const uniqueIds = new Set(ids);
    if (
      ids.length !== stages.length ||
      uniqueIds.size !== stages.length ||
      !stages.every((s) => uniqueIds.has(s.id))
    ) {
      return res.status(400).json({ error: 'orderedIds must include every stage exactly once.' });
    }

    await prisma.$transaction(
      ids.map((sid, index) =>
        prisma.dealStage.update({ where: { id: sid }, data: { orderIndex: index + 1 } }),
      ),
    );
    const updated = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(updated);
  } catch (error) {
    console.error('Error reordering deal stages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-014.3 — Drag-and-drop stage move ──────────────────────────────────────

/**
 * PUT /sales/deals/:id/stage — move a deal between pipeline stages. Closing a
 * deal (Closed Won/Lost) requires a reason; when absent we respond 422 so the
 * client can collect it and retry. Logs activity + notifies owner; the Won
 * event fires exactly once on Closed Won.
 */
export const moveDealStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid deal id' });

    const actorId = (req as any).userId;
    const stage = typeof req.body.stage === 'string' ? req.body.stage.trim() : '';
    if (!stage) return res.status(400).json({ error: 'A target stage is required.' });

    const existing = await prisma.deal.findUnique({
      where: { id },
      select: { id: true, title: true, stage: true, ownerId: true, stalled: true },
    });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    const prep = await prepareStageChange(stage, req.body);
    if ('error' in prep) return res.status(prep.status).json({ error: prep.error });
    if ('requiresReason' in prep) {
      return res.status(422).json({
        requiresReason: prep.requiresReason,
        error: `A ${prep.requiresReason === 'win' ? 'win' : 'loss'} reason is required to close this deal.`,
      });
    }

    const data = prep.data;
    if (req.body.orderIndex !== undefined && !isNaN(Number(req.body.orderIndex))) {
      data.orderIndex = Math.round(Number(req.body.orderIndex));
    }
    // SE-036 — remember the stage the deal was lost from (before it's overwritten).
    if (stage === 'Closed Lost' && existing.stage !== 'Closed Lost') data.lostFromStage = existing.stage;

    const deal = await prisma.deal.update({ where: { id }, data, include: dealInclude });
    await afterStageChange(existing, existing.stage, stage, actorId);

    res.json(deal);
  } catch (error) {
    console.error('Error moving deal stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-015.2 — Deal Detail (360° workspace) ──────────────────────────────────

/**
 * GET /sales/deals/:id — full deal with contact, owner, origin lead, follow-ups
 * and the append-only activity timeline. Includes the computed weighted revenue.
 */
export const getDealById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid deal id' });

    const deal = await prisma.deal.findUnique({
      where: { id },
      include: {
        ...dealInclude,
        // Detail page needs the FULL linked lead (company/contact/email/phone/
        // status) for the "Linked Lead" card — override the slim list include.
        lead: {
          select: {
            id: true, title: true, status: true, stage: true,
            customer: { select: { id: true, name: true, company: true, email: true, phone: true } },
          },
        },
        opportunity: true,
        followUps: { include: { owner: { select: { id: true, name: true } } }, orderBy: { scheduledDate: 'desc' } },
        activityLogs: {
          include: { actor: { select: { id: true, name: true } } },
          orderBy: { created_at: 'desc' },
        },
      },
    });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // SE-052.1 — linked-project status (Deal.projectId is an id-only link, no FK,
    // so look it up directly). null when the deal has no project yet.
    let linkedProject: { id: string; name: string; status: string } | null = null;
    if (deal.projectId) {
      const project = await prisma.projects.findUnique({
        where: { id: deal.projectId },
        select: { id: true, name: true, status: true },
      });
      if (project) linkedProject = project;
    }

    res.json({ ...deal, linkedProject, weightedRevenue: weightedRevenue(deal.amount, deal.probability) });
  } catch (error) {
    console.error('Error fetching deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-015.3 — Edit deal fields (inline) ─────────────────────────────────────

/**
 * PUT /sales/deals/:id — inline edit of value, probability, close date, owner,
 * notes, stage and commercial context. Validates value (≥ 0), probability
 * (0–100) and dates; logs each meaningful change and notifies the owner.
 */
export const updateDeal = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid deal id' });

    const actorId = (req as any).userId;
    const existing = await prisma.deal.findUnique({
      where: { id },
      include: { owner: { select: { id: true, name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    const body = req.body ?? {};
    const data: Record<string, any> = {};

    // ── Scalars (free text / commercial context) ──────────────────────────
    if (body.title !== undefined) {
      const t = String(body.title).replace(/\s+/g, ' ').trim();
      if (!t) return res.status(400).json({ error: 'Deal Name is required.' });
      if (/^\d+$/.test(t)) return res.status(400).json({ error: 'Deal Name cannot contain only numbers.' });
      if (!/[a-zA-Z]/.test(t)) return res.status(400).json({ error: 'Deal Name must contain at least one letter.' });
      if (t.length > 200) return res.status(400).json({ error: 'Deal Name must be 200 characters or fewer.' });
      data.title = t;
    }
    if (body.notes !== undefined) {
      if (body.notes && String(body.notes).length > 5000) return res.status(400).json({ error: 'Notes must be 5000 characters or fewer.' });
      data.notes = body.notes ? String(body.notes) : null;
    }
    if (body.description !== undefined) {
      if (body.description && String(body.description).length > 10000) return res.status(400).json({ error: 'Description must be 10000 characters or fewer.' });
      data.description = body.description ? String(body.description) : null;
    }
    if (body.products !== undefined) data.products = body.products ? String(body.products) : null;
    if (body.services !== undefined) data.services = body.services ? String(body.services) : null;
    if (body.competitors !== undefined) data.competitors = body.competitors ? String(body.competitors) : null;
    if (body.attachments !== undefined) data.attachments = body.attachments ? String(body.attachments) : null;
    if (body.currency !== undefined && String(body.currency).trim()) data.currency = String(body.currency).trim().toUpperCase();
    if (body.source !== undefined) data.source = body.source ? String(body.source).trim() : null;

    // ── Value (block negative revenue) ────────────────────────────────────
    let valueChanged = false;
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (isNaN(amount) || amount < 0) return res.status(400).json({ error: 'Deal value cannot be negative.' });
      if (amount !== existing.amount) valueChanged = true;
      data.amount = amount;
    }

    // ── Probability (0–100) ───────────────────────────────────────────────
    if (body.probability !== undefined) {
      const p = Number(body.probability);
      if (isNaN(p) || p < 0 || p > 100) return res.status(400).json({ error: 'Probability must be between 0 and 100.' });
      data.probability = Math.round(p);
    }

    // ── Expected close date (valid date or clear) ─────────────────────────
    if (body.expectedCloseDate !== undefined) {
      if (body.expectedCloseDate === null || body.expectedCloseDate === '') {
        data.expectedCloseDate = null;
      } else {
        const d = new Date(body.expectedCloseDate);
        if (!isValidDate(d)) return res.status(400).json({ error: 'Invalid expected close date.' });
        data.expectedCloseDate = d;
      }
      // A new date should be able to re-trigger the "closing soon" reminder.
      data.closeReminderNotified = false;
    }

    // ── Stage change (shared transition path) ─────────────────────────────
    let stageChanged = false;
    const targetStage = typeof body.stage === 'string' ? body.stage.trim() : '';
    if (targetStage && targetStage !== existing.stage) {
      const prep = await prepareStageChange(targetStage, body);
      if ('error' in prep) return res.status(prep.status).json({ error: prep.error });
      if ('requiresReason' in prep) {
        return res.status(422).json({
          requiresReason: prep.requiresReason,
          error: `A ${prep.requiresReason === 'win' ? 'win' : 'loss'} reason is required to close this deal.`,
        });
      }
      Object.assign(data, prep.data);
      // SE-036 — capture the stage the deal was lost from before it's overwritten.
      if (targetStage === 'Closed Lost' && existing.stage !== 'Closed Lost') data.lostFromStage = existing.stage;
      stageChanged = true;
    } else if (targetStage === existing.stage) {
      // Same stage but the user may be supplying/overwriting the close reason.
      if (typeof body.winReason === 'string' && body.winReason.trim()) data.winReason = body.winReason.trim();
      if (typeof body.lossReason === 'string' && body.lossReason.trim()) data.lossReason = body.lossReason.trim();
    }

    // ── Owner reassignment ────────────────────────────────────────────────
    let ownerChanged = false;
    let newOwnerName = '';
    if (body.ownerId !== undefined && body.ownerId !== null) {
      const newOwnerId = Number(body.ownerId);
      if (isNaN(newOwnerId)) return res.status(400).json({ error: 'Invalid owner.' });
      if (newOwnerId !== existing.ownerId) {
        const newOwner = await prisma.users.findUnique({ where: { id: newOwnerId }, select: { id: true, name: true } });
        if (!newOwner) return res.status(400).json({ error: 'Selected owner does not exist.' });
        data.ownerId = newOwnerId;
        ownerChanged = true;
        newOwnerName = newOwner.name;
      }
    }

    const deal = await prisma.deal.update({ where: { id }, data, include: dealInclude });

    // ── Activity + notifications ──────────────────────────────────────────
    if (actorId) {
      const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
      const actorName = actor?.name || 'Someone';

      if (valueChanged) {
        await activityService.logActivity({
          actorUserId: actorId, dealId: id, type: 'deal_value_changed',
          description: `${actorName} updated the value of "${deal.title}" to ${deal.currency} ${deal.amount.toLocaleString()}.`,
        });
      }
      if (stageChanged) {
        await afterStageChange(existing, existing.stage, targetStage, actorId);
      }
      if (ownerChanged) {
        await activityService.logActivity({
          actorUserId: actorId, dealId: id, type: 'deal_owner_changed',
          description: `${actorName} reassigned deal "${deal.title}" from ${existing.owner?.name || 'Unassigned'} to ${newOwnerName}.`,
        });
        if (deal.ownerId !== actorId) {
          await notificationService.createNotification({
            userId: deal.ownerId, type: 'assignment', title: 'Deal assigned to you',
            message: `${actorName} assigned the deal "${deal.title}" to you.`,
            entityType: 'deal', entityId: id,
          });
        }
      }
      // Generic edit marker (skip if the only change was a stage move already logged).
      if (!stageChanged || valueChanged || ownerChanged) {
        await activityService.logActivity({
          actorUserId: actorId, dealId: id, type: 'deal_updated',
          description: `${actorName} updated deal "${deal.title}".`,
        });
      }
    }

    res.json({ ...deal, weightedRevenue: weightedRevenue(deal.amount, deal.probability) });
  } catch (error) {
    console.error('Error updating deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-017.1 — Deal Activity Log (append-only) ───────────────────────────────

const ACTIVITY_TYPES: Record<string, string> = {
  note: 'deal_note',
  call: 'deal_call',
  meeting: 'deal_meeting',
  proposal: 'deal_proposal',
};

/**
 * POST /sales/deals/:id/activity — append a Call / Meeting / Note / Proposal
 * entry to the deal's audit trail. Append-only: entries are never edited or
 * removed. Notifies the owner when logged by someone else.
 */
export const logDealActivity = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid deal id' });

    const actorId = (req as any).userId;
    const kind = String(req.body.type || '').toLowerCase();
    const mappedType = ACTIVITY_TYPES[kind];
    if (!mappedType) return res.status(400).json({ error: 'Type must be one of: note, call, meeting, proposal.' });

    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    if (!description) return res.status(400).json({ error: 'A description is required.' });

    const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true, title: true, ownerId: true } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);

    const log = await prisma.activity_logs.create({
      data: {
        actor_user_id: actorId,
        deal_id: id,
        type: mappedType,
        description: `${actorName} logged a ${label} on "${deal.title}": ${description}`,
      },
      include: { actor: { select: { id: true, name: true } } },
    });

    if (deal.ownerId && deal.ownerId !== actorId) {
      await notificationService.createNotification({
        userId: deal.ownerId, type: 'discussion', title: `New ${label.toLowerCase()} on deal`,
        message: `${actorName} logged a ${label.toLowerCase()} on "${deal.title}".`,
        entityType: 'deal', entityId: id,
      });
    }

    res.status(201).json(log);
  } catch (error) {
    console.error('Error logging deal activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-019 / Analytics — Pipeline & Forecast ─────────────────────────────────

/**
 * GET /sales/analytics/deals — pipeline value, weighted forecast (active deals
 * only), win/loss rate, average deal value, per-stage breakdown and revenue by
 * owner. Closed Won/Lost are excluded from the active forecast (SE-019.2).
 */
export const getDealAnalytics = async (_req: Request, res: Response) => {
  try {
    const [deals, stages, users] = await Promise.all([
      prisma.deal.findMany({ select: { amount: true, probability: true, stage: true, status: true, ownerId: true } }),
      prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } }),
      prisma.users.findMany({ where: { status: 'active' }, select: { id: true, name: true } }),
    ]);

    const isWon = (d: { stage: string; status: string }) => d.stage === 'Closed Won' || d.status === 'won';
    const isLost = (d: { stage: string; status: string }) => d.stage === 'Closed Lost' || d.status === 'lost';
    const isOpen = (d: { stage: string; status: string }) => !isWon(d) && !isLost(d);

    const open = deals.filter(isOpen);
    const won = deals.filter(isWon);
    const lost = deals.filter(isLost);

    const pipelineValue = open.reduce((s, d) => s + (d.amount || 0), 0);
    const forecastRevenue = open.reduce((s, d) => s + weightedRevenue(d.amount, d.probability), 0);
    const wonValue = won.reduce((s, d) => s + (d.amount || 0), 0);
    const lostValue = lost.reduce((s, d) => s + (d.amount || 0), 0);

    const closedCount = won.length + lost.length;
    const winRate = closedCount > 0 ? Math.round((won.length / closedCount) * 1000) / 10 : 0;
    const lossRate = closedCount > 0 ? Math.round((lost.length / closedCount) * 1000) / 10 : 0;
    const avgDealValue = deals.length > 0 ? Math.round(deals.reduce((s, d) => s + (d.amount || 0), 0) / deals.length) : 0;

    // Per-stage breakdown — every stage, including empty ones.
    const byStage = stages.map((s) => {
      const inStage = deals.filter((d) => d.stage === s.name);
      const value = inStage.reduce((sum, d) => sum + (d.amount || 0), 0);
      return {
        stage: s.name,
        orderIndex: s.orderIndex,
        count: inStage.length,
        value,
        weightedForecast: inStage.reduce((sum, d) => sum + weightedRevenue(d.amount, d.probability), 0),
        probability: STAGE_PROBABILITY[s.name] ?? 10,
      };
    });

    // Revenue (won) + active forecast per owner.
    const ownerName = (id: number) => users.find((u) => u.id === id)?.name ?? 'Unassigned';
    const ownerIds = Array.from(new Set(deals.map((d) => d.ownerId)));
    const byOwner = ownerIds
      .map((oid) => ({
        ownerId: oid,
        name: ownerName(oid),
        wonRevenue: deals.filter((d) => d.ownerId === oid && isWon(d)).reduce((s, d) => s + (d.amount || 0), 0),
        forecast: deals.filter((d) => d.ownerId === oid && isOpen(d)).reduce((s, d) => s + weightedRevenue(d.amount, d.probability), 0),
        openCount: deals.filter((d) => d.ownerId === oid && isOpen(d)).length,
      }))
      .sort((a, b) => b.wonRevenue - a.wonRevenue);

    res.json({
      totals: { total: deals.length, open: open.length, won: won.length, lost: lost.length },
      revenue: { pipelineValue, forecastRevenue, wonValue, lostValue, avgDealValue },
      rates: { winRate, lossRate },
      byStage,
      byOwner,
      closedStages: CLOSED_DEAL_STAGES,
    });
  } catch (error) {
    console.error('Error building deal analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Deal Notes (editable add / edit / delete) ────────────────────────────────
// Mirrors the lead-notes CRUD. Editable notes live in their own `deal_notes`
// table, kept SEPARATE from the append-only activity_logs audit trail.

/** GET /sales/deals/:id/notes — notes for a deal, newest first. */
export const getDealNotes = async (req: Request, res: Response) => {
  try {
    const dealId = Number(req.params.id);
    if (isNaN(dealId)) return res.status(400).json({ error: 'Invalid deal id' });
    const notes = await prisma.dealNote.findMany({
      where: { dealId },
      include: { author: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(notes);
  } catch (error) {
    console.error('Error fetching deal notes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/deals/:id/notes — add a free-text note (rejects empty content). */
export const createDealNote = async (req: Request, res: Response) => {
  try {
    const dealId = Number(req.params.id);
    if (isNaN(dealId)) return res.status(400).json({ error: 'Invalid deal id' });
    const authorId = (req as any).userId;
    if (!authorId) return res.status(401).json({ error: 'Unauthorized' });

    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Note content cannot be empty.' });

    const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true, title: true, ownerId: true } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const note = await prisma.dealNote.create({
      data: { dealId, authorId, content },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    const actorName = note.author?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: authorId, dealId, type: 'deal_note_added',
      description: `${actorName} added a note to deal "${deal.title}".`,
    });
    if (deal.ownerId && deal.ownerId !== authorId) {
      await notificationService.createNotification({
        userId: deal.ownerId, type: 'discussion', title: 'New note on deal',
        message: `${actorName} added a note to "${deal.title}".`,
        entityType: 'deal', entityId: dealId,
      });
    }

    res.status(201).json(note);
  } catch (error) {
    console.error('Error creating deal note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/deals/:dealId/notes/:noteId — edit a note (author or admin). */
export const updateDealNote = async (req: Request, res: Response) => {
  try {
    const noteId = Number(req.params.noteId);
    if (isNaN(noteId)) return res.status(400).json({ error: 'Invalid note id' });

    const actorId = (req as any).userId;
    const role = String((req as any).userRole || '').toLowerCase();

    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Note content cannot be empty.' });

    const existing = await prisma.dealNote.findUnique({ where: { id: noteId }, include: { deal: { select: { title: true } } } });
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    const isAdmin = role.includes('admin');
    if (existing.authorId !== actorId && !isAdmin) {
      return res.status(403).json({ error: 'You can only edit your own notes.' });
    }

    const note = await prisma.dealNote.update({
      where: { id: noteId },
      data: { content },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: actorId, dealId: existing.dealId, type: 'deal_note_updated',
      description: `${actor?.name || 'Someone'} updated a note on deal "${existing.deal?.title || ''}".`,
    });

    res.json(note);
  } catch (error) {
    console.error('Error updating deal note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/deals/:dealId/notes/:noteId — delete a note (author or admin). */
export const deleteDealNote = async (req: Request, res: Response) => {
  try {
    const noteId = Number(req.params.noteId);
    if (isNaN(noteId)) return res.status(400).json({ error: 'Invalid note id' });

    const actorId = (req as any).userId;
    const role = String((req as any).userRole || '').toLowerCase();

    const existing = await prisma.dealNote.findUnique({ where: { id: noteId }, include: { deal: { select: { title: true } } } });
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    const isAdmin = role.includes('admin');
    if (existing.authorId !== actorId && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own notes.' });
    }

    await prisma.dealNote.delete({ where: { id: noteId } });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: actorId, dealId: existing.dealId, type: 'deal_note_deleted',
      description: `${actor?.name || 'Someone'} deleted a note on deal "${existing.deal?.title || ''}".`,
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting deal note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /sales/deals/:id — permanently delete a deal (requires sales.delete).
 * All deal dependents cascade or null out at the DB level (deal_notes/follow-ups/
 * sales-tasks/document-approvals/recurrence cascade; activity_logs/quotations
 * SetNull), so a direct delete is safe.
 */
export const deleteDeal = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid deal id' });

    const actorId = (req as any).userId;
    const existing = await prisma.deal.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    // Remove every dependent record explicitly inside one transaction. DB-level
    // ON DELETE cascades are NOT guaranteed here (tables are provisioned via raw
    // SQL, not Prisma migrations), so deletion never leaves orphans or hits a
    // foreign-key error. Audit trail + quotations are UNLINKED (SetNull) to
    // survive the deal.
    await prisma.$transaction(async (tx) => {
      await tx.activity_logs.updateMany({ where: { deal_id: id }, data: { deal_id: null } });
      await tx.quotation.updateMany({ where: { dealId: id }, data: { dealId: null } });

      const approvals = await tx.documentApproval.findMany({ where: { dealId: id }, select: { id: true } });
      if (approvals.length) {
        const approvalIds = approvals.map((a) => a.id);
        await tx.documentApprovalHistory.deleteMany({ where: { approvalId: { in: approvalIds } } });
        await tx.documentApproval.deleteMany({ where: { dealId: id } });
      }

      await tx.salesTask.deleteMany({ where: { dealId: id } });
      await tx.recurrenceRule.deleteMany({ where: { dealId: id } });
      await tx.followUp.deleteMany({ where: { dealId: id } });
      await tx.dealNote.deleteMany({ where: { dealId: id } });

      await tx.deal.delete({ where: { id } });
    });

    // Log WITHOUT dealId — the deal (and its FK target) is now gone.
    if (actorId) {
      const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
      await activityService.logActivity({
        actorUserId: actorId, type: 'deal_deleted',
        description: `${actor?.name || 'Someone'} deleted deal "${existing.title}".`,
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
