import type { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { can, type SalesAuthContext } from '../utils/salesAuth.js';

/**
 * MK-004.2 / .3 / .4 / .5 / .6 — the Marketing finance business rules, in ONE
 * place.
 *
 * Everything that reads money goes through here: the expense list, the cost
 * dashboard, the approval queue, the campaign/influencer trackers and both
 * exports. That is deliberate — the alternative (each endpoint building its own
 * filter) is how a UI total and an exported total come to disagree.
 *
 * Nothing in this file writes a monetary threshold as a literal; both live in
 * the single `marketing_finance_settings` row.
 */

/* ── Permission keys ───────────────────────────────────────────────────────────
 * All pre-existing keys from the Marketing tree in Role Management. Expense
 * VIEW rides the same key as the MK-004.1 dashboard it shares its data with,
 * OR the module's coarse financial key — the granular-OR-coarse pattern this
 * module already uses elsewhere. */
export const EXPENSE_VIEW_KEYS = ['marketing.costs.view', 'marketing.financials.view'] as const;
export const EXPENSE_CREATE_KEYS = ['marketing.expenses.create', 'marketing.costs.manage'] as const;
export const EXPENSE_EDIT_KEYS = ['marketing.expenses.edit', 'marketing.costs.manage'] as const;
export const EXPENSE_DELETE_KEY = 'marketing.expenses.delete';
/** Approval is its own authority and is NEVER implied by create/edit — the same
 *  1:1 rule the module already applies to content.approve and assets.approve. */
export const EXPENSE_APPROVE_KEY = 'marketing.expenses.approve';
export const REPORT_EXPORT_KEYS = ['marketing.reports.export', 'marketing.reports.download'] as const;
export const CAMPAIGN_VIEW_KEYS = ['marketing.campaigns.view', 'marketing.financials.view'] as const;
export const CAMPAIGN_CREATE_KEYS = ['marketing.campaigns.create', 'marketing.campaigns.edit'] as const;
export const CAMPAIGN_EDIT_KEY = 'marketing.campaigns.edit';
export const CAMPAIGN_DELETE_KEY = 'marketing.campaigns.delete';
export const SETTINGS_KEY = 'marketing.settings.manage';

export const canAny = (ctx: SalesAuthContext, keys: readonly string[]): boolean =>
  keys.some((k) => can(ctx, k));

/* ── Status vocabularies — one definition each ─────────────────────────────── */
export const APPROVAL_STATUSES = ['approved', 'pending', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Which payment states count as money spent.
 *
 * `cancelled` does not: the payout is not happening, so including it would
 * overstate client spend. `pending` DOES — it is a committed, agreed fee, which
 * is the same treatment the expense dashboard gives an approved-but-unpaid
 * expense. Exported here so the tracker, the dashboard and the export cannot
 * each decide differently.
 */
export const SPEND_COUNTING_PAYMENT_STATUSES: readonly PaymentStatus[] = ['pending', 'paid'];

/* ── Thresholds ────────────────────────────────────────────────────────────── */
export interface FinanceSettings {
  /** At or below this, an expense is auto-approved. Above it, a manager decides. */
  approvalThreshold: number;
  /** At or above this, the UI asks the submitter to confirm before saving. */
  largeExpenseThreshold: number;
}

/**
 * The single source of truth. Reads the one settings row; if it is somehow
 * missing, the row is created with the schema defaults rather than a number
 * being invented here.
 */
export async function getFinanceSettings(): Promise<FinanceSettings> {
  const row = await prisma.marketing_finance_settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
    select: { approval_threshold: true, large_expense_threshold: true },
  });
  return {
    approvalThreshold: Number(row.approval_threshold),
    largeExpenseThreshold: Number(row.large_expense_threshold),
  };
}

export async function updateFinanceSettings(patch: Partial<FinanceSettings>): Promise<FinanceSettings> {
  const data: Record<string, unknown> = { updated_at: new Date() };
  if (patch.approvalThreshold !== undefined) data.approval_threshold = patch.approvalThreshold;
  if (patch.largeExpenseThreshold !== undefined) data.large_expense_threshold = patch.largeExpenseThreshold;
  await prisma.marketing_finance_settings.upsert({
    where: { id: 1 }, update: data, create: { id: 1, ...data },
  });
  return getFinanceSettings();
}

