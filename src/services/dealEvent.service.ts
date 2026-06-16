import prisma from '../config/db.js';
import { activityService } from './activity.service.js';
import { notificationService } from './notification.service.js';

/**
 * Deal lifecycle events & forecasting helpers.
 *
 * Reuses the existing activity-log + notification infrastructure. Responsible
 * for the once-only "Deal Won" event (SE-016.2), the weighted-forecast stage
 * probabilities (SE-019), and the "close date approaching" reminder scan.
 */

const DAY = 24 * 60 * 60 * 1000;

// Closed (terminal) deal stages — excluded from the active pipeline / forecast.
export const CLOSED_DEAL_STAGES = ['Closed Won', 'Closed Lost'];

// Stage → default win-probability used to weight the revenue forecast and to
// auto-fill a deal's probability when it advances (SE-019.1 examples).
export const STAGE_PROBABILITY: Record<string, number> = {
  'Proposal Sent': 20,
  'Demo Done': 40,
  'Contract Review': 70,
  'Negotiation': 90,
  'Closed Won': 100,
  'Closed Lost': 0,
};

/** Default probability (0–100) for a stage; falls back to 10 for unknowns. */
export const defaultProbabilityForStage = (stage: string): number =>
  STAGE_PROBABILITY[stage] ?? 10;

/** Weighted revenue = amount × probability% (SE-019.2). */
export const weightedRevenue = (amount: number, probability: number): number =>
  Math.round((amount || 0) * (Math.max(0, Math.min(100, probability || 0)) / 100));

export const dealEventService = {
  /**
   * SE-016.2 — Deal Won Event. Fires exactly once per deal: idempotent via the
   * `wonEventAt` marker, which is only set after downstream processing succeeds,
   * so a failed run is retried later (see processPendingDealWonEvents).
   */
  async emitDealWon(dealId: number, actorUserId?: number): Promise<boolean> {
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        include: {
          owner: { select: { id: true, name: true } },
          customer: { select: { company: true, name: true } },
        },
      });
      if (!deal) return false;
      // Already processed → do nothing (exactly-once guarantee).
      if (deal.wonEventAt) return false;
      // Only a Closed-Won deal qualifies.
      if (deal.stage !== 'Closed Won') return false;

      const company = deal.customer?.company || deal.customer?.name || deal.title;

      // ── Downstream processing (extend here for finance/project hand-off) ────
      await activityService.logActivity({
        actorUserId: actorUserId ?? deal.ownerId,
        dealId: deal.id,
        type: 'deal_won',
        description: `Deal "${deal.title}" was won 🎉 (${company}).`,
      });

      // Notify the owner + every Sales Manager / Admin.
      const managers = await prisma.users.findMany({
        where: {
          status: 'active',
          OR: [
            { role: { contains: 'admin', mode: 'insensitive' } },
            { role: { contains: 'manager', mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      const recipients = new Set<number>([deal.ownerId, ...managers.map((m) => m.id)]);
      await notificationService.createNotifications([...recipients], {
        type: 'status_change',
        title: 'Deal won 🎉',
        message: `"${deal.title}" (${company}) was marked Closed Won.`,
        entityType: 'deal',
        entityId: deal.id,
      });

      // Mark processed last — guarantees retry if anything above threw.
      await prisma.deal.update({ where: { id: dealId }, data: { wonEventAt: new Date() } });
      return true;
    } catch (error) {
      console.error(`Failed to emit Deal Won event for deal ${dealId}:`, error);
      return false;
    }
  },

  /**
   * Retry hook: processes any Closed-Won deal whose Won event has not yet
   * completed (wonEventAt still null). Safe to run repeatedly.
   */
  async processPendingDealWonEvents(): Promise<number> {
    try {
      const pending = await prisma.deal.findMany({
        where: { stage: 'Closed Won', wonEventAt: null },
        select: { id: true, ownerId: true },
      });
      let processed = 0;
      for (const d of pending) {
        if (await this.emitDealWon(d.id, d.ownerId)) processed++;
      }
      return processed;
    } catch (error) {
      console.error('Failed to process pending Deal Won events:', error);
      return 0;
    }
  },

  /**
   * Notifications: "close date approaching". Open deals with an expected close
   * date within the next 3 days that have not been flagged yet get a one-time
   * reminder to their owner.
   */
  async scanDealCloseDeadlines(): Promise<number> {
    try {
      const now = new Date();
      const horizon = new Date(now.getTime() + 3 * DAY);
      const due = await prisma.deal.findMany({
        where: {
          stage: { notIn: CLOSED_DEAL_STAGES },
          closeReminderNotified: false,
          expectedCloseDate: { not: null, lte: horizon },
        },
        select: { id: true, title: true, ownerId: true, expectedCloseDate: true },
      });

      for (const deal of due) {
        await notificationService.createNotification({
          userId: deal.ownerId,
          type: 'reminder_due',
          title: 'Deal close date approaching',
          message: `"${deal.title}" is expected to close ${deal.expectedCloseDate?.toLocaleDateString()}.`,
          entityType: 'deal',
          entityId: deal.id,
        });
        await prisma.deal.update({ where: { id: deal.id }, data: { closeReminderNotified: true } });
      }
      return due.length;
    } catch (error) {
      console.error('Failed to scan deal close deadlines:', error);
      return 0;
    }
  },
};
