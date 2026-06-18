import prisma from '../config/db.js';
import { notificationService } from './notification.service.js';
import { activityService } from './activity.service.js';

/**
 * SE-030 — Daily report aggregation + scheduler.
 *
 * runDailyAggregation persists one zero-filled snapshot per active owner for the
 * previous complete day (idempotent, time-gated so the 30-min sweep only writes
 * once/day). processDueSchedules fires configured schedules, notifying recipients
 * and recording Generated/Failed status. Reuses the shared notification + activity
 * services; no external cron.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Aggregate one owner's activity over [start, end). */
async function aggregateOwnerDay(ownerId: number, start: Date, end: Date) {
  const [calls, meetings, leadsCreated, contacted, followUpsCompleted, dealsCreated, wonDeals, dealsLost] =
    await Promise.all([
      prisma.leadInteraction.count({ where: { authorId: ownerId, type: 'Call', interactionDate: { gte: start, lt: end } } }),
      prisma.leadInteraction.count({ where: { authorId: ownerId, type: 'Meeting', interactionDate: { gte: start, lt: end } } }),
      prisma.lead.count({ where: { ownerId, createdAt: { gte: start, lt: end } } }),
      prisma.leadInteraction.findMany({ where: { authorId: ownerId, interactionDate: { gte: start, lt: end } }, select: { leadId: true }, distinct: ['leadId'] }),
      prisma.followUp.count({ where: { ownerId, status: 'completed', completedAt: { gte: start, lt: end } } }),
      prisma.deal.count({ where: { ownerId, createdAt: { gte: start, lt: end } } }),
      prisma.deal.findMany({ where: { ownerId, status: 'won', closedAt: { gte: start, lt: end } }, select: { amount: true } }),
      prisma.deal.count({ where: { ownerId, status: 'lost', closedAt: { gte: start, lt: end } } }),
    ]);

  return {
    calls,
    meetings,
    leadsCreated,
    leadsContacted: contacted.length,
    followUpsCompleted,
    dealsCreated,
    dealsWon: wonDeals.length,
    dealsLost,
    revenueWon: wonDeals.reduce((s, d) => s + (d.amount || 0), 0),
  };
}

function nextRun(frequency: string, from: Date): Date {
  const d = new Date(from);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1);
  return d;
}

export const salesReportService = {
  /** SE-030.1 — persist yesterday's snapshot for every active user (once/day). */
  async runDailyAggregation(): Promise<number> {
    try {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start = new Date(today.getTime() - DAY); // yesterday 00:00
      const end = today; // today 00:00

      // Time-gate: if yesterday is already aggregated, do nothing this sweep.
      const existing = await prisma.dailyReport.count({ where: { reportDate: start } });
      if (existing > 0) return 0;

      const users = await prisma.users.findMany({ where: { status: 'active' }, select: { id: true } });
      let written = 0;
      for (const u of users) {
        const metrics = await aggregateOwnerDay(u.id, start, end);
        await prisma.dailyReport.upsert({
          where: { ownerId_reportDate: { ownerId: u.id, reportDate: start } },
          create: { ownerId: u.id, reportDate: start, ...metrics },
          update: { ...metrics },
        });
        written++;
      }
      return written;
    } catch (error) {
      console.error('Failed daily report aggregation:', error);
      return 0;
    }
  },

  /** Live (un-persisted) snapshot for a single owner + day — used for "today". */
  async computeLiveSnapshot(ownerId: number, day: Date) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(start.getTime() + DAY);
    return aggregateOwnerDay(ownerId, start, end);
  },

  /** SE-030.2 — fire due schedules: notify recipients + record status. */
  async processDueSchedules(): Promise<number> {
    try {
      const now = new Date();
      const due = await prisma.reportSchedule.findMany({ where: { active: true, nextRunAt: { not: null, lte: now } } });
      let processed = 0;
      for (const sch of due) {
        try {
          const recipients = Array.isArray(sch.recipients)
            ? (sch.recipients as any[]).map((r) => Number(r)).filter((n) => !isNaN(n))
            : [];
          if (recipients.length) {
            await notificationService.createNotifications(recipients, {
              type: 'report',
              title: `Report ready: ${sch.name}`,
              message: `The ${sch.frequency} "${sch.name}" report has been generated.`,
              entityType: 'report',
              entityId: sch.id,
            });
          }
          await activityService.logActivity({
            actorUserId: sch.createdById,
            type: 'report_generated',
            description: `Scheduled report "${sch.name}" (${sch.frequency}) generated.`,
          });
          await prisma.reportSchedule.update({
            where: { id: sch.id },
            data: { lastRunAt: now, lastStatus: 'generated', nextRunAt: nextRun(sch.frequency, now) },
          });
        } catch (err) {
          console.error(`Report schedule ${sch.id} failed:`, err);
          await prisma.reportSchedule
            .update({ where: { id: sch.id }, data: { lastRunAt: now, lastStatus: 'failed', nextRunAt: nextRun(sch.frequency, now) } })
            .catch(() => {});
          await notificationService
            .createNotification({
              userId: sch.createdById,
              type: 'escalation',
              title: 'Report generation failed',
              message: `Scheduled report "${sch.name}" failed to generate.`,
              entityType: 'report',
              entityId: sch.id,
            })
            .catch(() => {});
        }
        processed++;
      }
      return processed;
    } catch (error) {
      console.error('Failed processing report schedules:', error);
      return 0;
    }
  },
};
