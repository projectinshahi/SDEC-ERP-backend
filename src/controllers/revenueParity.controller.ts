import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { revenueOpportunityWhere } from '../utils/opportunityRevenue.js';

/**
 * Phase 3 · Stage 3B — REVENUE PARITY DIAGNOSTIC (SuperAdmin-only, read-only).
 *
 * Computes every migrated revenue metric BOTH ways — from the legacy `Deal` table (source of
 * truth pre-migration) and from the Pipeline (`Lead`) revenue-opportunity set — and reports a
 * per-metric MATCH / MISMATCH against real production data. This is the verification gate: run
 * it after each report repoint and before removing the Deals module (Stage 3C). It is additive
 * and touches no business logic; it is deleted alongside the Deal table in 3C.
 *
 * "won/lost/open" is normalized with the SAME rule the 3A migration used, so the two sides are
 * classified identically and the check is faithful to how the data was migrated.
 */

type DealRow = { amount: number | null; status: string | null; stage: string | null; probability: number | null; ownerId: number };
type OppRow = { leadValue: number | null; oppStatus: string | null; stage: string | null; probability: number | null; ownerId: number };

/** Mirror of the migration CASE: a deal/opportunity is won/lost/open by stage-or-status. */
const dealState = (r: DealRow): 'won' | 'lost' | 'open' =>
  r.stage === 'Closed Won' || r.status === 'won' ? 'won'
    : r.stage === 'Closed Lost' || r.status === 'lost' ? 'lost'
      : 'open';
const oppState = (r: OppRow): 'won' | 'lost' | 'open' =>
  r.oppStatus === 'won' ? 'won' : r.oppStatus === 'lost' ? 'lost' : 'open';

const round2 = (n: number) => Math.round(n * 100) / 100;
const cmp = (deal: number, pipeline: number) => ({ deal: round2(deal), pipeline: round2(pipeline), match: round2(deal) === round2(pipeline) });
const cmpNamed = (ownerId: number, deal: number, pipeline: number) => ({ ownerId, ...cmp(deal, pipeline) });

export async function getRevenueParity(_req: Request, res: Response): Promise<void> {
  try {
    // Source side: the whole legacy Deal table.
    const deals = (await prisma.deal.findMany({
      select: { amount: true, status: true, stage: true, probability: true, ownerId: true },
    })) as DealRow[];

    // Migrated side: only Pipeline records that qualify as revenue opportunities.
    const opps = (await prisma.lead.findMany({
      where: revenueOpportunityWhere,
      select: { leadValue: true, oppStatus: true, stage: true, probability: true, ownerId: true },
    })) as OppRow[];

    // Sanity: how many early-stage (non-revenue) leads exist — these MUST be excluded above.
    const totalLeads = await prisma.lead.count();

    // ── Scalar aggregates (JS grouping; groupBy() is avoided — it OOMs tsc in this repo) ──
    const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
    const dWon = deals.filter((d) => dealState(d) === 'won');
    const dOpen = deals.filter((d) => dealState(d) === 'open');
    const dLost = deals.filter((d) => dealState(d) === 'lost');
    const oWon = opps.filter((o) => oppState(o) === 'won');
    const oOpen = opps.filter((o) => oppState(o) === 'open');
    const oLost = opps.filter((o) => oppState(o) === 'lost');

    const overall = {
      counts: {
        dealTotal: deals.length,
        revenueOpportunities: opps.length,
        earlyStageLeadsExcluded: totalLeads - opps.length,
        match: deals.length === opps.length,
      },
      wonRevenue: cmp(sum(dWon, (d) => d.amount || 0), sum(oWon, (o) => o.leadValue || 0)),
      openPipelineValue: cmp(sum(dOpen, (d) => d.amount || 0), sum(oOpen, (o) => o.leadValue || 0)),
      weightedForecast: cmp(
        sum(dOpen, (d) => ((d.amount || 0) * (d.probability ?? 0)) / 100),
        sum(oOpen, (o) => ((o.leadValue || 0) * (o.probability ?? 0)) / 100),
      ),
      wonCount: cmp(dWon.length, oWon.length),
      openCount: cmp(dOpen.length, oOpen.length),
      lostCount: cmp(dLost.length, oLost.length),
    };

    // ── Per-owner won revenue — catches owner-attribution divergence (targets/incentives) ──
    const ownerIds = Array.from(new Set([...deals, ...opps].map((r) => r.ownerId)));
    const perOwnerWonRevenue = ownerIds
      .map((id) => cmpNamed(
        id,
        sum(dWon.filter((d) => d.ownerId === id), (d) => d.amount || 0),
        sum(oWon.filter((o) => o.ownerId === id), (o) => o.leadValue || 0),
      ))
      .filter((r) => !r.match || r.deal !== 0 || r.pipeline !== 0);

    // ── Stage funnel (count + value by stage) ──
    const stages = Array.from(new Set([...deals.map((d) => d.stage), ...opps.map((o) => o.stage)].filter(Boolean))) as string[];
    const stageFunnel = stages.map((st) => ({
      stage: st,
      count: cmp(deals.filter((d) => d.stage === st).length, opps.filter((o) => o.stage === st).length),
      value: cmp(sum(deals.filter((d) => d.stage === st), (d) => d.amount || 0), sum(opps.filter((o) => o.stage === st), (o) => o.leadValue || 0)),
    }));

    const allMatch =
      overall.counts.match &&
      [overall.wonRevenue, overall.openPipelineValue, overall.weightedForecast, overall.wonCount, overall.openCount, overall.lostCount].every((m) => m.match) &&
      perOwnerWonRevenue.every((r) => r.match) &&
      stageFunnel.every((s) => s.count.match && s.value.match);

    res.json({ allMatch, overall, perOwnerWonRevenue, stageFunnel });
  } catch (err) {
    console.error('getRevenueParity error:', err);
    res.status(500).json({ message: 'Failed to compute revenue parity' });
  }
}
