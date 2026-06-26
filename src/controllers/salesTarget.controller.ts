import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, isManager, resolveTeamOwnerIds } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { targetService, type TargetType, type PeriodType, type TargetStatus } from '../services/target.service.js';

/**
 * Target Management module — list / detail / delete over the existing
 * SalesTarget store. Achievement, incentive and status are COMPUTED LIVE via
 * target.service (the same engine the BDE / manager / executive dashboards use),
 * so nothing is manually maintained and numbers never drift. Visibility is scoped
 * with resolveTeamOwnerIds: BDE = self, Manager/Team Lead = team, Admin = all.
 */

const VALID_TYPES = targetService.VALID_TARGET_TYPES as string[];
const VALID_PERIOD_TYPES = targetService.VALID_PERIOD_TYPES as string[];

interface LiveTarget {
  id: number;
  ownerId: number;
  ownerName: string;
  teamId: number | null;
  teamName: string | null;
  name: string | null;
  description: string | null;
  type: string;
  periodType: string;
  period: string;
  startDate: string;
  endDate: string;
  targetAmount: number;
  achieved: number;
  remaining: number;
  achievementPct: number;
  status: TargetStatus;
  incentiveEarned: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Compute the live metrics (actual / pct / incentive / status / window) for a target row. */
async function liveMetricsFor(
  t: { ownerId: number; type: string; period: string; periodType: string; targetAmount: number },
  now: Date,
) {
  const win = targetService.periodWindow(t.period, t.periodType as PeriodType);
  const achieved = await targetService.computeActual(t.ownerId, t.type as TargetType, win);
  // Derive status from the UNROUNDED ratio so a 99.5% target never reads
  // "Achieved". Round for DISPLAY/incentive, but never round UP across a status
  // boundary the raw value hasn't actually crossed — so the displayed %, its
  // colour, the incentive and the status badge stay mutually consistent (99.5%
  // shows 99% + In Progress, not 100% + green; 109.5% shows 109% + Achieved, not
  // 110% + Exceeded).
  const rawPct = t.targetAmount > 0 ? (achieved / t.targetAmount) * 100 : 0;
  let achievementPct = Math.round(rawPct);
  if (achievementPct >= 100 && rawPct < 100) achievementPct = 99;
  if (achievementPct >= targetService.EXCEEDED_PCT && rawPct < targetService.EXCEEDED_PCT) {
    achievementPct = targetService.EXCEEDED_PCT - 1;
  }
  const incentive = await targetService.computeIncentive(t.ownerId, achievementPct, t.targetAmount);
  const status = targetService.computeStatus(rawPct, win, now);
  return {
    win,
    achieved,
    achievementPct,
    remaining: Math.max(0, t.targetAmount - achieved),
    incentiveEarned: incentive.incentiveEarned,
    status,
  };
}

/** Build a userId → team map (live membership; archived teams excluded). */
async function teamMapFor(ownerIds: number[]): Promise<Map<number, { id: number; name: string }>> {
  const map = new Map<number, { id: number; name: string }>();
  if (ownerIds.length === 0) return map;
  const memberships = await prisma.salesTeamMember.findMany({
    where: { userId: { in: ownerIds } },
    select: { userId: true, team: { select: { id: true, name: true, archived: true } } },
  });
  for (const m of memberships) {
    if (m.team && !m.team.archived) map.set(m.userId, { id: m.team.id, name: m.team.name });
  }
  return map;
}

/**
 * GET /sales/targets — list targets in the caller's scope with live achievement,
 * status and incentive, plus summary cards and a per-team rollup. Filters:
 * period, periodType, type, ownerId, status, search.
 */
export const listTargets = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
    const { period, periodType, type, ownerId, status, search } = req.query;

    const where: any = {};
    if (ownerIds !== null) where.ownerId = { in: ownerIds.length ? ownerIds : [ctx.userId] };
    if (ownerId && !isNaN(Number(ownerId))) {
      const uid = Number(ownerId);
      if (ownerIds === null || ownerIds.includes(uid)) where.ownerId = uid;
    }
    if (typeof period === 'string' && period.trim()) where.period = period.trim();
    if (typeof periodType === 'string' && VALID_PERIOD_TYPES.includes(periodType)) where.periodType = periodType;
    if (typeof type === 'string' && VALID_TYPES.includes(type)) where.type = type;

    const rows = await prisma.salesTarget.findMany({
      where,
      orderBy: [{ period: 'desc' }, { type: 'asc' }],
    });

    // Owner names + live team membership.
    const distinctOwners = [...new Set(rows.map((r) => r.ownerId))];
    const owners = distinctOwners.length
      ? await prisma.users.findMany({ where: { id: { in: distinctOwners } }, select: { id: true, name: true } })
      : [];
    const ownerName = new Map(owners.map((o) => [o.id, o.name]));
    const teamMap = await teamMapFor(distinctOwners);

