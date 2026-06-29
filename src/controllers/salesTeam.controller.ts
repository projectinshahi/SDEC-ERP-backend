import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { getSalesAuth } from '../utils/salesAuth.js';

/**
 * SE-044.1 — Team Creation & Membership. Managers create/edit/archive teams and
 * add/remove members (BDEs / Team Leads). Each team has a manager (the reporting
 * manager for its members). Archive (soft delete) preserves historical targets/
 * reporting. Route-gated by sales.team.manage; admins manage all teams, managers
 * their own.
 */

const VALID_MEMBER_ROLES = ['bde', 'team_lead'];

const teamInclude = {
  manager: { select: { id: true, name: true, email: true } },
  members: {
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
    orderBy: { joinedAt: 'asc' as const },
  },
} as const;

/** GET /sales/teams — admins see all; managers see teams they own. */
export const getTeams = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const includeArchived = req.query.includeArchived === 'true';

    const where: any = {};
    if (!includeArchived) where.archived = false;
    if (!ctx.isAdmin) where.managerId = ctx.userId;

    const teams = await prisma.salesTeam.findMany({
      where,
      include: teamInclude,
      orderBy: [{ archived: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /sales/teams/:id — a single team with members. */
export const getTeamById = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const team = await prisma.salesTeam.findUnique({ where: { id }, include: teamInclude });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!ctx.isAdmin && team.managerId !== ctx.userId) {
      return res.status(403).json({ error: 'You can only view teams you manage.' });
    }
    res.json(team);
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/teams — create a team (manager defaults to the creator). */
export const createTeam = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const body = req.body ?? {};

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'A team name is required.' });

    let managerId = ctx.userId;
    if (body.managerId != null && !isNaN(Number(body.managerId)) && Number(body.managerId) !== ctx.userId) {
      // Only admins can assign a different manager as owner.
      if (!ctx.isAdmin) return res.status(403).json({ error: 'Only admins can assign another manager.' });
      managerId = Number(body.managerId);
      if (!(await prisma.users.findUnique({ where: { id: managerId }, select: { id: true } }))) {
        return res.status(400).json({ error: 'Manager does not exist.' });
      }
    }

    const team = await prisma.salesTeam.create({
      data: { name, description: typeof body.description === 'string' ? body.description : null, managerId, createdById: ctx.userId },
      include: teamInclude,
    });

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'team_created',
      description: `Created sales team "${team.name}".`,
    });
    res.status(201).json(team);
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** Ownership guard: admin or the team's manager. */
async function loadOwnedTeam(id: number, ctx: { userId: number; isAdmin: boolean }) {
  const team = await prisma.salesTeam.findUnique({ where: { id } });
  if (!team) return { ok: false as const, status: 404, message: 'Team not found' };
  if (!ctx.isAdmin && team.managerId !== ctx.userId) {
    return { ok: false as const, status: 403, message: 'You can only manage teams you manage.' };
  }
  return { ok: true as const, team };
}

