import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, resolveTeamOwnerIds, isManager, canViewOrgReports } from '../utils/salesAuth.js';
import { targetService } from '../services/target.service.js';

/**
 * Manager + Executive performance dashboards. Both reuse the target engine
 * (target.service) and the existing sales tables — no isolated reporting store.
 * Manager scope is team-bound (resolveTeamOwnerIds); the executive view rolls up
 * all teams company-wide.
 */

function currentMonth(): { period: string; start: Date; end: Date; startOfToday: Date } {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const { start, end } = targetService.periodWindow(period, 'monthly');
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { period, start, end, startOfToday };
}

/**
 * GET /sales/analytics/manager-dashboard — SE-028/SE-041/SE-042 team view: per
 * member revenue attainment, task completion %, won deals and incentive
 * run-rate, plus team KPI rollup and top/bottom performers.
 */
export const getManagerDashboard = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const ownerIds = await resolveTeamOwnerIds(ctx);

    let memberIds: number[];
    if (ownerIds === null) {
      const all = await prisma.users.findMany({ where: { status: 'active' }, select: { id: true } });
      memberIds = all.map((u) => u.id);
    } else {
      memberIds = ownerIds;
    }

    const { period, start, end, startOfToday } = currentMonth();
    const users = await prisma.users.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, email: true },
    });

    const members: any[] = [];
    let teamTarget = 0, teamAchieved = 0, teamTasks = 0, teamCompleted = 0, teamOverdue = 0, teamIncentive = 0;

    for (const u of users) {
      const target = await prisma.salesTarget.findFirst({ where: { ownerId: u.id, period, periodType: 'monthly', type: 'revenue' } });
      const targetAmount = target?.targetAmount ?? 0;
      const achieved = await targetService.computeActual(u.id, 'revenue', { start, end });
      const achievementPct = targetAmount > 0 ? Math.round((achieved / targetAmount) * 100) : 0;
      const incentive = await targetService.computeIncentive(u.id, achievementPct, targetAmount);

      const [totalTasks, completedTasks, overdueTasks, wonDeals] = await Promise.all([
        prisma.salesTask.count({ where: { assigneeId: u.id } }),
        prisma.salesTask.count({ where: { assigneeId: u.id, status: 'completed' } }),
        prisma.salesTask.count({ where: { assigneeId: u.id, status: { not: 'completed' }, dueDate: { lt: startOfToday } } }),
        prisma.deal.count({ where: { ownerId: u.id, status: 'won', closedAt: { gte: start, lt: end } } }),
      ]);
      const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      teamTarget += targetAmount;
      teamAchieved += achieved;
      teamTasks += totalTasks;
      teamCompleted += completedTasks;
      teamOverdue += overdueTasks;
      teamIncentive += incentive.incentiveEarned;

      members.push({
        userId: u.id, name: u.name, email: u.email,
        target: targetAmount, achieved, achievementPct, incentiveEarned: incentive.incentiveEarned,
        totalTasks, completedTasks, completionRate, overdueTasks, wonDeals,
      });
    }

    members.sort((a, b) => b.achievementPct - a.achievementPct);
    const ranked = members.filter((m) => m.target > 0);

    res.json({
      period,
      kpis: {
        memberCount: members.length,
        target: teamTarget,
        achieved: teamAchieved,
        attainmentPct: teamTarget > 0 ? Math.round((teamAchieved / teamTarget) * 100) : 0,
        totalTasks: teamTasks,
        completedTasks: teamCompleted,
        taskCompletionRate: teamTasks > 0 ? Math.round((teamCompleted / teamTasks) * 100) : 0,
        overdueTasks: teamOverdue,
        incentiveRunRate: teamIncentive,
      },
      members,
      topPerformers: ranked.slice(0, 3),
      bottomPerformers: ranked.slice(-3).reverse(),
    });
  } catch (error) {
    console.error('Error building manager dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/analytics/executive-dashboard — company-wide rollup: revenue,
 * pipeline + weighted forecast, company target attainment and a team-vs-team
 * leaderboard with top/bottom teams.
 */
export const getExecutiveDashboard = async (req: Request, res: Response) => {
  try {
    // Company-wide financials are leadership-only: restrict to managers/admins
    // (route-level sales.view also lets BDEs/Viewers in, so guard in-handler too).
    const ctx = await getSalesAuth(req);
    // Managers + admins (existing) plus Directors / org-report holders.
    if (!isManager(ctx) && !canViewOrgReports(ctx)) {
      return res.status(403).json({ error: 'Forbidden: executive analytics are restricted to managers, directors and admins.' });
    }

    const { period, start, end } = currentMonth();

    const [teams, allDeals] = await Promise.all([
      prisma.salesTeam.findMany({
        where: { archived: false },
        include: { members: { select: { userId: true } }, manager: { select: { id: true, name: true } } },
      }),
      prisma.deal.findMany({ select: { status: true, amount: true, probability: true, closedAt: true } }),
    ]);

    const wonThisMonth = allDeals
      .filter((d) => d.status === 'won' && d.closedAt && d.closedAt >= start && d.closedAt < end)
      .reduce((s, d) => s + (d.amount || 0), 0);
    const openDeals = allDeals.filter((d) => d.status === 'open');
    const pipelineValue = openDeals.reduce((s, d) => s + (d.amount || 0), 0);
    const forecast = openDeals.reduce((s, d) => s + Math.round(((d.amount || 0) * (d.probability || 0)) / 100), 0);

    const teamRows: any[] = [];
    let companyTarget = 0, companyAchieved = 0;
    for (const t of teams) {
      const memberIds = t.members.map((m) => m.userId);
      let teamTarget = 0, teamAchieved = 0;
      for (const uid of memberIds) {
        const target = await prisma.salesTarget.findFirst({ where: { ownerId: uid, period, periodType: 'monthly', type: 'revenue' } });
        teamTarget += target?.targetAmount ?? 0;
        teamAchieved += await targetService.computeActual(uid, 'revenue', { start, end });
      }
      companyTarget += teamTarget;
      companyAchieved += teamAchieved;
      teamRows.push({
        teamId: t.id,
        name: t.name,
        manager: t.manager?.name ?? null,
        memberCount: memberIds.length,
        target: teamTarget,
        achieved: teamAchieved,
        attainmentPct: teamTarget > 0 ? Math.round((teamAchieved / teamTarget) * 100) : 0,
      });
    }
    teamRows.sort((a, b) => b.attainmentPct - a.attainmentPct);

    res.json({
      period,
      revenue: { wonThisMonth, pipelineValue, forecast },
      target: {
        target: companyTarget,
        achieved: companyAchieved,
        attainmentPct: companyTarget > 0 ? Math.round((companyAchieved / companyTarget) * 100) : 0,
      },
      teams: teamRows,
      topTeams: teamRows.filter((t) => t.target > 0).slice(0, 3),
      bottomTeams: teamRows.filter((t) => t.target > 0).slice(-3).reverse(),
    });
  } catch (error) {
    console.error('Error building executive dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
