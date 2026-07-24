import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, can, resolveTeamOwnerIds } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { targetService, type TargetType, type PeriodType } from '../services/target.service.js';
import { buildMultiSheetBuffer, exportMeta, type ExportFormat, type ExportSheet } from '../utils/exportWorkbook.js';

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

// Statuses that take a lead OFF the pipeline board (left via an action): mirrors
// the Leads Pipeline board so won/lost/closed leads (which stay visible in their
// terminal column) are still counted as qualified, consistent with the board.
const OFF_BOARD_LEAD_STATUSES = ['converted', 'disqualified'];

/**
 * Resolves the dashboard/target owner: self by default; a manager/lead may
 * inspect another owner ONLY within their team scope (resolveTeamOwnerIds: null =
 * all owners for admins / unteamed-legacy managers). A teamed manager cannot read
 * a user outside their team; a BDE is always pinned to self.
 */
async function resolveOwnerId(req: Request): Promise<number> {
  const ctx = await getSalesAuth(req);
  const requested = Number(req.query.ownerId);
  if (!isNaN(requested) && requested !== ctx.userId) {
    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
    if (ownerIds === null || ownerIds.includes(requested)) return requested;
  }
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
        select: { id: true, status: true, stage: true, amount: true, stalled: true, closedAt: true, createdAt: true },
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
      // Active target = current-month REVENUE target (preserves the BDE home screen).
      prisma.salesTarget.findFirst({ where: { ownerId, period, periodType: 'monthly', type: 'revenue' } }),
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
    // On-board = still shown on the Leads Pipeline board (only converted/
    // disqualified are removed), so "qualified" counts won/lost the board keeps.
    const leadActive = leads.filter((l) => !OFF_BOARD_LEAD_STATUSES.includes(l.status));
    const leadSummary = {
      assigned: leads.length,
      new: leads.filter((l) => l.stage === 'NQL').length,
      qualified: leadActive.filter((l) => l.stage !== 'NQL').length,
      converted: leads.filter((l) => l.status === 'converted').length,
    };

    const leadsToday = leads.filter(l => l.createdAt >= startOfToday && l.createdAt < endOfToday);
    const leadActiveToday = leadsToday.filter((l) => !OFF_BOARD_LEAD_STATUSES.includes(l.status));
    const todayLeadSummary = {
      assigned: leadsToday.length,
      new: leadsToday.filter((l) => l.stage === 'NQL').length,
      qualified: leadActiveToday.filter((l) => l.stage !== 'NQL').length,
      converted: leadsToday.filter((l) => l.status === 'converted').length,
    };

    // ── Deal summary ──────────────────────────────────────────────────────
    const dealActive = deals.filter((d) => d.status === 'open');
    const dealSummary = {
      active: dealActive.length,
      stalled: deals.filter((d) => d.stalled && d.status === 'open').length,
      won: deals.filter((d) => d.status === 'won').length,
      lost: deals.filter((d) => d.status === 'lost').length,
    };

    const dealsToday = deals.filter(d => d.createdAt && d.createdAt >= startOfToday && d.createdAt < endOfToday);
    const dealActiveToday = dealsToday.filter((d) => d.status === 'open');
    const todayDealSummary = {
      active: dealActiveToday.length,
      stalled: dealsToday.filter((d) => d.stalled && d.status === 'open').length,
      won: dealsToday.filter((d) => d.status === 'won').length,
      lost: dealsToday.filter((d) => d.status === 'lost').length,
    };

    // ── Target progress ───────────────────────────────────────────────────
    const achievement = deals
      .filter((d) => d.status === 'won' && d.closedAt && d.closedAt >= startOfMonth && d.closedAt < startOfNextMonth)
      .reduce((s, d) => s + (d.amount || 0), 0);
    const targetAmount = target?.targetAmount ?? 0;
    // Round for display, but never round UP across a status boundary so the %,
    // status and remaining stay mutually consistent (mirrors the Targets module).
    const rawPct = targetAmount > 0 ? (achievement / targetAmount) * 100 : 0;
    let achievementPct = Math.round(rawPct);
    if (achievementPct >= 100 && rawPct < 100) achievementPct = 99;
    if (achievementPct >= targetService.EXCEEDED_PCT && rawPct < targetService.EXCEEDED_PCT) {
      achievementPct = targetService.EXCEEDED_PCT - 1;
    }
    // SE-042 — incentive earned at the current achievement for this owner.
    const incentive = await targetService.computeIncentive(ownerId, achievementPct, targetAmount);
    // Computed status — READ-ONLY on the BDE dashboard (current-month window).
    const status = targetService.computeStatus(rawPct, { start: startOfMonth, end: startOfNextMonth }, now);
    const targetProgress = {
      period,
      type: 'revenue' as const,
      hasTarget: !!target,
      target: targetAmount,
      achievement,
      remaining: Math.max(0, targetAmount - achievement),
      achievementPct,
      reached: targetAmount > 0 && achievement >= targetAmount,
      incentiveEarned: incentive.incentiveEarned,
      status,
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
    const highValueLeads = leadActive.filter((l) => l.score >= 70 && l.stage === 'NQL').length;
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
      todayLeads: todayLeadSummary,
      deals: dealSummary,
      todayDeals: todayDealSummary,
      target: targetProgress,
      productivity,
      smartAlerts,
    });
  } catch (error) {
    console.error('Error building BDE dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};


/** GET /sales/bde/dashboard/export?type=daily|weekly&format=csv|xlsx */
export const exportBdeDashboard = async (req: Request, res: Response) => {
  try {
    const ownerId = await resolveOwnerId(req);
    const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'json' ? 'json' : 'xlsx';
    const reportType = String(req.query.type || 'daily');

    const now = new Date();
    let startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (reportType === 'weekly') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
      startDate = new Date(now.getFullYear(), now.getMonth(), diff);
    }
    
    const endDate = new Date(startDate.getTime());
    if (reportType === 'weekly') {
      endDate.setDate(endDate.getDate() + 7);
    } else {
      endDate.setDate(endDate.getDate() + 1);
    }

    const [myTasks, leads, deals, followUpsPending] = await Promise.all([
      prisma.salesTask.findMany({
        where: { assigneeId: ownerId, status: { not: 'completed' } },
        select: { dueDate: true, blocked: true },
      }),
      prisma.lead.findMany({
        where: { ownerId },
        select: { status: true, stage: true, createdAt: true },
      }),
      prisma.deal.findMany({
        where: { ownerId },
        select: { status: true, stalled: true, createdAt: true },
      }),
      prisma.followUp.findMany({
        where: { ownerId, status: 'pending' },
        select: { scheduledDate: true },
      }),
    ]);

    const leadsInPeriod = leads.filter(l => l.createdAt >= startDate && l.createdAt < endDate);
    const leadActiveInPeriod = leadsInPeriod.filter(l => !OFF_BOARD_LEAD_STATUSES.includes(l.status));
    
    const dealsInPeriod = deals.filter(d => d.createdAt && d.createdAt >= startDate && d.createdAt < endDate);
    
    const sheet = {
      name: `BDE ${reportType === 'weekly' ? 'Weekly' : 'Daily'} Summary`,
      headers: ['Metric', 'Count'],
      rows: [
        ['Tasks Due', myTasks.filter(t => t.dueDate && t.dueDate >= startDate && t.dueDate < endDate).length],
        ['Tasks Overdue', myTasks.filter(t => t.dueDate && t.dueDate < startDate).length],
        ['Tasks Blocked', myTasks.filter(t => t.blocked).length],
        ['Follow-ups Due', followUpsPending.filter(f => f.scheduledDate >= startDate && f.scheduledDate < endDate).length],
        ['Leads Assigned', leadsInPeriod.length],
        ['Leads New', leadsInPeriod.filter(l => l.stage === 'NQL').length],
        ['Leads Qualified', leadActiveInPeriod.filter(l => l.stage !== 'NQL').length],
        ['Leads Converted', leadsInPeriod.filter(l => l.status === 'converted').length],
        ['Deals Active', dealsInPeriod.filter(d => d.status === 'open').length],
        ['Deals Stalled', dealsInPeriod.filter(d => d.stalled && d.status === 'open').length],
        ['Deals Won', dealsInPeriod.filter(d => d.status === 'won').length],
        ['Deals Lost', dealsInPeriod.filter(d => d.status === 'lost').length],
      ]
    };

    if (format === 'json') {
      await activityService.logActivity({ actorUserId: ownerId, type: 'report_exported', description: `Exported BDE ${reportType} summary as PDF.` });
      return res.json(sheet);
    }

    const buffer = await buildMultiSheetBuffer([sheet as ExportSheet], format);
    const { mime, ext } = exportMeta(format);

    await activityService.logActivity({ actorUserId: ownerId, type: 'report_exported', description: `Exported BDE ${reportType} summary as ${ext.toUpperCase()}.` });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="bde-${reportType}-summary.${ext}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting BDE dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** Resolve a target type from a request value (defaults to revenue). */
function resolveType(v: unknown): TargetType {
  return typeof v === 'string' && (targetService.VALID_TARGET_TYPES as string[]).includes(v) ? (v as TargetType) : 'revenue';
}

/** Resolve {period, periodType}, defaulting to the current month. */
function resolvePeriod(periodRaw: unknown, periodTypeRaw: unknown): { period: string; periodType: PeriodType } {
  const now = new Date();
  let periodType: PeriodType | null =
    typeof periodTypeRaw === 'string' && (targetService.VALID_PERIOD_TYPES as string[]).includes(periodTypeRaw)
      ? (periodTypeRaw as PeriodType)
      : null;
  let period = typeof periodRaw === 'string' ? periodRaw : '';
  if (!periodType) periodType = period ? targetService.inferPeriodType(period) : 'monthly';
  if (!period || !targetService.isValidPeriod(period, periodType)) {
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    periodType = 'monthly';
  }
  return { period, periodType };
}

/** GET /sales/targets/my?type=&period=&periodType= — the owner's target. */
export const getMyTarget = async (req: Request, res: Response) => {
  try {
    const ownerId = await resolveOwnerId(req);
    const type = resolveType(req.query.type);
    const { period, periodType } = resolvePeriod(req.query.period, req.query.periodType);

    const target = await prisma.salesTarget.findFirst({ where: { ownerId, period, periodType, type } });
    res.json(target ?? { ownerId, period, periodType, type, targetAmount: 0 });
  } catch (error) {
    console.error('Error fetching target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/targets — set a target (any type/period). Self by default; setting
 * another owner's target requires sales.targets.manage. Rejects overlapping
 * periods of the same type for the same owner (SE-040.1).
 */
export const setTarget = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);

    // Single source of truth: targets are created/edited ONLY by Target-
    // Management users (Admin / Sales Manager). A BDE can never set a target —
    // not even their own — from any surface (defense-in-depth behind the route).
    if (!can(ctx, 'sales.targets.manage')) {
      return res.status(403).json({ error: 'Only authorized users can set revenue targets.' });
    }

    const body = req.body ?? {};
    const type = resolveType(body.type);
    const { period, periodType } = resolvePeriod(body.period, body.periodType);

    // Default to self only as a convenience; cross-owner assignment is the norm
    // here (managers assigning to BDEs) and already permitted by the gate above.
    let ownerId = ctx.userId;
    if (body.ownerId != null && !isNaN(Number(body.ownerId))) {
      ownerId = Number(body.ownerId);
    }

    // A teamed manager/lead may assign only within their team scope (admins and
    // unteamed managers = all owners). Mirrors the task-assignment guard.
    if (ownerId !== ctx.userId) {
      const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
      if (ownerIds !== null && !ownerIds.includes(ownerId)) {
        return res.status(403).json({ error: 'You cannot set targets outside your team.' });
      }
    }

    const targetAmount = Number(body.targetAmount);
    if (isNaN(targetAmount) || targetAmount < 0) return res.status(400).json({ error: 'Target amount must be a non-negative number.' });

    // Target Management — optional human label + description.
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 150) : null;
    const description = typeof body.description === 'string' ? body.description.trim() || null : null;

    // Overlapping-period validation: same owner + same metric type, overlapping
    // date windows (a monthly and the quarter that contains it DO conflict).
    const win = targetService.periodWindow(period, periodType);
    const sameType = await prisma.salesTarget.findMany({ where: { ownerId, type } });
    const conflict = sameType.find((t) => {
      if (t.period === period && t.periodType === periodType) return false; // same slot → update path
      return targetService.windowsOverlap(win, targetService.periodWindow(t.period, t.periodType as PeriodType));
    });
    if (conflict) {
      return res.status(409).json({ error: `An overlapping ${type} target already exists for ${conflict.period}.` });
    }

    const existing = await prisma.salesTarget.findFirst({ where: { ownerId, period, periodType, type } });
    const target = existing
      ? await prisma.salesTarget.update({ where: { id: existing.id }, data: { targetAmount, name, description } })
      : await prisma.salesTarget.create({ data: { ownerId, period, periodType, type, targetAmount, name, description } });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'A manager';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'target_set',
      description: `${actorName} set a ${type} target of ${targetAmount} for ${period} (owner #${ownerId}).`,
    });
    if (ownerId !== ctx.userId) {
      await notificationService.createNotification({
        userId: ownerId,
        type: 'status_change',
        title: existing ? 'Target updated' : 'Target assigned',
        message: `${actorName} ${existing ? 'updated' : 'set'} your ${type} target for ${period}: ${targetAmount}.`,
        entityType: 'target',
        entityId: target.id,
      });
    }

    res.json(target);
  } catch (error) {
    console.error('Error setting target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/targets/history?ownerId= — SE-043.1 target history. Lists every
 * persisted target with its LIVE actual / achievement % / incentive earned.
 * Note: actuals are recomputed on read and may shift if underlying deals or
 * interactions change (advisory, not a frozen ledger).
 */
export const getTargetHistory = async (req: Request, res: Response) => {
  try {
    const ownerId = await resolveOwnerId(req);
    const targets = await prisma.salesTarget.findMany({
      where: { ownerId },
      orderBy: [{ period: 'desc' }, { type: 'asc' }],
    });

    const history = [];
    for (const t of targets) {
      const win = targetService.periodWindow(t.period, t.periodType as PeriodType);
      const actual = await targetService.computeActual(ownerId, t.type as TargetType, win);
      const achievementPct = t.targetAmount > 0 ? Math.round((actual / t.targetAmount) * 100) : 0;
      const incentive = await targetService.computeIncentive(ownerId, achievementPct, t.targetAmount);
      history.push({
        id: t.id,
        period: t.period,
        periodType: t.periodType,
        type: t.type,
        target: t.targetAmount,
        actual,
        achievementPct,
        incentiveEarned: incentive.incentiveEarned,
      });
    }

    res.json({
      ownerId,
      history,
      note: 'Actuals and incentives are computed live and may change if underlying deals/interactions change.',
    });
  } catch (error) {
    console.error('Error building target history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
