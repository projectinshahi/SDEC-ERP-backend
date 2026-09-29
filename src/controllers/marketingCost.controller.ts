import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { getSalesAuth, can } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import {
  buildExpenseWhere, loadExpenses, summarize, money, campaignMetrics,
  canAny, isYmd, EXPENSE_VIEW_KEYS, EXPENSE_CREATE_KEYS, REPORT_EXPORT_KEYS,
} from '../services/marketingFinance.service.js';
import { influencerSpendForClient } from './marketingExpenseExport.controller.js';

/**
 * MK-004.1 — production cost dashboard, per client.
 *
 * Reads the EXISTING `finance_expense` table (no second expense system). Sprint
 * 2 added nullable client_id/project_id to it; rows without a client are Finance
 * module costs and are simply never attributed to a Marketing client.
 *
 * BUDGET: this codebase has no budget model of any kind — no table, no column,
 * no setting. The dashboard therefore reports `budget: null` meaning "not
 * configured", and the UI shows that as an explicit empty state. Inventing a
 * number here would be fabricating financial data.
 */

const uid = (req: Request) => Number((req as any).userId);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Seeing production costs is a financial view, kept separate from operational
 *  Marketing access so a role can be given one without the other. */
export const COST_VIEW_KEY = 'marketing.costs.view';
export const COST_LOG_KEY = 'marketing.costs.manage';

const ymdToDate = (ymd: string): Date => new Date(`${ymd.trim()}T00:00:00.000Z`);

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/costs?clientId=&from=&to=
// ─────────────────────────────────────────────────────────────────────────────
export const getClientCosts = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    // The coarse financial key now also opens this view, matching the expense
    // logger it shares its data with.
    if (!can(ctx, COST_VIEW_KEY) && !canAny(ctx, EXPENSE_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing production costs.' });
    }

    const clients = await prisma.marketing_clients.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });

    const canLog = can(ctx, COST_LOG_KEY) || canAny(ctx, EXPENSE_CREATE_KEYS);
    const canExport = canAny(ctx, REPORT_EXPORT_KEYS);

    const clientId = intId(req.query.clientId);
    if (!clientId) {
      // No client chosen yet — return the selector only, not a total across
      // every client, which would leak an org-wide figure by accident.
      return res.json({
        success: true, clients, client: null, canLog, canExport,
        totalSpend: 0, budget: null, currency: 'INR', categories: [], expenses: [],
        campaignSpend: null, influencerSpend: null,
      });
    }

    const client = clients.find((c) => c.id === clientId);
    // Same answer for "no such client" and "not an active client": probing ids
    // must not reveal which clients exist.
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    const from = isYmd(str(req.query.from)) ? str(req.query.from) : null;
    const to = isYmd(str(req.query.to)) ? str(req.query.to) : null;
    if (from && to && to < from) {
      return res.status(400).json({
        error: 'The end date cannot be earlier than the start date.',
        fieldErrors: { to: 'The end date cannot be earlier than the start date.' },
      });
    }

    /* MK-004.3 reporting rule: APPROVED expenses only. A pending or rejected
     * submission must never inflate a client's production cost. The filter comes
     * from the shared builder that the expense list and both exports also use,
     * so the dashboard total and the exported total are the same number by
     * construction rather than by coincidence. */
    const where = buildExpenseWhere({ clientId, from, to }, true);
    const rows = await loadExpenses(where);
    const { total: totalSpend, categories } = summarize(rows);

    /* MK-004.4 / MK-004.5 — media spend recorded in the trackers, reported
     * ALONGSIDE logged expenses rather than copied into finance_expense. One
     * amount, one row, two readers; nothing is double counted because the
     * trackers never write an expense row. */
    const campaignWhere: Prisma.marketing_ad_campaignsWhereInput = { client_id: clientId };
    if (to) campaignWhere.start_date = { lte: ymdToDate(to) };
    if (from) campaignWhere.end_date = { gte: ymdToDate(from) };
    const [campaignRows, influencerSpend] = await Promise.all([
      prisma.marketing_ad_campaigns.findMany({
        where: campaignWhere,
        select: { budget: true, spend: true, impressions: true, clicks: true, leads: true, revenue: true },
      }),
      influencerSpendForClient(clientId, from, to),
    ]);
    const campaignTotals = campaignRows.reduce(
      (a, c) => ({
        budget: a.budget + Number(c.budget), spend: a.spend + Number(c.spend),
        impressions: a.impressions + Number(c.impressions), clicks: a.clicks + Number(c.clicks),
        leads: a.leads + Number(c.leads), revenue: a.revenue + Number(c.revenue),
      }),
      { budget: 0, spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0 },
    );

    return res.json({
      success: true,
      clients,
      client,
      canLog,
      canExport,
      totalSpend,
      /* null = NOT CONFIGURED. There is no budget model for production costs in
       * this system; the UI renders this as an explicit "no budget set" state
       * rather than 0, which would read as "budget of zero" and imply 100%
       * overspend. Ad campaigns carry their own per-campaign budget, reported
       * separately below. */
      budget: null,
      variance: null,
      currency: 'INR',
      categories,
      expenses: rows,
      campaignSpend: {
        budget: money(campaignTotals.budget),
        spend: money(campaignTotals.spend),
        leads: campaignTotals.leads,
        count: campaignRows.length,
        ...campaignMetrics(campaignTotals),
      },
      influencerSpend,
      // The figure a reader should quote as "what this client has cost".
      combinedSpend: money(totalSpend + campaignTotals.spend + influencerSpend.committed),
    });
  } catch (error) {
    console.error('Error loading client costs:', error);
    return res.status(500).json({ error: 'Failed to load production costs' });
  }
};

/**
 * POST /marketing/costs — kept as the costs page's quick-log entry point, but it
 * is now the SAME handler as the MK-004.2 Expense Logger.
 *
 * It used to be a second, near-identical create path with its own validation and
 * no knowledge of the approval threshold, which meant a cost logged here skipped
 * the MK-004.3 workflow entirely. Re-exporting the one creator removes that
 * divergence: one validator, one threshold rule, one audit event, whichever
 * screen the user started from.
 */
export { createExpense as logClientCost } from './marketingExpense.controller.js';