/**
 * MK-004.3 routing rule, in one function so the submit path and any later
 * re-submit path cannot diverge: at or below the threshold is auto-approved,
 * strictly above it needs a decision.
 */
export const resolveApprovalStatus = (amount: number, s: FinanceSettings): ApprovalStatus =>
  amount > s.approvalThreshold ? 'pending' : 'approved';

/* ── Money ─────────────────────────────────────────────────────────────────── */
/**
 * Round to paise. `amount` is a Float column (pre-existing; changing it would be
 * a destructive migration of live Finance data), so every value is snapped to
 * 2dp at the boundary and totals are summed from those snapped values — the
 * table, the chart, the dashboard and the export therefore all add up the same
 * numbers rather than each rounding a different accumulated float.
 */
export const money = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/* ── Dates ─────────────────────────────────────────────────────────────────── */
/**
 * A REAL calendar date in 'YYYY-MM-DD'.
 *
 * The shape check alone is not enough: '2026-13-45' matches the pattern, and
 * `new Date('2026-13-45T00:00:00.000Z')` is an Invalid Date, which Prisma then
 * either rejects at the driver or stores as a null-ish column. The round trip
 * below rejects any month/day that does not exist (including 2025-02-30), so a
 * value that reaches the database is always a date a person actually picked.
 */
export const isYmd = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  // Invalid dates stringify back differently (or not at all), so comparing the
  // normalised ISO day catches both out-of-range and rolled-over values.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** 'YYYY-MM-DD' → UTC midnight. Matches how every other Marketing date column is
 *  written, so a date read back is the date that was picked. */
export const ymdToDate = (ymd: string): Date => new Date(`${ymd.trim()}T00:00:00.000Z`);
export const dateToYmd = (d: Date | null | undefined): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null;

/* ── Expense querying — THE shared filter ──────────────────────────────────── */
export interface ExpenseFilter {
  clientId?: number | null;
  projectId?: number | null;
  category?: string | null;
  approvalStatus?: ApprovalStatus | 'all' | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
}

/**
 * Build the Prisma `where` for expenses.
 *
 * `approvedOnly` is the reporting rule from MK-004.3: the cost dashboard and the
 * MK-004.6 export count APPROVED rows only, so a pending or rejected submission
 * can never inflate a client's production cost. The expense LIST passes false
 * because its whole job is to show submissions in every state.
 */
export function buildExpenseWhere(f: ExpenseFilter, approvedOnly: boolean): Prisma.FinanceExpenseWhereInput {
  const where: Prisma.FinanceExpenseWhereInput = {};

  // A client is always pinned: an unscoped query would total every client's
  // spend into one figure.
  if (f.clientId) where.clientId = f.clientId;
  if (f.projectId) where.projectId = f.projectId;
  if (f.category) where.category = f.category;

  if (approvedOnly) {
    where.approvalStatus = 'approved';
  } else if (f.approvalStatus && f.approvalStatus !== 'all') {
    where.approvalStatus = f.approvalStatus;
  }

  if (isYmd(f.from) || isYmd(f.to)) {
    where.expenseDate = {
      ...(isYmd(f.from) ? { gte: ymdToDate(f.from!) } : {}),
      ...(isYmd(f.to) ? { lte: ymdToDate(f.to!) } : {}),
    };
  }

  const q = (f.search ?? '').trim();
  if (q) {
    // Case-insensitive partial match, the app's existing search semantics.
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { vendor: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

export interface ExpenseRow {
  id: number;
  title: string;
  category: string;
  vendor: string | null;
  amount: number;
  date: string | null;
  approvalStatus: string;
  paymentStatus: string;
  notes: string | null;
  clientId: number | null;
  projectId: number | null;
  projectName: string | null;
  submittedBy: number | null;
  submittedByName: string | null;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  receiptUrl: string | null;
  receiptName: string | null;
}

const EXPENSE_SELECT = {
  id: true, title: true, category: true, vendor: true, amount: true,
  expenseDate: true, approvalStatus: true, status: true, notes: true,
  clientId: true, projectId: true, submittedBy: true, decidedBy: true,
  decidedAt: true, decisionNote: true, receiptUrl: true, receiptName: true,
} as const;

/**
 * Load expenses and resolve their user/project names.
 *
 * `take` is optional ON PURPOSE: the UI list passes a page size, the export
 * passes none so a report is never silently truncated to a screenful.
 * Names are resolved with two batched lookups rather than per-row queries (N+1).
 */
export async function loadExpenses(
  where: Prisma.FinanceExpenseWhereInput,
  take?: number,
  skip?: number,
): Promise<ExpenseRow[]> {
  const rows = await prisma.financeExpense.findMany({
    where,
    select: EXPENSE_SELECT,
    orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
    ...(take ? { take } : {}),
    ...(skip ? { skip } : {}),
  });

  const userIds = [...new Set(rows.flatMap((r) => [r.submittedBy, r.decidedBy]).filter((v): v is number => !!v))];
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((v): v is number => !!v))];

  const [users, projects] = await Promise.all([
    userIds.length
      ? prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: number; name: string }[]),
    projectIds.length
      ? prisma.marketing_projects.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    vendor: r.vendor,
    amount: money(Number(r.amount)),
    date: dateToYmd(r.expenseDate),
    approvalStatus: r.approvalStatus,
    paymentStatus: r.status,
    notes: r.notes,
    clientId: r.clientId,
    projectId: r.projectId,
    projectName: r.projectId ? projectName.get(r.projectId) ?? null : null,
    submittedBy: r.submittedBy,
    submittedByName: r.submittedBy ? userName.get(r.submittedBy) ?? null : null,
    decidedBy: r.decidedBy,
    decidedByName: r.decidedBy ? userName.get(r.decidedBy) ?? null : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    receiptUrl: r.receiptUrl,
    receiptName: r.receiptName,
  }));
}

