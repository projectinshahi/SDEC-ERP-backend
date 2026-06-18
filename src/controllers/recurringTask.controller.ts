import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { getSalesAuth, isManager } from '../utils/salesAuth.js';

/**
 * SE-027.1 — Recurrence rule configuration (create / edit / disable). The
 * scheduler (recurringTask.service) consumes active rules; disabling a rule
 * (active=false) halts future generation without touching existing tasks.
 */

const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly'];
const VALID_TYPES = ['call', 'meeting', 'email', 'follow_up', 'proposal_review'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const ruleInclude = {
  assignee: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
} as const;

/** GET /sales/tasks/recurring — list rules (own unless manager). */
export const getRecurrenceRules = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const { dealId, leadId, assigneeId, active } = req.query;

    const where: any = {};
    if (dealId && !isNaN(Number(dealId))) where.dealId = Number(dealId);
    if (leadId && !isNaN(Number(leadId))) where.leadId = Number(leadId);
    if (assigneeId && !isNaN(Number(assigneeId))) where.assigneeId = Number(assigneeId);
    if (active === 'true') where.active = true;
    else if (active === 'false') where.active = false;

    if (!isManager(ctx) && !dealId && !leadId) {
      where.OR = [{ assigneeId: ctx.userId }, { createdById: ctx.userId }];
    }

    const rules = await prisma.recurrenceRule.findMany({
      where,
      include: ruleInclude,
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(rules);
  } catch (error) {
    console.error('Error fetching recurrence rules:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/tasks/recurring — create a recurrence rule. */
export const createRecurrenceRule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const body = req.body ?? {};

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'A title is required.' });

    if (!VALID_FREQUENCIES.includes(body.frequency)) {
      return res.status(400).json({ error: 'Frequency must be daily, weekly or monthly.' });
    }
    const interval = body.interval != null ? Number(body.interval) : 1;
    if (isNaN(interval) || interval < 1 || interval > 365) {
      return res.status(400).json({ error: 'Interval must be between 1 and 365.' });
    }

    const leadId = body.leadId != null && !isNaN(Number(body.leadId)) ? Number(body.leadId) : null;
    const dealId = body.dealId != null && !isNaN(Number(body.dealId)) ? Number(body.dealId) : null;
    if ((leadId && dealId) || (!leadId && !dealId)) {
      return res.status(400).json({ error: 'A recurrence rule must belong to exactly one Lead or one Deal.' });
    }
    if (leadId && !(await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } }))) {
      return res.status(404).json({ error: 'Linked lead not found.' });
    }
    if (dealId && !(await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } }))) {
      return res.status(404).json({ error: 'Linked deal not found.' });
    }

    let assigneeId = ctx.userId;
    if (body.assigneeId != null && !isNaN(Number(body.assigneeId))) {
      assigneeId = Number(body.assigneeId);
      if (!(await prisma.users.findUnique({ where: { id: assigneeId }, select: { id: true } }))) {
        return res.status(400).json({ error: 'Assignee does not exist.' });
      }
    }

    const startDate = body.startDate ? new Date(body.startDate) : new Date();
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid start date.' });
    let endDate: Date | null = null;
    if (body.endDate) {
      endDate = new Date(body.endDate);
      if (isNaN(endDate.getTime())) return res.status(400).json({ error: 'Invalid end date.' });
      if (endDate < startDate) return res.status(400).json({ error: 'End date must be after the start date.' });
    }

    const rule = await prisma.recurrenceRule.create({
      data: {
        title,
        type: VALID_TYPES.includes(body.type) ? body.type : 'follow_up',
        priority: VALID_PRIORITIES.includes(body.priority) ? body.priority : 'medium',
        notes: typeof body.notes === 'string' ? body.notes : null,
        frequency: body.frequency,
        interval,
        startDate,
        endDate,
        active: true,
        assigneeId,
        leadId,
        dealId,
        nextRunAt: startDate, // first occurrence generated when the sweep reaches it
        createdById: ctx.userId,
      },
      include: ruleInclude,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: leadId ?? undefined,
      dealId: dealId ?? undefined,
      type: 'recurrence_rule_created',
      description: `${actorName} created a ${body.frequency} recurring task "${title}".`,
    });

    res.status(201).json(rule);
  } catch (error) {
    console.error('Error creating recurrence rule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/tasks/recurring/:id — edit / disable a rule. */
export const updateRecurrenceRule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid rule id' });

    const existing = await prisma.recurrenceRule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    if (existing.createdById !== ctx.userId && existing.assigneeId !== ctx.userId && !isManager(ctx)) {
      return res.status(403).json({ error: 'You cannot edit this rule.' });
    }

    const body = req.body ?? {};
    const data: Record<string, any> = {};
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim();
    if (VALID_TYPES.includes(body.type)) data.type = body.type;
    if (VALID_PRIORITIES.includes(body.priority)) data.priority = body.priority;
    if (typeof body.notes === 'string') data.notes = body.notes;
    if (VALID_FREQUENCIES.includes(body.frequency)) data.frequency = body.frequency;
    if (body.interval != null && !isNaN(Number(body.interval))) {
      const iv = Number(body.interval);
      if (iv < 1 || iv > 365) return res.status(400).json({ error: 'Interval must be between 1 and 365.' });
      data.interval = iv;
    }
    if (body.endDate !== undefined) {
      if (body.endDate === null || body.endDate === '') data.endDate = null;
      else {
        const d = new Date(body.endDate);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid end date.' });
        data.endDate = d;
      }
    }
    if (typeof body.active === 'boolean' || body.active === 'true' || body.active === 'false') {
      const next = body.active === true || body.active === 'true';
      data.active = next;
      // Re-enabling a rule with no future run arms it for the next sweep.
      if (next && !existing.nextRunAt) data.nextRunAt = new Date();
    }

    const rule = await prisma.recurrenceRule.update({ where: { id }, data, include: ruleInclude });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: rule.leadId ?? undefined,
      dealId: rule.dealId ?? undefined,
      type: data.active === false ? 'recurrence_rule_disabled' : 'recurrence_rule_updated',
      description: `${actorName} ${data.active === false ? 'disabled' : 'updated'} recurring task "${rule.title}".`,
    });

    res.json(rule);
  } catch (error) {
    console.error('Error updating recurrence rule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/tasks/recurring/:id — delete a rule (generated tasks remain). */
export const deleteRecurrenceRule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid rule id' });

    const existing = await prisma.recurrenceRule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    if (existing.createdById !== ctx.userId && existing.assigneeId !== ctx.userId && !isManager(ctx)) {
      return res.status(403).json({ error: 'You cannot delete this rule.' });
    }

    // Detach already-generated tasks (existing tasks remain unaffected, SE-027.2).
    await prisma.salesTask.updateMany({ where: { recurrenceRuleId: id }, data: { recurrenceRuleId: null } });
    await prisma.recurrenceRule.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting recurrence rule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
