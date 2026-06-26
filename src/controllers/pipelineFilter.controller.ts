import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { weightedRevenue } from '../services/dealEvent.service.js';
import { computeStalledStatus, stalledDealService } from '../services/stalledDeal.service.js';
import { getSalesAuth, ownerScopeFilter } from '../utils/salesAuth.js';

/**
 * SE-020.1 — Pipeline Filter Views (advanced, combinable deal filters) and
 * SE-021.1 — per-stage stalled-threshold configuration.
 *
 * The pipeline endpoint applies DB-level filters where possible, then annotates
 * each deal with its computed stalled status so "Stalled"/"At Risk" can be used
 * both as a filter and as a card indicator.
 */

const dealInclude = {
  customer: { select: { id: true, name: true, company: true } },
  owner: { select: { id: true, name: true, email: true } },
  lead: { select: { id: true, title: true } },
} as const;

/**
 * GET /sales/pipeline/deals — advanced, combinable filters:
 *   valueMin, valueMax, stage (csv), ownerId, closeMonth (YYYY-MM),
 *   probabilityMin, probabilityMax, source, company, status
 *   (open|won|lost|stalled|at_risk|healthy), search.
 * Returns deals annotated with `stalledStatus` + the pipeline summary.
 */
export const getPipelineDeals = async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const where: any = {};

    // ── Value band ────────────────────────────────────────────────────────
    const amount: any = {};
    if (q.valueMin != null && q.valueMin !== '' && !isNaN(Number(q.valueMin))) amount.gte = Number(q.valueMin);
    if (q.valueMax != null && q.valueMax !== '' && !isNaN(Number(q.valueMax))) amount.lte = Number(q.valueMax);
    if (Object.keys(amount).length) where.amount = amount;

    // ── Stage (single or comma-separated) ─────────────────────────────────
    if (typeof q.stage === 'string' && q.stage.trim() && q.stage !== 'all') {
      const stages = q.stage.split(',').map((s) => s.trim()).filter(Boolean);
      where.stage = stages.length > 1 ? { in: stages } : stages[0];
    }

    // ── Owner ─────────────────────────────────────────────────────────────
    if (q.ownerId != null && q.ownerId !== '' && q.ownerId !== 'all' && !isNaN(Number(q.ownerId))) {
      where.ownerId = Number(q.ownerId);
    }

    // ── Probability band ──────────────────────────────────────────────────
    const probability: any = {};
    if (q.probabilityMin != null && q.probabilityMin !== '' && !isNaN(Number(q.probabilityMin))) probability.gte = Number(q.probabilityMin);
    if (q.probabilityMax != null && q.probabilityMax !== '' && !isNaN(Number(q.probabilityMax))) probability.lte = Number(q.probabilityMax);
    if (Object.keys(probability).length) where.probability = probability;

    // ── Source ────────────────────────────────────────────────────────────
    if (typeof q.source === 'string' && q.source.trim() && q.source !== 'all') where.source = q.source.trim();

    // ── Close month (YYYY-MM) ─────────────────────────────────────────────
    if (typeof q.closeMonth === 'string' && /^\d{4}-\d{2}$/.test(q.closeMonth)) {
      const [y, m] = q.closeMonth.split('-').map(Number);
      where.expectedCloseDate = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }

    // ── Lifecycle status (DB-level only — computed ones handled below) ─────
    const statusFilter = typeof q.status === 'string' ? q.status.trim() : '';
    if (statusFilter === 'open') where.status = 'open';
    else if (statusFilter === 'won') where.status = 'won';
    else if (statusFilter === 'lost') where.status = 'lost';

    // ── Company + free-text search ────────────────────────────────────────
    const ands: any[] = [];
    if (typeof q.company === 'string' && q.company.trim()) {
      ands.push({ customer: { is: { company: { contains: q.company.trim(), mode: 'insensitive' } } } });
    }
    if (typeof q.search === 'string' && q.search.trim()) {
      const term = q.search.trim();
      ands.push({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { customer: { is: { company: { contains: term, mode: 'insensitive' } } } },
          { customer: { is: { name: { contains: term, mode: 'insensitive' } } } },
        ],
      });
    }
    if (ands.length) where.AND = ands;

    // RBAC data scoping: BDE = own pipeline, manager = team, admin/unteamed = all.
    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx, typeof where.ownerId === 'number' ? where.ownerId : undefined);
    if (scope === undefined) delete where.ownerId;
    else where.ownerId = scope;

    const [deals, thresholds] = await Promise.all([
      prisma.deal.findMany({
        where,
        include: dealInclude,
        orderBy: [{ stage: 'asc' }, { orderIndex: 'asc' }, { updatedAt: 'desc' }],
      }),
      stalledDealService.getThresholdMap(),
    ]);

    const now = new Date();
    let annotated = deals.map((d) => ({
      ...d,
      weightedRevenue: weightedRevenue(d.amount, d.probability),
      stalledStatus: computeStalledStatus(d, thresholds, now),
    }));

    // ── Computed status filters (stalled / at_risk / healthy) ─────────────
    if (statusFilter === 'stalled') annotated = annotated.filter((d) => d.stalledStatus.level === 'stalled');
    else if (statusFilter === 'at_risk') annotated = annotated.filter((d) => d.stalledStatus.level === 'at_risk');
    else if (statusFilter === 'healthy') annotated = annotated.filter((d) => d.stalledStatus.level === 'healthy');

    const summary = {
      count: annotated.length,
      totalValue: annotated.reduce((s, d) => s + (d.amount || 0), 0),
      weightedForecast: annotated.reduce((s, d) => s + d.weightedRevenue, 0),
      stalled: annotated.filter((d) => d.stalledStatus.level === 'stalled').length,
      atRisk: annotated.filter((d) => d.stalledStatus.level === 'at_risk').length,
    };

    res.json({ deals: annotated, summary });
  } catch (error) {
    console.error('Error fetching pipeline deals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /sales/stage-config — deal stages with their stalled thresholds. */
export const getStageConfig = async (_req: Request, res: Response) => {
  try {
    const stages = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(stages);
  } catch (error) {
    console.error('Error fetching stage config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/stage-config — update per-stage stalled thresholds (SE-021.1).
 * Body: { thresholds: { [stageName]: days } }. Requires sales.config.
 */
export const updateStageConfig = async (req: Request, res: Response) => {
  try {
    const thresholds = req.body?.thresholds;
    if (!thresholds || typeof thresholds !== 'object') {
      return res.status(400).json({ error: 'A thresholds map is required.' });
    }

    const updates: Promise<any>[] = [];
    for (const [name, raw] of Object.entries(thresholds)) {
      const days = Number(raw);
      if (isNaN(days) || days < 1 || days > 365) continue;
      updates.push(
        prisma.dealStage.updateMany({ where: { name }, data: { stalledThresholdDays: Math.round(days) } }),
      );
    }
    await Promise.all(updates);

    // Re-evaluate stalled flags immediately so the change is reflected at once.
    await stalledDealService.scanStalledDeals();

    const stages = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(stages);
  } catch (error) {
    console.error('Error updating stage config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
