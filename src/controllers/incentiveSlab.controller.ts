import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { getSalesAuth } from '../utils/salesAuth.js';

/**
 * SE-042.1 — Incentive Slab Configuration. Per-BDE achievement-range → incentive
 * (% of target value, or a fixed amount). Validation enforces non-negative
 * values and non-overlapping ranges with at most one open-ended top slab. Config
 * is gated by sales.incentive.manage (route level); the calculation engine lives
 * in target.service (SE-042.2).
 */

const slabInclude = {
  owner: { select: { id: true, name: true, email: true } },
} as const;

/** Validate the full proposed slab set for an owner (non-negative + no overlaps). */
function validateSlabSet(slabs: { minAchievementPct: number; maxAchievementPct: number | null }[]): string | null {
  for (const s of slabs) {
    if (s.minAchievementPct < 0) return 'Achievement percentages cannot be negative.';
    if (s.maxAchievementPct != null) {
      if (s.maxAchievementPct < 0) return 'Achievement percentages cannot be negative.';
      if (s.maxAchievementPct <= s.minAchievementPct) return 'Each slab max must be greater than its min.';
    }
  }
  // Only one open-ended (null max) slab allowed.
  if (slabs.filter((s) => s.maxAchievementPct == null).length > 1) {
    return 'Only one open-ended (no upper bound) slab is allowed.';
  }
  // No overlaps: sort by min and ensure each next min >= previous max.
  const sorted = [...slabs].sort((a, b) => a.minAchievementPct - b.minAchievementPct);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.maxAchievementPct == null) return 'The open-ended slab must be the highest range.';
    if (cur.minAchievementPct < prev.maxAchievementPct) return 'Slab ranges must not overlap.';
  }
  return null;
}

/** GET /sales/incentive-slabs?ownerId= — list a BDE's incentive slabs. */
export const getIncentiveSlabs = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const ownerId = req.query.ownerId != null && !isNaN(Number(req.query.ownerId)) ? Number(req.query.ownerId) : ctx.userId;

    const slabs = await prisma.incentiveSlab.findMany({
      where: { ownerId },
      include: slabInclude,
      orderBy: { minAchievementPct: 'asc' },
    });
    res.json(slabs);
  } catch (error) {
    console.error('Error fetching incentive slabs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** Shared body parse for create/update. */
function parseSlabBody(body: any): { value?: { minAchievementPct: number; maxAchievementPct: number | null; incentivePct: number | null; incentiveAmount: number | null }; error?: string } {
  const min = Number(body.minAchievementPct);
  if (isNaN(min) || min < 0) return { error: 'minAchievementPct must be a non-negative number.' };
  let max: number | null = null;
  if (body.maxAchievementPct != null && body.maxAchievementPct !== '') {
    max = Number(body.maxAchievementPct);
    if (isNaN(max) || max < 0) return { error: 'maxAchievementPct must be a non-negative number.' };
  }
  let incentivePct: number | null = null;
  let incentiveAmount: number | null = null;
  if (body.incentivePct != null && body.incentivePct !== '') {
    incentivePct = Number(body.incentivePct);
    if (isNaN(incentivePct) || incentivePct < 0) return { error: 'incentivePct must be a non-negative number.' };
  }
  if (body.incentiveAmount != null && body.incentiveAmount !== '') {
    incentiveAmount = Number(body.incentiveAmount);
    if (isNaN(incentiveAmount) || incentiveAmount < 0) return { error: 'incentiveAmount must be a non-negative number.' };
  }
  if (incentivePct == null && incentiveAmount == null) {
    return { error: 'Provide an incentive percentage or a fixed amount.' };
  }
  return { value: { minAchievementPct: min, maxAchievementPct: max, incentivePct, incentiveAmount } };
}

/** POST /sales/incentive-slabs — create a slab (validates the whole owner set). */
export const createIncentiveSlab = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const body = req.body ?? {};

    const ownerId = body.ownerId != null && !isNaN(Number(body.ownerId)) ? Number(body.ownerId) : ctx.userId;
    if (!(await prisma.users.findUnique({ where: { id: ownerId }, select: { id: true } }))) {
      return res.status(404).json({ error: 'Owner not found.' });
    }

    const parsed = parseSlabBody(body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const existing = await prisma.incentiveSlab.findMany({ where: { ownerId, active: true } });
    const proposed = [...existing, parsed.value!];
    const validationError = validateSlabSet(proposed);
    if (validationError) return res.status(400).json({ error: validationError });

    const slab = await prisma.incentiveSlab.create({
      data: { ownerId, ...parsed.value!, active: true, createdById: ctx.userId },
      include: slabInclude,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'A manager';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'incentive_slab_created',
      description: `${actorName} added an incentive slab (${parsed.value!.minAchievementPct}%–${parsed.value!.maxAchievementPct ?? '∞'}%) for owner #${ownerId}.`,
    });
    if (ownerId !== ctx.userId) {
      await notificationService.createNotification({
        userId: ownerId,
        type: 'status_change',
        title: 'Incentive structure updated',
        message: `Your incentive slab structure was updated by ${actorName}.`,
        entityType: 'incentive',
        entityId: slab.id,
      });
    }

    res.status(201).json(slab);
  } catch (error) {
    console.error('Error creating incentive slab:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/incentive-slabs/:id — update a slab (re-validates the owner set). */
export const updateIncentiveSlab = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid slab id' });

    const existing = await prisma.incentiveSlab.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Slab not found' });

    const parsed = parseSlabBody({ ...existing, ...req.body });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const others = await prisma.incentiveSlab.findMany({ where: { ownerId: existing.ownerId, active: true, id: { not: id } } });
    const validationError = validateSlabSet([...others, parsed.value!]);
    if (validationError) return res.status(400).json({ error: validationError });

    const slab = await prisma.incentiveSlab.update({ where: { id }, data: parsed.value!, include: slabInclude });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'A manager';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'incentive_slab_updated',
      description: `${actorName} updated an incentive slab for owner #${existing.ownerId}.`,
    });

    res.json(slab);
  } catch (error) {
    console.error('Error updating incentive slab:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/incentive-slabs/:id — remove a slab. */
export const deleteIncentiveSlab = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid slab id' });

    const existing = await prisma.incentiveSlab.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Slab not found' });

    await prisma.incentiveSlab.delete({ where: { id } });
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'incentive_slab_deleted',
      description: `An incentive slab for owner #${existing.ownerId} was removed.`,
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting incentive slab:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
