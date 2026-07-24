import type { Prisma } from '@prisma/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Opportunity revenue — single source of truth (Phase 3, Stage 3B).
 *
 * After the Deal entity was folded into Pipeline (Lead), reports/targets/incentives/
 * dashboards/analytics must NOT count every Pipeline record. Only opportunities that
 * represent committed revenue — the ones that used to be "Deals" — contribute to revenue
 * math. Early-stage leads (New … Proposal) stay visible in the Pipeline module but never
 * inflate any revenue number.
 *
 * Every revenue read-site imports `revenueOpportunityWhere` / `revenueOpportunity()` so the
 * definition can never drift between sites. Field mapping from the old Deal columns:
 *   Deal.amount   → Lead.leadValue      Deal.status → Lead.oppStatus (open|won|lost)
 *   Deal.closedAt → Lead.closedAt       Deal.stage/probability/expectedCloseDate → same names
 *   Deal.projectId→ Lead.oppProjectId
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Pipeline stages that represent committed revenue opportunities in the standardized 8-stage
 * funnel (NQL→MQL→SQL→PQL→SAL→WON→HOLD→LOST). SAL (Sales-Accepted Lead) is the point a lead
 * becomes a committed sales opportunity — the boundary the old "Deal" stages mapped onto —
 * plus the terminal states. Earlier funnel stages (NQL/MQL/SQL/PQL) are pre-revenue and never
 * counted. NOTE: exact parity with the historical deal set rides on the `migratedFromDealId`
 * marker below; this stage list is the go-forward rule for opportunities born in the Pipeline.
 */
export const REVENUE_STAGES = ['SAL', 'WON', 'HOLD', 'LOST'] as const;

/**
 * A Lead (Opportunity) is a REVENUE opportunity iff it was migrated from a historical Deal
 * — which gives exact 1:1 parity with the pre-migration deal set regardless of stage naming —
 * OR it has advanced to a revenue-qualifying stage (the go-forward rule for opportunities
 * created directly in the Pipeline after the Deals module is retired).
 *
 * IMPORTANT: always AND this gate into revenue aggregates. `oppStatus` defaults to 'open' on
 * EVERY lead, so filtering by oppStatus alone would sweep in early-stage leads and inflate the
 * open-pipeline totals — exactly what this gate prevents.
 */
export const revenueOpportunityWhere: Prisma.LeadWhereInput = {
  OR: [
    { migratedFromDealId: { not: null } },
    { stage: { in: [...REVENUE_STAGES] } },
  ],
};

/** Compose the revenue-opportunity gate with additional constraints (owner/date/status/…). */
export const revenueOpportunity = (extra?: Prisma.LeadWhereInput): Prisma.LeadWhereInput =>
  extra ? { AND: [revenueOpportunityWhere, extra] } : revenueOpportunityWhere;

/** Raw-SQL equivalent of the gate, for report sites that use `$queryRaw` against "Lead". */
export const REVENUE_OPP_SQL = `(migrated_from_deal_id IS NOT NULL OR stage IN (${REVENUE_STAGES.map((s) => `'${s}'`).join(', ')}))`;
