import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { getSalesAuth, isManager } from '../utils/salesAuth.js';

/**
 * SE-023 / SE-024 — Sales Task Management.
 *
 * Tasks are linked to exactly one Lead OR one Deal (never both, never neither —
 * no orphans). Reuses the shared notification + activity-log services. Tasks can
 * be flagged blocked with a reason for execution visibility (SE-024.1).
 */

const VALID_TYPES = ['call', 'meeting', 'email', 'follow_up', 'proposal_review'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_STATUSES = ['open', 'in_progress', 'completed'];

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
} as const;

const titleFor = (t: { lead?: { title: string } | null; deal?: { title: string } | null }) =>
  t.deal?.title ?? t.lead?.title ?? 'a record';

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

    // Visibility: non-managers only see their own unless they pass an explicit
    // dealId/leadId (a record they can already view) or scope=all.
    const restrictToOwn = !isManager(ctx) && scope !== 'all' && !dealId && !leadId;
    if (restrictToOwn) {
      where.OR = [{ assigneeId: ctx.userId }, { createdById: ctx.userId }];
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
    }

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
      }
    }

    let reassignedTo: number | null = null;
    if (body.assigneeId != null && !isNaN(Number(body.assigneeId)) && Number(body.assigneeId) !== existing.assigneeId) {
      const newAssigneeId = Number(body.assigneeId);
      const assignee = await prisma.users.findUnique({ where: { id: newAssigneeId }, select: { id: true } });
      if (!assignee) return res.status(400).json({ error: 'Assignee does not exist.' });
      data.assigneeId = newAssigneeId;
      reassignedTo = newAssigneeId;
    }

    const task = await prisma.salesTask.update({ where: { id }, data, include: taskInclude });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';

    if (statusChangedToDone) {
      await activityService.logActivity({
        actorUserId: ctx.userId,
        leadId: task.leadId ?? undefined,
        dealId: task.dealId ?? undefined,
        type: 'sales_task_completed',
        description: `${actorName} completed task "${task.title}".`,
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
