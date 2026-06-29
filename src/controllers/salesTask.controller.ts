import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { getSalesAuth, isManager, resolveTeamOwnerIds, getReportingManagerIds } from '../utils/salesAuth.js';

/**
 * SE-023 / SE-024 / SE-026 / SE-028 — Sales Task Management.
 *
 * Tasks are linked to exactly one Lead OR one Deal (never both, never neither —
 * no orphans). Reuses the shared notification + activity-log services. Tasks can
 * be flagged blocked with a reason (SE-024.1) and completed with an outcome +
 * notes (SE-026.1); managers get a team-wide task view (SE-028.1).
 */

const VALID_TYPES = ['call', 'meeting', 'email', 'follow_up', 'proposal_review'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_STATUSES = ['open', 'in_progress', 'completed'];

// SE-026.1 — completion outcomes.
const VALID_OUTCOMES = [
  'call_completed', 'client_interested', 'follow_up_required', 'meeting_scheduled',
  'proposal_sent', 'not_reachable', 'lost_opportunity', 'other',
];
const OUTCOME_LABELS: Record<string, string> = {
  call_completed: 'Call Completed', client_interested: 'Client Interested',
  follow_up_required: 'Follow-up Required', meeting_scheduled: 'Meeting Scheduled',
  proposal_sent: 'Proposal Sent', not_reachable: 'Not Reachable',
  lost_opportunity: 'Lost Opportunity', other: 'Other',
};

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
} as const;

const titleFor = (t: { lead?: { title: string } | null; deal?: { title: string } | null }) =>
  t.deal?.title ?? t.lead?.title ?? 'a record';

/**
 * SE-028 — object-level write authorization. A caller may MUTATE a task only
 * within their team scope, mirroring the read scope (resolveTeamOwnerIds) so the
 * write paths can't reach further than the view: Admin / unteamed-legacy-manager
 * / sales.assign holder = all owners (null); teamed Manager or Team Lead = their
 * team's tasks; a BDE = tasks assigned to them or that they created. Route-level
 * checkPermission('sales.edit') already gated the action; this adds the missing
 * per-record check (the same guard deleteSalesTask already applies).
 */
const canWriteTask = async (
  ctx: Awaited<ReturnType<typeof getSalesAuth>>,
  task: { assigneeId: number; createdById: number },
): Promise<boolean> => {
  const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
  if (ownerIds === null) return true;
  return ownerIds.includes(task.assigneeId) || task.createdById === ctx.userId;
};

/**
 * GET /sales/tasks — list tasks with filters. By default a user sees tasks they
 * own (assignee) or created; managers/admins see all. Filters: dealId, leadId,
 * assigneeId, status, type, blocked, scope=mine|all, due=today|overdue|upcoming.
 */
