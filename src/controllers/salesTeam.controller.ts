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