    const now = new Date();
    let targets: LiveTarget[] = [];
    for (const t of rows) {
      const m = await liveMetricsFor(t, now);
      const team = teamMap.get(t.ownerId) ?? null;
      targets.push({
        id: t.id,
        ownerId: t.ownerId,
        ownerName: ownerName.get(t.ownerId) ?? `User #${t.ownerId}`,
        teamId: team?.id ?? null,
        teamName: team?.name ?? null,
        name: t.name ?? null,
        description: t.description ?? null,
        type: t.type,
        periodType: t.periodType,
        period: t.period,
        startDate: m.win.start.toISOString(),
        endDate: m.win.end.toISOString(),
        targetAmount: t.targetAmount,
        achieved: m.achieved,
        remaining: m.remaining,
        achievementPct: m.achievementPct,
        status: m.status,
        incentiveEarned: m.incentiveEarned,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }

    // Post-compute filters (status + search) over the live rows.
    if (typeof status === 'string' && status.trim()) {
      targets = targets.filter((t) => t.status === status);
    }
    if (typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      targets = targets.filter(
        (t) => (t.name || '').toLowerCase().includes(q) || t.ownerName.toLowerCase().includes(q),
      );
    }

    // Summary cards. Money totals are over REVENUE targets (the only money metric);
    // counts span every target type.
    const revenueTargets = targets.filter((t) => t.type === 'revenue');
    const totalTargetValue = revenueTargets.reduce((s, t) => s + t.targetAmount, 0);
    const totalAchievedRevenue = revenueTargets.reduce((s, t) => s + t.achieved, 0);
    const summary = {
      totalTargets: targets.length,
      activeTargets: targets.filter((t) => t.status === 'in_progress' || t.status === 'not_started').length,
      achievedTargets: targets.filter((t) => t.status === 'achieved' || t.status === 'exceeded').length,
      missedTargets: targets.filter((t) => t.status === 'missed' || t.status === 'expired').length,
      totalTargetValue,
      totalAchievedRevenue,
      overallAchievementPct: totalTargetValue > 0 ? Math.round((totalAchievedRevenue / totalTargetValue) * 100) : 0,
    };

    // Per-team rollup (revenue targets only — combined target vs combined achieved).
    const teamAgg = new Map<number, { teamId: number; teamName: string; members: Set<number>; target: number; achieved: number }>();
    for (const t of revenueTargets) {
      if (t.teamId == null || t.teamName == null) continue;
      const row = teamAgg.get(t.teamId) ?? { teamId: t.teamId, teamName: t.teamName, members: new Set<number>(), target: 0, achieved: 0 };
      row.members.add(t.ownerId);
      row.target += t.targetAmount;
      row.achieved += t.achieved;
      teamAgg.set(t.teamId, row);
    }
    const teams = [...teamAgg.values()]
      .map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        memberCount: r.members.size,
        targetValue: r.target,
        achievedValue: r.achieved,
        achievementPct: r.target > 0 ? Math.round((r.achieved / r.target) * 100) : 0,
      }))
      .sort((a, b) => b.achievementPct - a.achievementPct);

    // Top performers — AGGREGATED per owner (an owner may hold several revenue
    // targets), so each BDE appears at most once. Combined achieved / target.
    const ownerAgg = new Map<number, { ownerId: number; ownerName: string; achieved: number; targetAmount: number }>();
    for (const t of revenueTargets) {
      const row = ownerAgg.get(t.ownerId) ?? { ownerId: t.ownerId, ownerName: t.ownerName, achieved: 0, targetAmount: 0 };
      row.achieved += t.achieved;
      row.targetAmount += t.targetAmount;
      ownerAgg.set(t.ownerId, row);
    }
    const topPerformers = [...ownerAgg.values()]
      .map((o) => ({
        ownerId: o.ownerId,
        ownerName: o.ownerName,
        achieved: o.achieved,
        targetAmount: o.targetAmount,
        achievementPct: o.targetAmount > 0 ? Math.round((o.achieved / o.targetAmount) * 100) : 0,
      }))
      .sort((a, b) => b.achievementPct - a.achievementPct)
      .slice(0, 5);

    res.json({
      canManage: isManager(ctx) || ctx.isAdmin,
      summary,
      teams,
      topPerformers,
      targets,
    });
  } catch (error) {
    console.error('Error listing targets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/targets/:id — full target detail: live metrics + status, the owner,
 * the WON deals contributing to revenue within the period, an achievement
 * timeline, and the owner's other targets. Scope-authorised.
 */
export const getTargetById = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid target id' });

    const t = await prisma.salesTarget.findUnique({ where: { id } });
    if (!t) return res.status(404).json({ error: 'Target not found' });

    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
    if (ownerIds !== null && !ownerIds.includes(t.ownerId)) {
      return res.status(403).json({ error: 'You cannot view this target.' });
    }

    const now = new Date();
    const m = await liveMetricsFor(t, now);
    const [owner] = await Promise.all([
      prisma.users.findUnique({ where: { id: t.ownerId }, select: { id: true, name: true, email: true } }),
    ]);
    const teamMap = await teamMapFor([t.ownerId]);
    const team = teamMap.get(t.ownerId) ?? null;

    // Contributing WON deals within the window (same predicate as computeActual
    // revenue / deal_count) — empty for activity-metric targets.
    let contributingDeals: { id: number; title: string; amount: number; closedAt: string | null; stage: string; customer: string | null }[] = [];
    if (t.type === 'revenue' || t.type === 'deal_count') {
      const deals = await prisma.deal.findMany({
        where: { ownerId: t.ownerId, status: 'won', closedAt: { gte: m.win.start, lt: m.win.end } },
        select: { id: true, title: true, amount: true, closedAt: true, stage: true, customer: { select: { name: true } } },
        orderBy: [{ closedAt: 'asc' }],
      });
      contributingDeals = deals.map((d) => ({
        id: d.id,
        title: d.title,
        amount: d.amount || 0,
        closedAt: d.closedAt ? d.closedAt.toISOString() : null,
        stage: d.stage,
        customer: d.customer?.name ?? null,
      }));
    }

    // Achievement timeline: target created/updated + each contributing won deal.
    const timeline: { type: string; label: string; date: string; amount?: number }[] = [];
    timeline.push({ type: 'created', label: 'Target created', date: t.createdAt.toISOString() });
    if (t.updatedAt.getTime() !== t.createdAt.getTime()) {
      timeline.push({ type: 'updated', label: 'Target updated', date: t.updatedAt.toISOString() });
    }
    let cumulative = 0;
    const trend: { date: string; cumulative: number }[] = [];
    for (const d of contributingDeals) {
      cumulative += d.amount;
      if (d.closedAt) {
        timeline.push({ type: 'deal_won', label: `Deal won: ${d.title}${d.customer ? ` (${d.customer})` : ''}`, date: d.closedAt, amount: d.amount });
        trend.push({ date: d.closedAt, cumulative });
      }
    }
    timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Owner's other targets (for the "Target History" panel on the detail page).
    const otherRows = await prisma.salesTarget.findMany({
      where: { ownerId: t.ownerId, id: { not: t.id } },
      orderBy: [{ period: 'desc' }],
      take: 12,
    });
    const ownerHistory = [];
    for (const r of otherRows) {
      const rm = await liveMetricsFor(r, now);
      ownerHistory.push({
        id: r.id,
        type: r.type,
        periodType: r.periodType,
        period: r.period,
        targetAmount: r.targetAmount,
        achieved: rm.achieved,
        achievementPct: rm.achievementPct,
        status: rm.status,
      });
    }

    res.json({
      id: t.id,
      ownerId: t.ownerId,
      ownerName: owner?.name ?? `User #${t.ownerId}`,
      ownerEmail: owner?.email ?? null,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      name: t.name ?? null,
      description: t.description ?? null,
      type: t.type,
      periodType: t.periodType,
      period: t.period,
      startDate: m.win.start.toISOString(),
      endDate: m.win.end.toISOString(),
      targetAmount: t.targetAmount,
      achieved: m.achieved,
      remaining: m.remaining,
      achievementPct: m.achievementPct,
      status: m.status,
      incentiveEarned: m.incentiveEarned,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      contributingDeals,
      timeline,
      trend,
      ownerHistory,
      note: 'Achievement, incentive and status are computed live from won deals and may change as deals close or revert.',
    });
  } catch (error) {
    console.error('Error fetching target detail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/targets/:id — remove a target (manager/admin, in scope). */
export const deleteTarget = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid target id' });

    const t = await prisma.salesTarget.findUnique({ where: { id } });
    if (!t) return res.status(404).json({ error: 'Target not found' });

    // In-scope only (admins null = all; teamed manager/lead = team).
    const ownerIds = await resolveTeamOwnerIds(ctx);
    if (ownerIds !== null && !ownerIds.includes(t.ownerId)) {
      return res.status(403).json({ error: 'You cannot delete this target.' });
    }

    await prisma.salesTarget.delete({ where: { id } });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'A manager';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'target_deleted',
      description: `${actorName} deleted the ${t.type} target for ${t.period} (owner #${t.ownerId}).`,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