export const getSalesTasks = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const { dealId, leadId, assigneeId, status, type, blocked, scope, due } = req.query;

    const where: any = {};
    if (dealId && !isNaN(Number(dealId))) where.dealId = Number(dealId);
    if (leadId && !isNaN(Number(leadId))) where.leadId = Number(leadId);
    if (assigneeId && !isNaN(Number(assigneeId))) where.assigneeId = Number(assigneeId);
    if (typeof status === 'string' && VALID_STATUSES.includes(status)) where.status = status;
    if (typeof type === 'string' && VALID_TYPES.includes(type)) where.type = type;
    if (blocked === 'true') where.blocked = true;

    // Visibility mirrors the WRITE scope so every visible task is actionable
    // (no read>write mismatch that would 403 a clickable action). An explicit
    // dealId/leadId is a record the caller can already view → no owner filter.
    if (!dealId && !leadId) {
      if (scope === 'all') {
        // Team scope: admin / unteamed-legacy-manager / sales.assign holder =
        // all owners; teamed Manager or Team Lead = their team; BDE = self. This
        // is exactly the set canWriteTask authorises, so nothing visible 403s.
        const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
        if (ownerIds !== null) {
          const ids = ownerIds.length ? ownerIds : [ctx.userId];
          where.OR = [{ assigneeId: { in: ids } }, { createdById: ctx.userId }];
        }
      } else {
        // Default / scope=mine — only the caller's own tasks.
        where.OR = [{ assigneeId: ctx.userId }, { createdById: ctx.userId }];
      }
    }

    // Date band filters (used by dashboards).
    if (typeof due === 'string') {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      if (due === 'today') where.dueDate = { gte: startOfToday, lt: endOfToday };
      else if (due === 'overdue') {
        where.dueDate = { lt: startOfToday };
        where.status = { not: 'completed' };
      } else if (due === 'upcoming') where.dueDate = { gte: endOfToday };
    }

    const tasks = await prisma.salesTask.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(tasks);
  } catch (error) {
    console.error('Error fetching sales tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/tasks — create a task under exactly one Lead or one Deal. */
export const createSalesTask = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const body = req.body ?? {};

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'A task title is required.' });

    // Exactly one parent (no orphans, no dual-parent).
    const leadId = body.leadId != null && !isNaN(Number(body.leadId)) ? Number(body.leadId) : null;
    const dealId = body.dealId != null && !isNaN(Number(body.dealId)) ? Number(body.dealId) : null;
    if ((leadId && dealId) || (!leadId && !dealId)) {
      return res.status(400).json({ error: 'A task must belong to exactly one Lead or one Deal.' });
    }

    // Validate the parent exists.
    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
      if (!lead) return res.status(404).json({ error: 'Linked lead not found.' });
    }
    if (dealId) {
      const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
      if (!deal) return res.status(404).json({ error: 'Linked deal not found.' });
    }

    const type = VALID_TYPES.includes(body.type) ? body.type : 'follow_up';
    const priority = VALID_PRIORITIES.includes(body.priority) ? body.priority : 'medium';

    // Default the assignee to the creator; validate when an explicit one is given.
    let assigneeId = ctx.userId;
    if (body.assigneeId != null && !isNaN(Number(body.assigneeId))) {
      assigneeId = Number(body.assigneeId);
      const assignee = await prisma.users.findUnique({ where: { id: assigneeId }, select: { id: true } });
      if (!assignee) return res.status(400).json({ error: 'Assignee does not exist.' });
      // Spec: a BDE assigns only to self; a Manager/Team Lead within their team.
      // Self-assignment (the default) always passes; admins/unteamed managers
      // (ownerIds === null) may assign to anyone.
      if (assigneeId !== ctx.userId) {
        const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
        if (ownerIds !== null && !ownerIds.includes(assigneeId)) {
          return res.status(403).json({ error: 'You cannot assign tasks outside your team.' });
        }
      }
    }

    let dueDate: Date | null = null;
    if (body.dueDate) {
      const d = new Date(body.dueDate);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid due date.' });
      dueDate = d;
    }

    const task = await prisma.salesTask.create({
      data: {
        title,
        type,
        priority,
        status: 'open',
        dueDate,
        notes: typeof body.notes === 'string' ? body.notes : null,
        leadId,
        dealId,
        assigneeId,
        createdById: ctx.userId,
      },
      include: taskInclude,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: leadId ?? undefined,
      dealId: dealId ?? undefined,
      type: 'sales_task_created',
      description: `${actorName} created task "${task.title}" on ${titleFor(task)}.`,
    });

    // Notify the assignee when it isn't the creator (SE-023.2 behaviour).
    if (assigneeId !== ctx.userId) {
      await notificationService.createNotification({
        userId: assigneeId,
        type: 'assignment',
        title: 'New task assigned',
        message: `${actorName} assigned you a ${type.replace('_', ' ')} task: "${task.title}".`,
        entityType: dealId ? 'deal' : 'lead',
        entityId: (dealId ?? leadId)!,
      });
    }

    res.status(201).json(task);
  } catch (error) {
    console.error('Error creating sales task:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/tasks/:id — update task attributes / status / assignee. */
export const updateSalesTask = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

    const existing = await prisma.salesTask.findUnique({ where: { id }, include: taskInclude });
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    // Object-level scope: a Team Lead/BDE may only edit tasks within their team
    // scope (own team / own tasks); managers + admins keep their wider reach.
    // Resolve once here so the reassignment target can reuse the same scope.
    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
    const canWrite =
      ownerIds === null || ownerIds.includes(existing.assigneeId) || existing.createdById === ctx.userId;
    if (!canWrite) {
      return res.status(403).json({ error: 'You cannot modify this task.' });
    }

    const body = req.body ?? {};
    const data: Record<string, any> = {};

    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim();
    if (VALID_TYPES.includes(body.type)) data.type = body.type;
    if (VALID_PRIORITIES.includes(body.priority)) data.priority = body.priority;
    if (typeof body.notes === 'string') data.notes = body.notes;
    if (body.dueDate !== undefined) {
      if (body.dueDate === null || body.dueDate === '') data.dueDate = null;
      else {
        const d = new Date(body.dueDate);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid due date.' });
        data.dueDate = d;
      }
      // A changed due date re-arms the overdue alert (SE-029.1 notify-once guard).
      data.overdueNotifiedAt = null;
    }

    // SE-026.1 — optional completion outcome + notes (also accepted on a plain update).
    if (typeof body.outcome === 'string' && body.outcome.trim()) {
      if (!VALID_OUTCOMES.includes(body.outcome)) return res.status(400).json({ error: 'Invalid outcome.' });
      data.outcome = body.outcome;
    }
    if (typeof body.completionNotes === 'string') data.completionNotes = body.completionNotes;

    let statusChangedToDone = false;
    if (VALID_STATUSES.includes(body.status) && body.status !== existing.status) {
      data.status = body.status;
      if (body.status === 'completed') {
        data.completedAt = new Date();
        statusChangedToDone = true;
        // Completing a task implicitly clears any blocked flag.
        data.blocked = false;
      } else {
        data.completedAt = null;
        // Reopening re-arms the overdue alert.
        data.overdueNotifiedAt = null;
      }
    }

    let reassignedTo: number | null = null;
    if (body.assigneeId != null && !isNaN(Number(body.assigneeId)) && Number(body.assigneeId) !== existing.assigneeId) {
      // Reassignment is a manager/assigner action (spec: only Sales Managers
      // assign). Non-managers may update their own/team tasks but not move them.
      if (!isManager(ctx)) {
        return res.status(403).json({ error: 'You are not allowed to reassign tasks.' });
      }
      const newAssigneeId = Number(body.assigneeId);
      // Target must be within the caller's team scope (spec: Manager = own team).
      // Admins / unteamed managers (ownerIds === null) may assign to anyone.
      if (ownerIds !== null && !ownerIds.includes(newAssigneeId)) {
        return res.status(403).json({ error: 'You cannot assign tasks outside your team.' });
      }
      const assignee = await prisma.users.findUnique({ where: { id: newAssigneeId }, select: { id: true } });
      if (!assignee) return res.status(400).json({ error: 'Assignee does not exist.' });
      data.assigneeId = newAssigneeId;
      reassignedTo = newAssigneeId;
    }

    const task = await prisma.salesTask.update({ where: { id }, data, include: taskInclude });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';

    if (statusChangedToDone) {
      const outcomeLabel = task.outcome ? ` — ${OUTCOME_LABELS[task.outcome] ?? task.outcome}` : '';
      await activityService.logActivity({
        actorUserId: ctx.userId,
        leadId: task.leadId ?? undefined,
        dealId: task.dealId ?? undefined,
        type: 'sales_task_completed',
        description: `${actorName} completed task "${task.title}"${outcomeLabel}.`,
      });
    }
    if (reassignedTo && reassignedTo !== ctx.userId) {
      await notificationService.createNotification({
        userId: reassignedTo,
        type: 'assignment',
        title: 'Task assigned to you',
        message: `${actorName} assigned you the task "${task.title}".`,
        entityType: task.dealId ? 'deal' : 'lead',
        entityId: (task.dealId ?? task.leadId)!,
      });
    }

    res.json(task);
  } catch (error) {
    console.error('Error updating sales task:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/tasks/:id/block — flag/unflag a task as blocked (SE-024.1). */
export const setSalesTaskBlocked = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

    const existing = await prisma.salesTask.findUnique({ where: { id }, include: taskInclude });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (!(await canWriteTask(ctx, existing))) {
      return res.status(403).json({ error: 'You cannot modify this task.' });
    }

    const blocked = req.body.blocked === true || req.body.blocked === 'true';
    const reason = typeof req.body.blockerReason === 'string' ? req.body.blockerReason.trim() : '';
    if (blocked && !reason) {
      return res.status(400).json({ error: 'A blocker reason is required when marking a task blocked.' });
    }

    const task = await prisma.salesTask.update({
      where: { id },
      data: { blocked, blockerReason: blocked ? reason : null },
      include: taskInclude,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: task.leadId ?? undefined,
      dealId: task.dealId ?? undefined,
      type: blocked ? 'sales_task_blocked' : 'sales_task_unblocked',
      description: blocked
        ? `${actorName} marked task "${task.title}" blocked: ${reason}`
        : `${actorName} unblocked task "${task.title}".`,
    });

    // Surface a blocker to the creator/assignee (whoever isn't the actor).
    if (blocked) {
      const recipients = new Set<number>([task.assigneeId, task.createdById]);
      recipients.delete(ctx.userId);
      if (recipients.size > 0) {
        await notificationService.createNotifications([...recipients], {
          type: 'escalation',
          title: 'Task blocked',
          message: `"${task.title}" is blocked: ${reason}`,
          entityType: task.dealId ? 'deal' : 'lead',
          entityId: (task.dealId ?? task.leadId)!,
        });
      }
    }

    res.json(task);
  } catch (error) {
    console.error('Error setting task blocked state:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/tasks/:id — creator, assignee or admin/manager. */
export const deleteSalesTask = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

    const existing = await prisma.salesTask.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (existing.createdById !== ctx.userId && existing.assigneeId !== ctx.userId && !isManager(ctx)) {
      return res.status(403).json({ error: 'You cannot delete this task.' });
    }

    await prisma.salesTask.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting sales task:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/tasks/:id/complete — SE-026.1 activity completion logging. Requires
 * an outcome; stores completion notes; notifies the assignee's reporting manager.
 */
export const completeSalesTask = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

    const existing = await prisma.salesTask.findUnique({ where: { id }, include: taskInclude });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (!(await canWriteTask(ctx, existing))) {
      return res.status(403).json({ error: 'You cannot modify this task.' });
    }

    const outcome = typeof req.body.outcome === 'string' ? req.body.outcome.trim() : '';
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: 'A valid outcome is required to complete a task.' });
    }
    const completionNotes = typeof req.body.completionNotes === 'string' ? req.body.completionNotes.trim() || null : null;

    const task = await prisma.salesTask.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date(), outcome, completionNotes, blocked: false },
      include: taskInclude,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: task.leadId ?? undefined,
      dealId: task.dealId ?? undefined,
      type: 'sales_task_completed',
      description: `${actorName} completed task "${task.title}" — ${OUTCOME_LABELS[outcome] ?? outcome}.`,
    });

    // Notify the assignee's reporting manager(s) of the outcome (never self).
    const managers = (await getReportingManagerIds(task.assigneeId)).filter((mid) => mid !== ctx.userId);
    if (managers.length > 0) {
      await notificationService.createNotifications(managers, {
        type: 'status_change',
        title: 'Task completed',
        message: `${actorName} completed "${task.title}" — ${OUTCOME_LABELS[outcome] ?? outcome}.`,
        entityType: task.dealId ? 'deal' : 'lead',
        entityId: (task.dealId ?? task.leadId)!,
      });
    }

    res.json(task);
  } catch (error) {
    console.error('Error completing sales task:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/tasks/team — SE-028.1 manager team task view. Returns team KPI
 * cards, a per-member breakdown (with completion %), and the task list. Scope is
 * data-driven: a manager only sees their team (resolveTeamOwnerIds); admins (and
 * not-yet-teamed managers) see all. Optional filters: userId, status, priority.
 */
export const getTeamTasks = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners

    const { userId, status, priority, teamId, due, search } = req.query;

    // KPIs + member rollup span ALL the in-scope team tasks (status-agnostic);
    // the returned `tasks` list gets the display filters applied.
    const scopeWhere: any = {};
    if (ownerIds !== null) scopeWhere.assigneeId = { in: ownerIds.length ? ownerIds : [ctx.userId] };
    if (userId && !isNaN(Number(userId))) {
      const uid = Number(userId);
      if (ownerIds === null || ownerIds.includes(uid)) scopeWhere.assigneeId = uid;
    }

    const allTasks = await prisma.salesTask.findMany({
      where: scopeWhere,
      include: taskInclude,
      orderBy: [{ dueDate: 'asc' }],
    });

    // Resolve each in-scope member's team (single source of truth = the live
    // sales_team_members → team join). Gives every task a Team Name and powers
    // the Team filter. A user belongs to at most one team.
    const memberTeam = new Map<number, { id: number; name: string }>();
    const teamMemberships = await prisma.salesTeamMember.findMany({
      where: ownerIds !== null ? { userId: { in: ownerIds.length ? ownerIds : [ctx.userId] } } : {},
      select: { userId: true, team: { select: { id: true, name: true, archived: true } } },
    });
    for (const tm of teamMemberships) {
      if (tm.team && !tm.team.archived) memberTeam.set(tm.userId, { id: tm.team.id, name: tm.team.name });
    }
    const teamOf = (assigneeId: number) => memberTeam.get(assigneeId) ?? null;
    const withTeam = (t: (typeof allTasks)[number]) => ({ ...t, team: teamOf(t.assigneeId) });

    // Team is a STRUCTURAL scope (each team's summary), not a transient view
    // filter: selecting a team narrows the KPIs + member breakdown to that team.
    // The transient filters (status/priority/due/search) still affect only the
    // task list below, so the summary stays stable as you browse statuses.
    const teamIdNum = teamId && !isNaN(Number(teamId)) ? Number(teamId) : null;
    const scopeTasks = teamIdNum !== null
      ? allTasks.filter((t) => teamOf(t.assigneeId)?.id === teamIdNum)
      : allTasks;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const isOverdue = (t: (typeof allTasks)[number]) => t.status !== 'completed' && !!t.dueDate && t.dueDate < startOfToday;

    const total = scopeTasks.length;
    const completed = scopeTasks.filter((t) => t.status === 'completed').length;
    const inProgress = scopeTasks.filter((t) => t.status === 'in_progress').length;
    const pending = total - completed;
    const overdue = scopeTasks.filter(isOverdue).length;
    const blocked = scopeTasks.filter((t) => t.blocked && t.status !== 'completed').length;
    const highPriority = scopeTasks.filter((t) => (t.priority === 'high' || t.priority === 'urgent') && t.status !== 'completed').length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Average completion time (days) over completed tasks that have a completedAt.
    const completedTimed = scopeTasks.filter((t) => t.status === 'completed' && t.completedAt);
    const avgCompletionDays = completedTimed.length > 0
      ? Math.round(
          (completedTimed.reduce((s, t) => s + (t.completedAt!.getTime() - t.createdAt.getTime()) / 86400000, 0) /
            completedTimed.length) * 10,
        ) / 10
      : 0;

    const byMember = new Map<number, any>();
    for (const t of scopeTasks) {
      const row = byMember.get(t.assigneeId) ?? {
        userId: t.assigneeId, name: t.assignee?.name ?? 'Unknown', email: t.assignee?.email ?? null,
        team: teamOf(t.assigneeId)?.name ?? null,
        total: 0, completed: 0, pending: 0, overdue: 0, blocked: 0,
      };
      row.total++;
      if (t.status === 'completed') row.completed++; else row.pending++;
      if (isOverdue(t)) row.overdue++;
      if (t.blocked && t.status !== 'completed') row.blocked++;
      byMember.set(t.assigneeId, row);
    }
    const members = [...byMember.values()].map((m) => ({
      ...m,
      completionRate: m.total > 0 ? Math.round((m.completed / m.total) * 100) : 0,
    }));

    // Team-wise breakdown — one row per team, aggregating every member's tasks
    // across the FULL in-scope set (so it is independent of the teamId filter,
    // which only switches the frontend between team vs member breakdown). Built
    // from allTasks (the userId/member filter already narrowed scopeWhere), so
    // the Member filter still scopes it too. Tasks for members with no team are
    // excluded (they cannot form a team row).
    const byTeam = new Map<number, any>();
    for (const t of allTasks) {
      const team = teamOf(t.assigneeId);
      if (!team) continue;
      const row = byTeam.get(team.id) ?? {
        teamId: team.id, teamName: team.name, members: new Set<number>(),
        total: 0, completed: 0, pending: 0, overdue: 0, blocked: 0,
      };
      row.members.add(t.assigneeId);
      row.total++;
      if (t.status === 'completed') row.completed++; else row.pending++;
      if (isOverdue(t)) row.overdue++;
      if (t.blocked && t.status !== 'completed') row.blocked++;
      byTeam.set(team.id, row);
    }
    const teamBreakdown = [...byTeam.values()].map((r) => ({
      teamId: r.teamId,
      teamName: r.teamName,
      memberCount: r.members.size,
      total: r.total,
      completed: r.completed,
      pending: r.pending,
      overdue: r.overdue,
      blocked: r.blocked,
      completionRate: r.total > 0 ? Math.round((r.completed / r.total) * 100) : 0,
    }));

    // Distinct teams in scope — for the Team filter dropdown.
    const teamsMap = new Map<number, string>();
    for (const t of memberTeam.values()) teamsMap.set(t.id, t.name);
    const teams = [...teamsMap.entries()].map(([tid, name]) => ({ id: tid, name })).sort((a, b) => a.name.localeCompare(b.name));

    // Transient display filters apply to the task LIST only (the team scope is
    // already baked into scopeTasks; KPIs/members reflect the chosen team).
    let tasks = scopeTasks;
    if (typeof status === 'string' && VALID_STATUSES.includes(status)) tasks = tasks.filter((t) => t.status === status);
    if (typeof priority === 'string' && VALID_PRIORITIES.includes(priority)) tasks = tasks.filter((t) => t.priority === priority);
    if (due === 'overdue') tasks = tasks.filter(isOverdue);
    else if (due === 'today') tasks = tasks.filter((t) => !!t.dueDate && t.dueDate >= startOfToday && t.dueDate < endOfToday);
    else if (due === 'upcoming') tasks = tasks.filter((t) => !!t.dueDate && t.dueDate >= endOfToday);
    if (typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || (t.assignee?.name || '').toLowerCase().includes(q));
    }

    res.json({
      kpis: { total, completed, inProgress, pending, overdue, blocked, highPriority, avgCompletionDays, completionRate },
      members,
      teamBreakdown,
      teams,
      tasks: tasks.map(withTeam),
    });
  } catch (error) {
    console.error('Error fetching team tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
