import prisma from '../config/db.js';
import { activityService } from './activity.service.js';
import { notificationService } from './notification.service.js';
import { isLeadClosed, CLOSED_STATES } from './leadScoring.service.js';

/**
 * Lead Follow-up / Reminder service.
 *
 * Reuses the existing FollowUp model as the reminder entity. Handles:
 *  - the initial follow-up task created on assignment (deduped per lead),
 *  - rule-based reminders triggered by interactions / stage changes (deduped by
 *    lead + due date + type),
 *  - scanning for due/overdue reminders to emit notifications.
 *
 * No reminders are generated once a lead is Won / Lost / Closed.
 */

export type ReminderType = 'initial' | 'call' | 'follow_up' | 'proposal_review' | 'manual';

/** Returns a Date at local midnight for day-level comparison. */
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

interface ScheduleOpts {
  leadId: number;
  ownerId: number;
  type: ReminderType;
  dueDate: Date;
  title: string;
  notes?: string;
  actorUserId?: number;
}

export const leadReminderService = {
  /**
   * Creates a reminder unless the lead is closed or an equivalent reminder
   * (same lead + type + due day, still pending) already exists. Returns the
   * created/existing FollowUp, or null when skipped.
   */
  async scheduleReminder(opts: ScheduleOpts) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: opts.leadId },
        select: { id: true, title: true, status: true, stage: true },
      });
      if (!lead) return null;
      // Stop generating reminders for completed leads.
      if (isLeadClosed(lead)) return null;

      // Duplicate prevention: same lead + same type + same due date (day) + pending.
      const dayStart = startOfDay(opts.dueDate);
      const dayEnd = endOfDay(opts.dueDate);
      const existing = await prisma.followUp.findFirst({
        where: {
          leadId: opts.leadId,
          type: opts.type,
          status: 'pending',
          scheduledDate: { gte: dayStart, lte: dayEnd },
        },
      });
      if (existing) return existing;

      const followUp = await prisma.followUp.create({
        data: {
          title: opts.title,
          notes: opts.notes || null,
          scheduledDate: opts.dueDate,
          status: 'pending',
          type: opts.type,
          leadId: opts.leadId,
          ownerId: opts.ownerId,
        },
      });

      if (opts.actorUserId) {
        const actor = await prisma.users.findUnique({ where: { id: opts.actorUserId }, select: { name: true } });
        await activityService.logActivity({
          actorUserId: opts.actorUserId,
          leadId: opts.leadId,
          type: 'reminder_created',
          description: `${actor?.name || 'System'} scheduled a ${opts.type.replace(/_/g, ' ')} reminder for "${lead.title}".`,
        });
      }

      // Notify the reminder's owner that a new reminder was created.
      await notificationService.createNotification({
        userId: opts.ownerId,
        type: 'assignment',
        title: 'New follow-up reminder',
        message: `${opts.title} — due ${opts.dueDate.toLocaleDateString()}.`,
        entityType: 'lead',
        entityId: opts.leadId,
      });

      return followUp;
    } catch (error) {
      console.error('Failed to schedule reminder:', error);
      return null;
    }
  },

  /**
   * Ensures the single initial follow-up task exists for a lead (created on
   * assignment). Deduped: if any `initial` follow-up already exists for the
   * lead, nothing is created (prevents duplicates on reassignment).
   */
  async ensureInitialFollowUp(opts: { leadId: number; ownerId: number; actorUserId?: number; label?: string }) {
    try {
      const existing = await prisma.followUp.findFirst({
        where: { leadId: opts.leadId, type: 'initial' },
      });
      if (existing) return existing;

      const lead = await prisma.lead.findUnique({
        where: { id: opts.leadId },
        select: { id: true, title: true, status: true, stage: true, customer: { select: { company: true } } },
      });
      if (!lead || isLeadClosed(lead)) return null;

      const label = opts.label || lead.customer?.company || lead.title;
      const due = addDays(new Date(), 1); // Tomorrow.

      const followUp = await prisma.followUp.create({
        data: {
          title: `Follow up with ${label}`,
          notes: 'Initial follow-up created on assignment.',
          scheduledDate: due,
          status: 'pending',
          type: 'initial',
          leadId: opts.leadId,
          ownerId: opts.ownerId,
        },
      });

      if (opts.actorUserId) {
        const actor = await prisma.users.findUnique({ where: { id: opts.actorUserId }, select: { name: true } });
        await activityService.logActivity({
          actorUserId: opts.actorUserId,
          leadId: opts.leadId,
          type: 'reminder_created',
          description: `${actor?.name || 'System'} created an initial follow-up task for "${lead.title}".`,
        });
      }

      await notificationService.createNotification({
        userId: opts.ownerId,
        type: 'assignment',
        title: 'New follow-up task',
        message: `Follow up with ${label} — due ${due.toLocaleDateString()}.`,
        entityType: 'lead',
        entityId: opts.leadId,
      });

      return followUp;
    } catch (error) {
      console.error('Failed to ensure initial follow-up:', error);
      return null;
    }
  },

  /**
   * Reassignment: move a lead's pending reminders to the new owner so reminders
   * always belong to the current lead owner. Does NOT create duplicate initial
   * tasks. Skips closed leads. Only future-dated reminders are re-armed for a
   * fresh "created" notification — already-due/overdue ones keep their notified
   * flag so the new owner isn't spammed about stale items.
   */
  async reassignReminders(leadId: number, newOwnerId: number) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { status: true, stage: true },
      });
      if (!lead || isLeadClosed(lead)) return;

      // Move ownership of every pending reminder.
      await prisma.followUp.updateMany({
        where: { leadId, status: 'pending' },
        data: { ownerId: newOwnerId },
      });
      // Re-arm only not-yet-due reminders so past-due ones don't re-notify.
      await prisma.followUp.updateMany({
        where: { leadId, status: 'pending', scheduledDate: { gt: endOfDay(new Date()) } },
        data: { reminderNotified: false },
      });
    } catch (error) {
      console.error('Failed to reassign reminders:', error);
    }
  },

  /**
   * Picks a sensible follow-up reminder for a logged interaction and schedules
   * it (deduped). Call → call-back in 3 days; Email → follow-up in 2 days;
   * Meeting → proposal review in 5 days.
   */
  async scheduleFromInteraction(opts: { leadId: number; ownerId: number; interactionType: string; actorUserId?: number; leadTitle: string }) {
    const map: Record<string, { type: ReminderType; days: number; title: string }> = {
      Call: { type: 'call', days: 3, title: `Call back ${opts.leadTitle}` },
      Email: { type: 'follow_up', days: 2, title: `Follow up on email with ${opts.leadTitle}` },
      Meeting: { type: 'proposal_review', days: 5, title: `Review proposal for ${opts.leadTitle}` },
    };
    const rule = map[opts.interactionType];
    if (!rule) return null;
    return this.scheduleReminder({
      leadId: opts.leadId,
      ownerId: opts.ownerId,
      type: rule.type,
      dueDate: addDays(new Date(), rule.days),
      title: rule.title,
      actorUserId: opts.actorUserId,
    });
  },

  /**
   * Scans pending reminders that are due today or overdue and have not yet been
   * notified, emits a notification to the owner, and marks them notified.
   * Runs periodically and on-demand (when an owner loads their reminders).
   */
  async scanDueReminders(ownerId?: number): Promise<number> {
    try {
      const now = new Date();
      const due = await prisma.followUp.findMany({
        where: {
          status: 'pending',
          reminderNotified: false,
          scheduledDate: { lte: endOfDay(now) },
          // Don't surface reminders for closed leads.
          lead: { is: { status: { notIn: CLOSED_STATES }, stage: { notIn: CLOSED_STATES } } },
          ...(ownerId ? { ownerId } : {}),
        },
        include: { lead: { select: { id: true, title: true } } },
      });

      for (const fu of due) {
        const overdue = new Date(fu.scheduledDate) < startOfDay(now);
        await notificationService.createNotification({
          userId: fu.ownerId,
          type: overdue ? 'reminder_overdue' : 'reminder_due',
          title: overdue ? 'Follow-up overdue' : 'Follow-up due today',
          message: `${fu.title}${fu.lead ? ` (${fu.lead.title})` : ''} — ${overdue ? 'was due' : 'due'} ${new Date(fu.scheduledDate).toLocaleDateString()}.`,
          entityType: 'lead',
          entityId: fu.leadId ?? 0,
        });
        await prisma.followUp.update({ where: { id: fu.id }, data: { reminderNotified: true } });
      }

      return due.length;
    } catch (error) {
      console.error('Failed to scan due reminders:', error);
      return 0;
    }
  },
};
