import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * Sales Command Center analytics — a single consolidated payload powering the
 * premium sales dashboard: overview KPIs, period-over-period trends, revenue
 * forecast, conversion funnel and smart insights.
 */

const DAY = 24 * 60 * 60 * 1000;
const INACTIVE_STATUSES = ['converted', 'disqualified', 'won', 'lost', 'closed'];

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

export const getSalesDashboard = async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    const last30 = new Date(now - 30 * DAY);
    const prev30 = new Date(now - 60 * DAY);
    const sevenDaysAgo = new Date(now - 7 * DAY);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));

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
    ] = await Promise.all([
      prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } }),
      prisma.deal.findMany({ select: { amount: true, stage: true, status: true } }),
      prisma.followUp.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.lead.count({ where: { createdAt: { gte: last30 } } }),
      prisma.lead.count({ where: { createdAt: { gte: prev30, lt: last30 } } }),
      prisma.lead.count({ where: { status: 'converted', updatedAt: { gte: last30 } } }),
      prisma.lead.count({ where: { status: 'converted', updatedAt: { gte: prev30, lt: last30 } } }),
      prisma.followUp.count({ where: { status: 'pending', scheduledDate: { gte: todayStart, lte: todayEnd } } }),
      prisma.lead.count({ where: { status: { notIn: INACTIVE_STATUSES }, interactions: { none: {} }, createdAt: { lt: sevenDaysAgo } } }),
      prisma.lead.count({ where: { status: { notIn: INACTIVE_STATUSES }, score: { gte: 80 }, interactions: { none: {} } } }),
    ]);

    const statusCount = (s: string) =>
      leadStatusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const totalLeads = leadStatusGroups.reduce((sum, g) => sum + g._count._all, 0);
    const convertedLeads = statusCount('converted');

    // "Qualified" = engaged stages, still active.
    const stageCount = (s: string) => leadStageGroups.find((g) => g.stage === s)?._count._all ?? 0;
    const qualifiedLeads = stageCount('Interested') + stageCount('Negotiating');

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

    // Conversion funnel (lead progression → conversion).
    const funnel = [
      { label: 'New', count: stageCount('New') },
      { label: 'Contacted', count: stageCount('Contacted') },
      { label: 'Interested', count: stageCount('Interested') },
      { label: 'Negotiating', count: stageCount('Negotiating') },
      { label: 'Converted', count: convertedLeads },
    ];

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
export const getManagerWorkspace = async (_req: Request, res: Response) => {
  try {
    const [leadGroups, convertedGroups, dealOwners, meetingGroups, users] = await Promise.all([
      prisma.lead.groupBy({ by: ['ownerId'], _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['ownerId'], where: { status: 'converted' }, _count: { _all: true } }),
      prisma.deal.findMany({ select: { ownerId: true, amount: true, stage: true, status: true } }),
      prisma.leadInteraction.groupBy({ by: ['authorId'], where: { type: 'Meeting' }, _count: { _all: true } }),
      prisma.users.findMany({ where: { status: 'active' }, select: { id: true, name: true, role: true } }),
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