/** PUT /sales/teams/:id — edit name/description/manager/archived. */
export const updateTeam = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const loaded = await loadOwnedTeam(id, ctx);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.message });

    const body = req.body ?? {};
    const data: Record<string, any> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (body.description !== undefined) data.description = body.description ? String(body.description) : null;
    if (typeof body.archived === 'boolean') data.archived = body.archived;
    if (body.managerId != null && !isNaN(Number(body.managerId)) && Number(body.managerId) !== loaded.team.managerId) {
      if (!ctx.isAdmin) return res.status(403).json({ error: 'Only admins can change the team manager.' });
      const mid = Number(body.managerId);
      if (!(await prisma.users.findUnique({ where: { id: mid }, select: { id: true } }))) {
        return res.status(400).json({ error: 'Manager does not exist.' });
      }
      data.managerId = mid;
    }

    const team = await prisma.salesTeam.update({ where: { id }, data, include: teamInclude });
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: data.archived === true ? 'team_archived' : 'team_updated',
      description: `${data.archived === true ? 'Archived' : 'Updated'} sales team "${team.name}".`,
    });
    res.json(team);
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/teams/:id — archive a team (soft delete to preserve history). */
export const archiveTeam = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const loaded = await loadOwnedTeam(id, ctx);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.message });

    const team = await prisma.salesTeam.update({ where: { id }, data: { archived: true }, include: teamInclude });
    await activityService.logActivity({ actorUserId: ctx.userId, type: 'team_archived', description: `Archived sales team "${team.name}".` });
    res.json(team);
  } catch (error) {
    console.error('Error archiving team:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /sales/teams/:id — permanently delete a team (hard delete).
 *
 * Guarded by dependency validation: a team that still has members assigned or
 * targets attributed to it cannot be removed — the user must reassign/remove
 * those first, or archive the team instead (returns 409 with a clear message).
 * Route-gated by sales.teams.delete (or sales.team.manage) + team ownership.
 */
export const deleteTeam = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const loaded = await loadOwnedTeam(id, ctx);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.message });

    // Dependency validation — never orphan members or active targets.
    const [memberCount, targetCount] = await Promise.all([
      prisma.salesTeamMember.count({ where: { teamId: id } }),
      prisma.salesTarget.count({ where: { teamId: id } }),
    ]);
    const blockers: string[] = [];
    if (memberCount > 0) blockers.push(`${memberCount} assigned member${memberCount === 1 ? '' : 's'}`);
    if (targetCount > 0) blockers.push(`${targetCount} linked target${targetCount === 1 ? '' : 's'}`);
    if (blockers.length > 0) {
      return res.status(409).json({
        error: `This team cannot be deleted because it still has ${blockers.join(' and ')}. Remove or reassign them first, or archive the team instead.`,
      });
    }

    await prisma.salesTeam.delete({ where: { id } });
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'team_deleted',
      description: `Deleted sales team "${loaded.team.name}".`,
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/teams/:id/members — add (or move) a member into the team. */
export const addTeamMember = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const loaded = await loadOwnedTeam(id, ctx);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.message });

    const userId = Number(req.body.userId);
    if (isNaN(userId)) return res.status(400).json({ error: 'A valid userId is required.' });
    const user = await prisma.users.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const role = VALID_MEMBER_ROLES.includes(req.body.role) ? req.body.role : 'bde';

    // A user belongs to one team — upsert moves them if already on another team.
    const member = await prisma.salesTeamMember.upsert({
      where: { userId },
      create: { teamId: id, userId, role },
      update: { teamId: id, role },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });

    await activityService.logActivity({
      actorUserId: ctx.userId,
      targetUserId: userId,
      type: 'team_member_added',
      description: `${user.name} was added to team "${loaded.team.name}" as ${role === 'team_lead' ? 'Team Lead' : 'BDE'}.`,
    });
    if (userId !== ctx.userId) {
      await notificationService.createNotification({
        userId,
        type: 'assignment',
        title: 'Added to a sales team',
        message: `You were added to the sales team "${loaded.team.name}".`,
        entityType: 'team',
        entityId: id,
      });
    }

    res.status(201).json(member);
  } catch (error) {
    console.error('Error adding team member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/teams/:id/members/:userId — remove a member. */
export const removeTeamMember = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    if (isNaN(id) || isNaN(userId)) return res.status(400).json({ error: 'Invalid id' });

    const loaded = await loadOwnedTeam(id, ctx);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.message });

    const member = await prisma.salesTeamMember.findUnique({ where: { userId } });
    if (!member || member.teamId !== id) return res.status(404).json({ error: 'Member not found in this team.' });

    await prisma.salesTeamMember.delete({ where: { userId } });

    await activityService.logActivity({
      actorUserId: ctx.userId,
      targetUserId: userId,
      type: 'team_member_removed',
      description: `A member was removed from team "${loaded.team.name}".`,
    });
    if (userId !== ctx.userId) {
      await notificationService.createNotification({
        userId,
        type: 'reassignment',
        title: 'Removed from a sales team',
        message: `You were removed from the sales team "${loaded.team.name}".`,
        entityType: 'team',
        entityId: id,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing team member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-044.2 — Live Team Performance ─────────────────────────────────────────
// Every metric is aggregated ON EACH REQUEST from the live Lead/Deal/FollowUp
// tables — NO stored performance table, no batch job. New teams auto-appear
// because we iterate the current sales_teams rows. To avoid N+1 across teams AND
// the prisma.groupBy tsc-OOM, we collect ALL member user-ids once and run a few
// batched findMany, then group in JS. (Each user belongs to exactly one team.)

const CONVERTED_LEAD_STATUSES = ['converted', 'won'];

interface OwnerMetrics {
  totalLeads: number; convertedLeads: number;
  totalDeals: number; wonDeals: number; lostDeals: number;
  totalDealValue: number; totalRevenue: number;
  totalFollowups: number; completedFollowups: number; pendingFollowups: number; overdueFollowups: number;
}
function emptyOwner(): OwnerMetrics {
  return {
    totalLeads: 0, convertedLeads: 0, totalDeals: 0, wonDeals: 0, lostDeals: 0,
    totalDealValue: 0, totalRevenue: 0, totalFollowups: 0, completedFollowups: 0,
    pendingFollowups: 0, overdueFollowups: 0,
  };
}
function addInto(a: OwnerMetrics, b: OwnerMetrics) {
  a.totalLeads += b.totalLeads; a.convertedLeads += b.convertedLeads;
  a.totalDeals += b.totalDeals; a.wonDeals += b.wonDeals; a.lostDeals += b.lostDeals;
  a.totalDealValue += b.totalDealValue; a.totalRevenue += b.totalRevenue;
  a.totalFollowups += b.totalFollowups; a.completedFollowups += b.completedFollowups;
  a.pendingFollowups += b.pendingFollowups; a.overdueFollowups += b.overdueFollowups;
}
function conversionRateOf(m: OwnerMetrics): number {
  return m.totalLeads > 0 ? Math.round((m.convertedLeads / m.totalLeads) * 1000) / 10 : 0;
}
/** Presentation score 0–100: conversion 40% + deal win-rate 35% + follow-up
 *  completion 25%, minus up to 15pt overdue penalty. Not a financial figure. */
function performanceScoreOf(m: OwnerMetrics): number {
  const convRate = m.totalLeads > 0 ? m.convertedLeads / m.totalLeads : 0;
  const winRate = (m.wonDeals + m.lostDeals) > 0 ? m.wonDeals / (m.wonDeals + m.lostDeals) : 0;
  const fuRate = m.totalFollowups > 0 ? m.completedFollowups / m.totalFollowups : 0;
  const overduePen = m.totalFollowups > 0 ? m.overdueFollowups / m.totalFollowups : 0;
  return Math.max(0, Math.round(100 * (0.40 * convRate + 0.35 * winRate + 0.25 * fuRate) - 15 * overduePen));
}

/** Three batched reads + JS grouping into per-owner buckets. */
async function aggregateOwnerMetrics(ownerIds: number[]): Promise<{ byOwner: Map<number, OwnerMetrics>; activeSet: Set<number> }> {
  const byOwner = new Map<number, OwnerMetrics>();
  for (const oid of ownerIds) byOwner.set(oid, emptyOwner());
  if (ownerIds.length === 0) return { byOwner, activeSet: new Set() };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [leads, deals, followUps, activeUsers] = await Promise.all([
    prisma.lead.findMany({ where: { ownerId: { in: ownerIds } }, select: { ownerId: true, status: true } }),
    prisma.deal.findMany({ where: { ownerId: { in: ownerIds } }, select: { ownerId: true, status: true, stage: true, amount: true } }),
    prisma.followUp.findMany({ where: { ownerId: { in: ownerIds } }, select: { ownerId: true, status: true, scheduledDate: true } }),
    prisma.users.findMany({ where: { id: { in: ownerIds }, status: 'active' }, select: { id: true } }),
  ]);

  for (const l of leads) {
    const m = byOwner.get(l.ownerId); if (!m) continue;
    m.totalLeads++;
    if (CONVERTED_LEAD_STATUSES.includes(String(l.status || '').toLowerCase())) m.convertedLeads++;
  }
  for (const d of deals) {
    const m = byOwner.get(d.ownerId); if (!m) continue;
    m.totalDeals++;
    const isWon = d.status === 'won' || d.stage === 'Closed Won';
    const isLost = d.status === 'lost' || d.stage === 'Closed Lost';
    if (isWon) { m.wonDeals++; m.totalRevenue += d.amount || 0; }
    else if (isLost) m.lostDeals++;
    m.totalDealValue += d.amount || 0;
  }
  for (const f of followUps) {
    const m = byOwner.get(f.ownerId); if (!m) continue;
    m.totalFollowups++;
    if (String(f.status || '').toLowerCase() === 'completed') m.completedFollowups++;
    else {
      m.pendingFollowups++;
      if (f.scheduledDate && f.scheduledDate < startOfToday) m.overdueFollowups++;
    }
  }
  return { byOwner, activeSet: new Set(activeUsers.map((u) => u.id)) };
}

/** Shapes one team's rolled-up metrics into the card payload. */
function shapeTeamPerf(team: any, agg: OwnerMetrics, activeMembers: number) {
  return {
    teamId: team.id,
    teamName: team.name,
    teamLead: team.manager?.name ?? null,
    totalMembers: team.members?.length ?? 0,
    activeMembers,
    totalLeads: agg.totalLeads,
    convertedLeads: agg.convertedLeads,
    totalDeals: agg.totalDeals,
    wonDeals: agg.wonDeals,
    lostDeals: agg.lostDeals,
    totalDealValue: agg.totalDealValue,
    totalRevenue: agg.totalRevenue,
    totalFollowups: agg.totalFollowups,
    completedFollowups: agg.completedFollowups,
    pendingFollowups: agg.pendingFollowups,
    overdueFollowups: agg.overdueFollowups,
    conversionRate: conversionRateOf(agg),
    performanceScore: performanceScoreOf(agg),
  };
}

/**
 * GET /sales/teams/performance — live aggregated performance for EVERY visible
 * team (admins: all active teams; managers: their own). One card per team.
 */
export const getTeamsPerformance = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const where: any = { archived: false };
    if (!ctx.isAdmin) where.managerId = ctx.userId;

    const teams = await prisma.salesTeam.findMany({ where, include: teamInclude, orderBy: { name: 'asc' } });
    const allOwnerIds = Array.from(new Set(teams.flatMap((t) => t.members.map((m) => m.userId))));

    const { byOwner, activeSet } = await aggregateOwnerMetrics(allOwnerIds);

    const result = teams.map((t) => {
      const agg = emptyOwner();
      let activeMembers = 0;
      for (const mem of t.members) {
        const om = byOwner.get(mem.userId);
        if (om) addInto(agg, om);
        if (activeSet.has(mem.userId)) activeMembers++;
      }
      return shapeTeamPerf(t, agg, activeMembers);
    });
    res.json(result);
  } catch (error) {
    console.error('Error building team performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/teams/:id/performance — drill-down for one team: rolled-up metrics,
 * per-member breakdown, and recent member activity. Ownership-guarded.
 */
export const getTeamPerformanceById = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid team id' });

    const team = await prisma.salesTeam.findUnique({ where: { id }, include: teamInclude });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!ctx.isAdmin && team.managerId !== ctx.userId) {
      return res.status(403).json({ error: 'You can only view teams you manage.' });
    }

    const memberIds = team.members.map((m) => m.userId);
    const { byOwner, activeSet } = await aggregateOwnerMetrics(memberIds);

    const agg = emptyOwner();
    let activeMembers = 0;
    const perMember = team.members.map((mem) => {
      const om = byOwner.get(mem.userId) ?? emptyOwner();
      addInto(agg, om);
      if (activeSet.has(mem.userId)) activeMembers++;
      return {
        userId: mem.userId,
        name: mem.user?.name ?? `User #${mem.userId}`,
        role: mem.role,
        ...om,
        conversionRate: conversionRateOf(om),
        performanceScore: performanceScoreOf(om),
      };
    });

    const recentActivity = memberIds.length
      ? await prisma.activity_logs.findMany({
          where: { actor_user_id: { in: memberIds } },
          select: { id: true, type: true, description: true, created_at: true, actor: { select: { id: true, name: true } } },
          orderBy: { created_at: 'desc' },
          take: 15,
        })
      : [];

    res.json({
      team,
      metrics: shapeTeamPerf(team, agg, activeMembers),
      perMember,
      recentActivity,
    });
  } catch (error) {
    console.error('Error building team performance detail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
