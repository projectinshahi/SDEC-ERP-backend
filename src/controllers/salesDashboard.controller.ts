import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, resolveReportScope } from '../utils/salesAuth.js';

/**
 * Sales Command Center analytics — a single consolidated payload powering the
 * premium sales dashboard: overview KPIs, period-over-period trends, revenue
 * forecast, conversion funnel and smart insights.
 */

const DAY = 24 * 60 * 60 * 1000;
const INACTIVE_STATUSES = ['converted', 'disqualified', 'won', 'lost', 'closed'];
// Statuses that take a lead OFF the pipeline board: it left the pipeline via an
// action — converted (→ Deal) or disqualified. Mirrors the Leads Pipeline board's
// OFF_BOARD_STATUSES so the funnel counts exactly what the board renders. Unlike
// INACTIVE_STATUSES, won/lost/closed are NOT off-board — those come only from a
// drag into a terminal column and stay visible in that column.
const OFF_BOARD_STATUSES = ['converted', 'disqualified'];

// Stage → win-probability used to weight the revenue forecast.
const STAGE_PROBABILITY: Record<string, number> = {
  'Proposal Sent': 0.2,
  'Demo Done': 0.4,
  'Contract Review': 0.6,
  'Negotiation': 0.8,
  'Closed Won': 1,
  'Closed Lost': 0,
};

const pct = (curr: number, prev: number): number => {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
};

