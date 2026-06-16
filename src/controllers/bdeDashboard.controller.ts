import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, isManager } from '../utils/salesAuth.js';

/**
 * SE-025.1 — BDE Daily Dashboard.
 *
 * A single aggregate payload powering the Business Development Executive home
 * screen: today's tasks, follow-ups, lead & deal summaries, target progress,
 * productivity metrics and smart alerts. Reuses the existing sales tables — no
 * isolated reporting store.
 */

const taskInclude = {
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
} as const;

const INACTIVE_LEAD_STATUSES = ['disqualified', 'converted', 'won', 'lost', 'closed'];

/** Resolves the dashboard owner: self by default; managers may inspect others. */
async function resolveOwnerId(req: Request): Promise<number> {
  const ctx = await getSalesAuth(req);
  const requested = Number(req.query.ownerId);
  if (!isNaN(requested) && requested !== ctx.userId && isManager(ctx)) return requested;
  return ctx.userId;
}

/** GET /sales/bde/dashboard?ownerId= — full BDE home-screen payload. */
export const getBdeDashboard = async (req: Request, res: Response) => {
  try {
    const ownerId = await resolveOwnerId(req);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [
      myTasks,
      leads,
      deals,
      followUpsPending,
      followUpsCompletedMonth,
      callsThisMonth,
      meetingsThisMonth,
      pendingApprovals,
      target,
    ] = await Promise.all([
      // Owner's open tasks (for today/overdue/upcoming/blocked buckets).
      prisma.salesTask.findMany({
        where: { assigneeId: ownerId, status: { not: 'completed' } },
        include: taskInclude,
        orderBy: [{ dueDate: 'asc' }],
      }),
      // Owner's leads (lifecycle summary).
      prisma.lead.findMany({
        where: { ownerId },
        select: { id: true, status: true, stage: true, score: true, createdAt: true },
      }),
      // Owner's deals (pipeline summary).
      prisma.deal.findMany({
        where: { ownerId },
        select: { id: true, status: true, stage: true, amount: true, stalled: true, closedAt: true },
      }),
      // Pending follow-ups (scheduled vs missed split in JS).
      prisma.followUp.findMany({
        where: { ownerId, status: 'pending' },
        select: { id: true, scheduledDate: true },
      }),
      prisma.followUp.count({
        where: { ownerId, status: 'completed', completedAt: { gte: startOfMonth, lt: startOfNextMonth } },
      }),
      prisma.leadInteraction.count({
        where: { authorId: ownerId, type: 'Call', interactionDate: { gte: startOfMonth, lt: startOfNextMonth } },
      }),
      prisma.leadInteraction.count({
        where: { authorId: ownerId, type: 'Meeting', interactionDate: { gte: startOfMonth, lt: startOfNextMonth } },
      }),
      prisma.documentApproval.count({ where: { submittedById: ownerId, status: 'pending' } }),
      prisma.salesTarget.findUnique({ where: { ownerId_period: { ownerId, period } } }),
    ]);

    // ── Tasks buckets ─────────────────────────────────────────────────────
    const dueToday = myTasks.filter((t) => t.dueDate && t.dueDate >= startOfToday && t.dueDate < endOfToday);
    const overdue = myTasks.filter((t) => t.dueDate && t.dueDate < startOfToday);
    const upcoming = myTasks.filter((t) => !t.dueDate || t.dueDate >= endOfToday);
    const blocked = myTasks.filter((t) => t.blocked);

    // ── Follow-ups ────────────────────────────────────────────────────────
    const followScheduled = followUpsPending.filter((f) => f.scheduledDate >= startOfToday);
    const followMissed = followUpsPending.filter((f) => f.scheduledDate < startOfToday);
    const followDueToday = followUpsPending.filter((f) => f.scheduledDate >= startOfToday && f.scheduledDate < endOfToday);

    // ── Lead summary ──────────────────────────────────────────────────────
    const leadActive = leads.filter((l) => !INACTIVE_LEAD_STATUSES.includes(l.status));
    const leadSummary = {
      assigned: leads.length,
      new: leads.filter((l) => l.status === 'new').length,
      qualified: leadActive.filter((l) => l.stage !== 'New').length,
      converted: leads.filter((l) => l.status === 'converted').length,
    };

    // ── Deal summary ──────────────────────────────────────────────────────
    const dealActive = deals.filter((d) => d.status === 'open');
    const dealSummary = {
      active: dealActive.length,
      stalled: deals.filter((d) => d.stalled && d.status === 'open').length,
      won: deals.filter((d) => d.status === 'won').length,
      lost: deals.filter((d) => d.status === 'lost').length,
    };

    // ── Target progress ───────────────────────────────────────────────────
    const achievement = deals
      .filter((d) => d.status === 'won' && d.closedAt && d.closedAt >= startOfMonth && d.closedAt < startOfNextMonth)
      .reduce((s, d) => s + (d.amount || 0), 0);
    const targetAmount = target?.targetAmount ?? 0;
    const targetProgress = {
      period,
      target: targetAmount,
      achievement,
      remaining: Math.max(0, targetAmount - achievement),
      achievementPct: targetAmount > 0 ? Math.round((achievement / targetAmount) * 100) : 0,
    };

    // ── Productivity metrics (this month) ─────────────────────────────────
    const conversionRate = leads.length > 0 ? Math.round((leadSummary.converted / leads.length) * 1000) / 10 : 0;
    const productivity = {
      callsCompleted: callsThisMonth,
      meetingsCompleted: meetingsThisMonth,
      followUpsCompleted: followUpsCompletedMonth,
      conversionRate,
    };

    // ── Smart alerts ──────────────────────────────────────────────────────
    const highValueLeads = leadActive.filter((l) => l.score >= 70 && l.status === 'new').length;
    const smartAlerts: { type: string; severity: string; message: string; count: number }[] = [];
    if (followDueToday.length) smartAlerts.push({ type: 'follow_up', severity: 'info', count: followDueToday.length, message: `${followDueToday.length} follow-up${followDueToday.length > 1 ? 's' : ''} due today.` });
    if (overdue.length) smartAlerts.push({ type: 'task_overdue', severity: 'danger', count: overdue.length, message: `${overdue.length} task${overdue.length > 1 ? 's are' : ' is'} overdue.` });
    if (dealSummary.stalled) smartAlerts.push({ type: 'stalled', severity: 'warning', count: dealSummary.stalled, message: `${dealSummary.stalled} stalled deal${dealSummary.stalled > 1 ? 's' : ''} require attention.` });
    if (pendingApprovals) smartAlerts.push({ type: 'approval', severity: 'info', count: pendingApprovals, message: `${pendingApprovals} document${pendingApprovals > 1 ? 's' : ''} awaiting approval.` });
    if (highValueLeads) smartAlerts.push({ type: 'hot_lead', severity: 'warning', count: highValueLeads, message: `${highValueLeads} high-value lead${highValueLeads > 1 ? 's' : ''} need contact.` });
    if (blocked.length) smartAlerts.push({ type: 'blocked', severity: 'danger', count: blocked.length, message: `${blocked.length} task${blocked.length > 1 ? 's are' : ' is'} blocked.` });

    res.json({
      ownerId,
      tasks: {
        dueToday,
        overdue,
        upcoming: upcoming.slice(0, 25),
        blocked,
        counts: { dueToday: dueToday.length, overdue: overdue.length, upcoming: upcoming.length, blocked: blocked.length },
      },
      followUps: {
        scheduled: followScheduled.length,
        missed: followMissed.length,
        completed: followUpsCompletedMonth,
        dueToday: followDueToday.length,
      },
      leads: leadSummary,
      deals: dealSummary,
      target: targetProgress,
      productivity,
      smartAlerts,
    });
  } catch (error) {
    console.error('Error building BDE dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /sales/targets/my?period=YYYY-MM — the owner's target for a period. */
export const getMyTarget = async (req: Request, res: Response) => {
  try {
    const ownerId = await resolveOwnerId(req);
    const now = new Date();
    const period =
      typeof req.query.period === 'string' && /^\d{4}-\d{2}$/.test(req.query.period)
        ? req.query.period
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const target = await prisma.salesTarget.findUnique({ where: { ownerId_period: { ownerId, period } } });
    res.json(target ?? { ownerId, period, targetAmount: 0 });
  } catch (error) {
    console.error('Error fetching target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/targets — set a monthly target. Self by default; managers can set
 * targets for their team. Requires sales.edit (route-gated).
 */
export const setTarget = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const now = new Date();
    const period =
      typeof req.body.period === 'string' && /^\d{4}-\d{2}$/.test(req.body.period)
        ? req.body.period
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let ownerId = ctx.userId;
    if (req.body.ownerId != null && !isNaN(Number(req.body.ownerId)) && Number(req.body.ownerId) !== ctx.userId) {
      if (!isManager(ctx)) return res.status(403).json({ error: 'Only managers can set targets for others.' });
      ownerId = Number(req.body.ownerId);
    }

    const targetAmount = Number(req.body.targetAmount);
    if (isNaN(targetAmount) || targetAmount < 0) return res.status(400).json({ error: 'Target amount must be a non-negative number.' });

    const target = await prisma.salesTarget.upsert({
      where: { ownerId_period: { ownerId, period } },
      create: { ownerId, period, targetAmount },
      update: { targetAmount },
    });
    res.json(target);
  } catch (error) {
    console.error('Error setting target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
