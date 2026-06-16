import prisma from '../config/db.js';

/**
 * Lead Scoring Engine.
 *
 * Computes a 1–100 score from the admin-configured criteria
 * (`lead_scoring_criteria`) and data derivable from the lead. Each active
 * criterion produces a sub-score in [0,1]; the weighted average over all active
 * weights is scaled to 0–100. Missing inputs contribute 0 (so the score
 * gracefully reduces) and the result is always a finite, clamped integer —
 * never NaN/null/undefined.
 */

export type ScoringCriterion = {
  id: number;
  factor: string;
  label: string;
  weight: number;
  isActive: boolean;
};

interface InteractionStats {
  count: number;
  meetingCount: number;
  lastInteractionDays: number | null;
}

interface LeadForScoring {
  source: string | null;
  stage: string | null;
  customer?: { company?: string | null; industry?: string | null } | null;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/** Stage names (or status values) that mean the lead has left the active pipeline. */
export const CLOSED_STATES = [
  'won', 'lost', 'closed', 'closed-won', 'closed-lost', 'closed_won', 'closed_lost',
  'disqualified', 'converted',
];

export const isLeadClosed = (lead: { status?: string | null; stage?: string | null }): boolean => {
  const status = String(lead.status || '').toLowerCase();
  const stage = String(lead.stage || '').toLowerCase();
  return CLOSED_STATES.includes(status) || CLOSED_STATES.includes(stage);
};

/** Maps each known factor key to a sub-score in [0,1]. Unknown → 0. */
function subScore(factor: string, lead: LeadForScoring, stats: InteractionStats): number {
  switch (factor) {
    case 'source_quality': {
      const map: Record<string, number> = {
        website: 1, email: 0.8, phone: 0.7, import: 0.5, manual: 0.3,
      };
      return map[String(lead.source || '').toLowerCase()] ?? 0.3;
    }
    case 'interest_level': {
      const map: Record<string, number> = {
        new: 0.25, contacted: 0.5, interested: 0.8, negotiating: 1,
      };
      return map[String(lead.stage || '').toLowerCase()] ?? 0.25;
    }
    case 'responsiveness': {
      const d = stats.lastInteractionDays;
      if (d === null) return 0;
      if (d <= 3) return 1;
      if (d <= 7) return 0.7;
      if (d <= 14) return 0.4;
      return 0.2;
    }
    case 'interactions':
      return clamp(stats.count / 5, 0, 1);
    case 'meeting_scheduled':
      return stats.meetingCount > 0 ? 1 : 0;
    case 'company_size':
      // We don't capture headcount; presence of a company is a weak positive signal.
      return lead.customer?.company ? 0.6 : 0;
    case 'industry':
      return lead.customer?.industry ? 0.7 : 0;
    case 'budget':
      // No budget field captured yet → always missing (gracefully reduces score).
      return 0;
    default:
      return 0;
  }
}

export interface ScoreBreakdownItem {
  factor: string;
  label: string;
  weight: number;
  subScore: number;
  contribution: number; // points contributed toward the 0–100 score
}

export interface ScoreResult {
  score: number;
  rating: 'Hot' | 'Warm' | 'Cold' | 'Not Scored';
  breakdown: ScoreBreakdownItem[];
}

export const ratingFor = (score: number): ScoreResult['rating'] => {
  if (!Number.isFinite(score) || score <= 0) return 'Not Scored';
  if (score >= 80) return 'Hot';
  if (score >= 50) return 'Warm';
  return 'Cold';
};

/** Pure computation given criteria + lead + interaction stats. */
export function computeScore(
  criteria: ScoringCriterion[],
  lead: LeadForScoring,
  stats: InteractionStats,
): ScoreResult {
  const active = criteria.filter((c) => c.isActive && Number(c.weight) > 0);
  const totalWeight = active.reduce((sum, c) => sum + Number(c.weight || 0), 0);

  if (totalWeight <= 0) {
    return { score: 0, rating: 'Not Scored', breakdown: [] };
  }

  const breakdown: ScoreBreakdownItem[] = active.map((c) => {
    const sub = clamp(subScore(c.factor, lead, stats), 0, 1);
    const contribution = (Number(c.weight) * sub) / totalWeight * 100;
    return {
      factor: c.factor,
      label: c.label,
      weight: Number(c.weight),
      subScore: Math.round(sub * 100) / 100,
      contribution: Math.round(contribution * 10) / 10,
    };
  });

  const raw = breakdown.reduce((sum, b) => sum + b.contribution, 0);
  const score = Number.isFinite(raw) ? clamp(Math.round(raw), 0, 100) : 0;

  return { score, rating: ratingFor(score), breakdown };
}

/** Loads interaction stats for a lead (count, meetings, recency in days). */
async function getInteractionStats(leadId: number): Promise<InteractionStats> {
  const interactions = await prisma.leadInteraction.findMany({
    where: { leadId },
    select: { type: true, interactionDate: true },
    orderBy: { interactionDate: 'desc' },
  });

  const count = interactions.length;
  const meetingCount = interactions.filter((i) => i.type === 'Meeting').length;

  let lastInteractionDays: number | null = null;
  if (interactions[0]?.interactionDate) {
    const diffMs = Date.now() - new Date(interactions[0].interactionDate).getTime();
    lastInteractionDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }

  return { count, meetingCount, lastInteractionDays };
}

export const leadScoringService = {
  /** Returns all configured criteria ordered by weight desc. */
  async getCriteria(): Promise<ScoringCriterion[]> {
    return prisma.leadScoringCriterion.findMany({ orderBy: [{ isActive: 'desc' }, { weight: 'desc' }] });
  },

  /** Computes (without persisting) the full breakdown for a lead. */
  async computeForLead(leadId: number): Promise<ScoreResult & { leadId: number }> {
    const [criteria, lead, stats] = await Promise.all([
      this.getCriteria(),
      prisma.lead.findUnique({
        where: { id: leadId },
        select: { source: true, stage: true, customer: { select: { company: true, industry: true } } },
      }),
      getInteractionStats(leadId),
    ]);

    if (!lead) return { leadId, score: 0, rating: 'Not Scored', breakdown: [] };
    return { leadId, ...computeScore(criteria, lead, stats) };
  },

  /**
   * Recomputes and persists the score for a lead. Safe to call from any trigger
   * (lead update, source/stage change, interaction added, assignment change).
   * Never throws — scoring must not break the calling mutation.
   */
  async recomputeLeadScore(leadId: number): Promise<number> {
    try {
      const result = await this.computeForLead(leadId);
      await prisma.lead.update({ where: { id: leadId }, data: { score: result.score } });
      return result.score;
    } catch (error) {
      console.error(`Failed to recompute score for lead ${leadId}:`, error);
      return 0;
    }
  },

  /**
   * Recomputes scores for all non-closed leads. Used (fire-and-forget) after an
   * admin changes the scoring criteria so stored scores/analytics stay in sync
   * with the live breakdown. Never throws.
   */
  async recomputeAllOpenLeads(): Promise<void> {
    try {
      const leads = await prisma.lead.findMany({
        where: { status: { notIn: CLOSED_STATES }, stage: { notIn: CLOSED_STATES } },
        select: { id: true },
      });
      for (const { id } of leads) {
        await this.recomputeLeadScore(id);
      }
    } catch (error) {
      console.error('Failed to recompute all open leads:', error);
    }
  },
};
