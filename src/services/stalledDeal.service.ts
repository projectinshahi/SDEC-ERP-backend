import prisma from '../config/db.js';
import { activityService } from './activity.service.js';
import { notificationService } from './notification.service.js';
import { CLOSED_DEAL_STAGES } from './dealEvent.service.js';

/**
 * SE-021 — Stalled Deal Engine.
 *
 * A deal is "stalled" when it sits in a pipeline stage longer than that stage's
 * configurable threshold (deal_stages.stalled_threshold_days) without a stage
 * change. "At Risk" is the warning band just before the threshold. Closed Won /
 * Closed Lost deals are never stalled (SE-021.2 exclusions).
 *
 * Reuses the shared activity-log + notification services rather than building a
 * parallel alerting system. The stage clock (Deal.lastStageChangeAt) is reset
 * by the deal stage-transition path; this engine only reads it.
 */

const DAY = 24 * 60 * 60 * 1000;

export type StalledLevel = 'healthy' | 'at_risk' | 'stalled';

export interface StalledStatus {
  level: StalledLevel;
  daysInStage: number;
  thresholdDays: number;
  since: string;
}

type DealClock = {
  stage: string;
  status: string;
  lastStageChangeAt: Date | null;
  createdAt: Date;
};

/**
 * Pure computation: derive a deal's stall status from its stage clock and the
 * stage's threshold. "At Risk" begins at 70% of the threshold. Exposed so the
 * pipeline/BDE controllers can annotate deal cards without a DB write.
 */
export function computeStalledStatus(
  deal: DealClock,
  thresholdByStage: Record<string, number>,
  now: Date = new Date(),
): StalledStatus {
  const since = deal.lastStageChangeAt ?? deal.createdAt;
  const daysInStage = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY));
  const thresholdDays = thresholdByStage[deal.stage] ?? 14;
  const closed =
    CLOSED_DEAL_STAGES.includes(deal.stage) || deal.status === 'won' || deal.status === 'lost';

  let level: StalledLevel = 'healthy';
  if (!closed) {
    if (daysInStage >= thresholdDays) level = 'stalled';
    else if (daysInStage >= Math.ceil(thresholdDays * 0.7)) level = 'at_risk';
  }
  return { level, daysInStage, thresholdDays, since: new Date(since).toISOString() };
}

export const stalledDealService = {
  /** Map of stage name → stalled threshold (days). */
  async getThresholdMap(): Promise<Record<string, number>> {
    const stages = await prisma.dealStage.findMany();
    const map: Record<string, number> = {};
    for (const s of stages) map[s.name] = s.stalledThresholdDays;
    return map;
  },

  /** Active Sales Managers + Admins — the "reporting manager" recipients. */
  async getManagerIds(): Promise<number[]> {
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
    return managers.map((m) => m.id);
  },

  /**
   * SE-021.1 + SE-021.2 — flag deals past their stage threshold and notify the
   * owner + reporting managers exactly once per stall window. Logs a
   * `deal_stalled` activity the first time a deal trips. Re-clears the flag if a
   * deal is no longer stalled (e.g. its threshold was raised). Returns the count
   * of deals newly alerted on this pass.
   */
  async scanStalledDeals(): Promise<number> {
    try {
      const thresholds = await this.getThresholdMap();
      const deals = await prisma.deal.findMany({
        where: {
          stage: { notIn: CLOSED_DEAL_STAGES },
          status: { notIn: ['won', 'lost'] },
        },
        select: {
          id: true,
          title: true,
          stage: true,
          status: true,
          ownerId: true,
          lastStageChangeAt: true,
          createdAt: true,
          stalled: true,
          stalledNotifiedAt: true,
        },
      });

      const now = new Date();
      const managerIds = await this.getManagerIds();
      let alerted = 0;

      for (const deal of deals) {
        const s = computeStalledStatus(deal, thresholds, now);

        if (s.level === 'stalled') {
          if (!deal.stalled) {
            await prisma.deal.update({ where: { id: deal.id }, data: { stalled: true } });
            await activityService.logActivity({
              actorUserId: deal.ownerId,
              dealId: deal.id,
              type: 'deal_stalled',
              description: `Deal "${deal.title}" stalled — no movement in ${deal.stage} for ${s.daysInStage} day(s).`,
            });
          }

          // One alert per stall window (cleared when the deal next moves stage).
          if (!deal.stalledNotifiedAt) {
            const recipients = new Set<number>([deal.ownerId, ...managerIds]);
            await notificationService.createNotifications([...recipients], {
              type: 'escalation',
              title: 'Deal stalled',
              message: `"${deal.title}" has had no movement in ${deal.stage} for ${s.daysInStage} days.`,
              entityType: 'deal',
              entityId: deal.id,
            });
            await prisma.deal.update({ where: { id: deal.id }, data: { stalledNotifiedAt: now } });
            alerted++;
          }
        } else if (deal.stalled) {
          // Recovered without a stage move (threshold change) — clear the flag.
          await prisma.deal.update({
            where: { id: deal.id },
            data: { stalled: false, stalledNotifiedAt: null },
          });
        }
      }

      return alerted;
    } catch (error) {
      console.error('Failed to scan stalled deals:', error);
      return 0;
    }
  },
};