export interface CategoryTotal { name: string; amount: number; count: number; percent: number }

/**
 * Category breakdown + grand total, derived from the SAME rows the caller is
 * about to render or export. The dashboard chart, the breakdown table, the
 * Excel sheet and the PDF all call this, which is what keeps their totals equal.
 */
export function summarize(rows: { amount: number; category: string }[]): {
  total: number; categories: CategoryTotal[];
} {
  const byCategory = new Map<string, { amount: number; count: number }>();
  let total = 0;
  for (const r of rows) {
    const amount = money(r.amount);
    total += amount;
    const key = (r.category || 'general').trim() || 'general';
    const cur = byCategory.get(key) ?? { amount: 0, count: 0 };
    cur.amount += amount;
    cur.count += 1;
    byCategory.set(key, cur);
  }
  total = money(total);
  const categories = [...byCategory.entries()]
    .map(([name, v]) => ({
      name,
      amount: money(v.amount),
      count: v.count,
      percent: total > 0 ? Math.round((v.amount / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  return { total, categories };
}

/* ── MK-004.4 derived campaign metrics ─────────────────────────────────────── */
export interface CampaignMetrics {
  /** null = NOT COMPUTABLE (no leads yet). Never Infinity, never a made-up 0. */
  cpl: number | null;
  cpc: number | null;
  ctr: number | null;
  roi: number | null;
  overBudget: boolean;
  budgetUsedPercent: number | null;
}

/**
 * Derive every campaign rate from the raw stored counters.
 *
 * Division by zero returns `null`, which the UI renders as '—'. Returning 0 or
 * Infinity would both be lies: one says "costs nothing per lead", the other is
 * not a number a person can read.
 */
export function campaignMetrics(c: {
  budget: number; spend: number; impressions: number; clicks: number; leads: number; revenue: number;
}): CampaignMetrics {
  const spend = money(c.spend);
  const budget = money(c.budget);
  const div = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 100) / 100 : null;

  return {
    cpl: div(spend, c.leads),
    cpc: div(spend, c.clicks),
    ctr: c.impressions > 0 ? Math.round((c.clicks / c.impressions) * 10000) / 100 : null,
    // ROI as a percentage of spend. Undefined with no spend — not 0%.
    roi: spend > 0 ? Math.round(((money(c.revenue) - spend) / spend) * 10000) / 100 : null,
    // A budget of 0 means "not set", so it is not treated as instantly overspent.
    overBudget: budget > 0 && spend > budget,
    budgetUsedPercent: budget > 0 ? Math.round((spend / budget) * 1000) / 10 : null,
  };
}