export const getSalesDashboard = async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    const last30 = new Date(now - 30 * DAY);
    const prev30 = new Date(now - 60 * DAY);
    const sevenDaysAgo = new Date(now - 7 * DAY);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));

    // RBAC data scoping: BDE = own, manager = team, Admin/Director = org-wide.
    // `owner` spreads an ownerId constraint into every lead/deal/follow-up query
    // (empty for org-wide so nothing changes for Admin/Director).
    const ctx = await getSalesAuth(req);
    const owners = await resolveReportScope(ctx); // null = org-wide
    const owner: { ownerId?: { in: number[] } } =
      owners !== null ? { ownerId: { in: owners.length ? owners : [ctx.userId] } } : {};

    const [
      leadStatusGroups,
      leadStageGroups,
      deals,
      followUpGroups,
      leadsLast30, leadsPrev30,
      convertedLast30, convertedPrev30,
      followUpsDueToday,
      staleLeads,
      highScoreUncontacted,
      pipelineStages,
      stageOnBoardGroups,
    ] = await Promise.all([
      prisma.lead.groupBy({ by: ['status'], where: { ...owner }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['stage'], where: { ...owner }, _count: { _all: true } }),
      prisma.deal.findMany({ where: { ...owner }, select: { amount: true, stage: true, status: true } }),
      prisma.followUp.groupBy({ by: ['status'], where: { ...owner }, _count: { _all: true } }),
      prisma.lead.count({ where: { ...owner, createdAt: { gte: last30 } } }),
      prisma.lead.count({ where: { ...owner, createdAt: { gte: prev30, lt: last30 } } }),
      prisma.lead.count({ where: { ...owner, status: 'converted', updatedAt: { gte: last30 } } }),
      prisma.lead.count({ where: { ...owner, status: 'converted', updatedAt: { gte: prev30, lt: last30 } } }),
      prisma.followUp.count({ where: { ...owner, status: 'pending', scheduledDate: { gte: todayStart, lte: todayEnd } } }),
      prisma.lead.count({ where: { ...owner, status: { notIn: INACTIVE_STATUSES }, interactions: { none: {} }, createdAt: { lt: sevenDaysAgo } } }),
      prisma.lead.count({ where: { ...owner, status: { notIn: INACTIVE_STATUSES }, score: { gte: 80 }, interactions: { none: {} } } }),
      // The live pipeline columns (single source of truth for the funnel) + the
      // per-stage counts of leads currently ON the board, i.e. every lead except
      // those taken off-board by an action (converted/disqualified) — mirroring
      // the Leads Pipeline view's OFF_BOARD_STATUSES filter exactly.
      prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' }, select: { name: true } }),
      prisma.lead.groupBy({ by: ['stage'], where: { ...owner, status: { notIn: OFF_BOARD_STATUSES } }, _count: { _all: true } }),
    ]);

    const statusCount = (s: string) =>
      leadStatusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const totalLeads = leadStatusGroups.reduce((sum, g) => sum + g._count._all, 0);
    const convertedLeads = statusCount('converted');

    // "Qualified" = every lead that has progressed BEYOND the first funnel stage
    // NQL (Not-Qualified Lead), i.e. Total Leads − leads still in NQL. Stage-name
    // agnostic beyond identifying the entry stage, so later/renamed pipeline stages
    // are automatically counted as Qualified with no code change. Derived from the
    // live, RBAC-scoped stage groupBy (no hardcoded later-stage list, no cached values).
    const stageCount = (s: string) => leadStageGroups.find((g) => g.stage === s)?._count._all ?? 0;
    const newStageLeads = leadStageGroups
      .filter((g) => String(g.stage ?? '').trim().toLowerCase() === 'nql')
      .reduce((sum, g) => sum + g._count._all, 0);
    const qualifiedLeads = Math.max(0, totalLeads - newStageLeads);

    // Deal roll-ups.
    const isWon = (d: { stage: string; status: string }) => d.stage === 'Closed Won' || d.status === 'won';
    const isLost = (d: { stage: string; status: string }) => d.stage === 'Closed Lost' || d.status === 'lost';
    const openDeals = deals.filter((d) => !isWon(d) && !isLost(d));
    const wonDeals = deals.filter(isWon);
    const lostDeals = deals.filter(isLost);
    const pipelineValue = openDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
    const wonValue = wonDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
    const forecast = deals
      .filter((d) => !isLost(d))
      .reduce((sum, d) => sum + (d.amount || 0) * (STAGE_PROBABILITY[d.stage] ?? 0.1), 0);

    // Follow-up completion.
    const fuCount = (s: string) => followUpGroups.find((g) => g.status === s)?._count._all ?? 0;
    const totalFollowUps = followUpGroups.reduce((sum, g) => sum + g._count._all, 0);
    const completedFollowUps = fuCount('completed');
    const followUpCompletion = totalFollowUps > 0 ? Math.round((completedFollowUps / totalFollowUps) * 1000) / 10 : 0;

    // Conversion funnel — the SINGLE SOURCE OF TRUTH is the live Leads Pipeline:
    // one entry per DB-managed pipeline stage (LeadStage, in board order) with the
    // exact count of leads the board renders in that column. Mirrors the Leads
    // Pipeline view's leadsByStage 1:1 — the SAME dynamic stages (custom / renamed
    // / added / removed flow through with no code change), the SAME off-board
    // filter (only converted/disqualified are excluded, so won/lost/closed leads
    // dragged into a terminal column are counted there), and unknown-stage leads
    // folded into the first column — so the funnel can never drift from the board.
    const onBoardStageCount = (s: string) =>
      stageOnBoardGroups.find((g) => g.stage === s)?._count._all ?? 0;
    const knownStageNames = new Set(pipelineStages.map((s) => s.name));
    const orphanOnBoard = stageOnBoardGroups
      .filter((g) => !knownStageNames.has(g.stage))
      .reduce((sum, g) => sum + g._count._all, 0);
    const funnel = pipelineStages.map((s, i) => ({
      label: s.name,
      count: onBoardStageCount(s.name) + (i === 0 ? orphanOnBoard : 0),
    }));

    // Smart insights.
    const insights: { type: string; severity: 'info' | 'warning' | 'success' | 'danger'; message: string }[] = [];
    if (followUpsDueToday > 0)
      insights.push({ type: 'follow_up', severity: 'info', message: `${followUpsDueToday} lead${followUpsDueToday === 1 ? '' : 's'} require follow-up today.` });
    if (staleLeads > 0)
      insights.push({ type: 'stale', severity: 'warning', message: `${staleLeads} lead${staleLeads === 1 ? '' : 's'} are at risk of becoming stale.` });
    if (highScoreUncontacted > 0)
      insights.push({ type: 'high_score', severity: 'danger', message: `${highScoreUncontacted} high-score lead${highScoreUncontacted === 1 ? '' : 's'} have not been contacted.` });
    const revenueGrowth = pct(convertedLast30, convertedPrev30);
    if (revenueGrowth !== 0)
      insights.push({
        type: 'revenue',
        severity: revenueGrowth >= 0 ? 'success' : 'warning',
        message: `Conversions ${revenueGrowth >= 0 ? 'increased' : 'decreased'} by ${Math.abs(revenueGrowth)}% in the last 30 days.`,
      });
    if (insights.length === 0)
      insights.push({ type: 'all_clear', severity: 'success', message: 'All caught up — no urgent actions right now.' });

    res.json({
      leads: {
        total: totalLeads,
        new: statusCount('new') || stageCount('New'),
        qualified: qualifiedLeads,
        converted: convertedLeads,
        disqualified: statusCount('disqualified'),
        growthPct: pct(leadsLast30, leadsPrev30),
      },
      deals: {
        open: openDeals.length,
        won: wonDeals.length,
        lost: lostDeals.length,
        total: deals.length,
      },
      revenue: {
        pipelineValue,
        forecast: Math.round(forecast),
        wonValue,
        growthPct: revenueGrowth,
      },
      conversion: {
        rate: totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 1000) / 10 : 0,
        growthPct: pct(convertedLast30, convertedPrev30),
      },
      followUp: { completionRate: followUpCompletion, dueToday: followUpsDueToday },
      funnel,
      insights,
    });
  } catch (error) {
    console.error('Error building sales dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/analytics/manager — team performance + leaderboard for the
 * Manager Workspace: per-BDE leads, conversions, conversion rate, meetings,
 * revenue generated.
 */
export const getManagerWorkspace = async (req: Request, res: Response) => {
  try {
    // RBAC scoping: Admin/Director = org, Manager = their team, BDE = self.
    const ctx = await getSalesAuth(req);
    const owners = await resolveReportScope(ctx); // null = org-wide
    const scopedIds = owners !== null ? (owners.length ? owners : [ctx.userId]) : null;
    const ownerWhere = scopedIds ? { ownerId: { in: scopedIds } } : {};

    const [leadGroups, convertedGroups, dealOwners, meetingGroups, users] = await Promise.all([
      prisma.lead.groupBy({ by: ['ownerId'], where: { ...ownerWhere }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['ownerId'], where: { ...ownerWhere, status: 'converted' }, _count: { _all: true } }),
      prisma.deal.findMany({ where: { ...ownerWhere }, select: { ownerId: true, amount: true, stage: true, status: true } }),
      prisma.leadInteraction.groupBy({
        by: ['authorId'],
        where: scopedIds ? { type: 'Meeting', authorId: { in: scopedIds } } : { type: 'Meeting' },
        _count: { _all: true },
      }),
      prisma.users.findMany({
        where: scopedIds ? { status: 'active', id: { in: scopedIds } } : { status: 'active' },
        select: { id: true, name: true, role: true },
      }),
    ]);

    const leadCount = (id: number) => leadGroups.find((g) => g.ownerId === id)?._count._all ?? 0;
    const convertedCount = (id: number) => convertedGroups.find((g) => g.ownerId === id)?._count._all ?? 0;
    const meetingCount = (id: number) => meetingGroups.find((g) => g.authorId === id)?._count._all ?? 0;
    const revenue = (id: number) =>
      dealOwners
        .filter((d) => d.ownerId === id && (d.stage === 'Closed Won' || d.status === 'won'))
        .reduce((sum, d) => sum + (d.amount || 0), 0);

    // Only include users who own at least one lead/deal.
    const ownerIds = new Set<number>([...leadGroups.map((g) => g.ownerId), ...dealOwners.map((d) => d.ownerId)]);

    const team = users
      .filter((u) => ownerIds.has(u.id))
      .map((u) => {
        const leads = leadCount(u.id);
        const converted = convertedCount(u.id);
        return {
          ownerId: u.id,
          name: u.name,
          role: u.role || 'Sales',
          leadsAssigned: leads,
          conversions: converted,
          conversionRate: leads > 0 ? Math.round((converted / leads) * 1000) / 10 : 0,
          meetingsCompleted: meetingCount(u.id),
          revenueGenerated: revenue(u.id),
        };
      });

    const byRevenue = [...team].sort((a, b) => b.revenueGenerated - a.revenueGenerated);
    const byConversion = [...team].sort((a, b) => b.conversionRate - a.conversionRate);

    res.json({
      team: byRevenue,
      leaderboard: {
        topRevenue: byRevenue.slice(0, 5),
        topConversion: byConversion.slice(0, 5),
      },
    });
  } catch (error) {
    console.error('Error building manager workspace:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
