import prisma from '../config/db.js';
import { activityService } from './activity.service.js';
import { notificationService } from './notification.service.js';

/**
 * SE-027.1/2 — Recurring task generation.
 *
 * For each active rule whose nextRunAt has arrived, generate the next SalesTask
 * from the rule's template fields, then advance nextRunAt by frequency×interval
 * so the same occurrence is never generated twice (no duplicates). Disabling a
 * rule (active=false) halts generation without touching already-created tasks.
 * Rules past their end date — or whose template parent was deleted — are
 * deactivated so the generator never violates the one-parent constraint.
 */

/** Advance a date by frequency × interval. */
export function advance(from: Date, frequency: string, interval: number): Date {
  const d = new Date(from);
  const n = Math.max(1, interval || 1);
  if (frequency === 'daily') d.setDate(d.getDate() + n);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + n);
  return d;
}

export const recurringTaskService = {
  async generateDueRecurringTasks(): Promise<number> {
    try {
      const now = new Date();
      const due = await prisma.recurrenceRule.findMany({
        where: { active: true, nextRunAt: { not: null, lte: now } },
      });

      let created = 0;
      for (const rule of due) {
        // Past the end date → stop generating; deactivate so it isn't re-scanned.
        if (rule.endDate && rule.endDate < now) {
          await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { active: false } });
          continue;
        }
        // Guard: the template parent must still exist, else deactivate the rule.
        if (rule.leadId) {
          const lead = await prisma.lead.findUnique({ where: { id: rule.leadId }, select: { id: true } });
          if (!lead) {
            await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { active: false } });
            continue;
          }
        }
        if (rule.dealId) {
          const deal = await prisma.deal.findUnique({ where: { id: rule.dealId }, select: { id: true } });
          if (!deal) {
            await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { active: false } });
            continue;
          }
        }

        const dueDate = rule.nextRunAt ?? now;
        const task = await prisma.salesTask.create({
          data: {
            title: rule.title,
            type: rule.type,
            priority: rule.priority,
            status: 'open',
            dueDate,
            notes: rule.notes,
            leadId: rule.leadId,
            dealId: rule.dealId,
            assigneeId: rule.assigneeId,
            createdById: rule.createdById,
            recurrenceRuleId: rule.id,
          },
        });

        const next = advance(dueDate, rule.frequency, rule.interval);
        await prisma.recurrenceRule.update({
          where: { id: rule.id },
          data: { lastGeneratedAt: now, nextRunAt: next },
        });

        await activityService.logActivity({
          actorUserId: rule.createdById,
          leadId: rule.leadId ?? undefined,
          dealId: rule.dealId ?? undefined,
          type: 'sales_task_generated',
          description: `Recurring rule generated task "${task.title}".`,
        });

        await notificationService.createNotification({
          userId: rule.assigneeId,
          type: 'assignment',
          title: 'New recurring task',
          message: `A recurring ${rule.type.replace('_', ' ')} task "${task.title}" was created and assigned to you.`,
          entityType: rule.dealId ? 'deal' : 'lead',
          entityId: (rule.dealId ?? rule.leadId)!,
        });

        created++;
      }
      return created;
    } catch (error) {
      console.error('Failed to generate recurring tasks:', error);
      return 0;
    }
  },
};
