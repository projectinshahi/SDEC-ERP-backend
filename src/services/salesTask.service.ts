import prisma from '../config/db.js';
import { activityService } from './activity.service.js';
import { notificationService } from './notification.service.js';
import { getReportingManagerIds } from '../utils/salesAuth.js';

/**
 * SE-029.1 — Overdue Sales Task engine.
 *
 * A task is overdue when its due date is before today AND it is not completed.
 * Completed tasks never trigger (the status filter guarantees it). Reuses the
 * shared notification + activity-log services. Notify-once via overdueNotifiedAt,
 * which the controller clears whenever the due date changes or the task reopens.
 */
export const salesTaskService = {
  async scanOverdueTasks(): Promise<number> {
    try {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const overdue = await prisma.salesTask.findMany({
        where: {
          status: { not: 'completed' },
          dueDate: { lt: startOfToday },
          overdueNotifiedAt: null,
        },
        select: { id: true, title: true, assigneeId: true, dueDate: true, dealId: true, leadId: true },
      });

      let alerted = 0;
      for (const t of overdue) {
        await activityService.logActivity({
          actorUserId: t.assigneeId,
          leadId: t.leadId ?? undefined,
          dealId: t.dealId ?? undefined,
          type: 'sales_task_overdue',
          description: `Task "${t.title}" is overdue (was due ${t.dueDate?.toLocaleDateString()}).`,
        });

        const managers = await getReportingManagerIds(t.assigneeId);
        const recipients = new Set<number>([t.assigneeId, ...managers]);
        await notificationService.createNotifications([...recipients], {
          type: 'escalation',
          title: 'Task overdue',
          message: `"${t.title}" was due ${t.dueDate?.toLocaleDateString()} and is not complete.`,
          entityType: t.dealId ? 'deal' : 'lead',
          entityId: (t.dealId ?? t.leadId)!,
        });

        await prisma.salesTask.update({ where: { id: t.id }, data: { overdueNotifiedAt: now } });
        alerted++;
      }
      return alerted;
    } catch (error) {
      console.error('Failed to scan overdue tasks:', error);
      return 0;
    }
  },
};
