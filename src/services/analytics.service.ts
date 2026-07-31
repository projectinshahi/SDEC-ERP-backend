import prisma from '../config/db.js';
import { targetService, type PeriodType } from './target.service.js';
import { canViewOrgReports, type SalesAuthContext } from '../utils/salesAuth.js';

/**
 * Sales Reporting analytics engine.
 *
 * The single source of metric math for the NEW reporting layer (SE-030..036,
 * SE-044.2, Executive). Every function is scope-aware (owner-id list or null =
 * org-wide) and period-aware. Win/loss predicates and the weighting formula are
 * defined ONCE here and mirror deal.controller, so reports and dashboards never
 * diverge. Existing shipped analytics endpoints are intentionally left untouched.
 */

export interface Window {
  start: Date;
  end: Date;
}
/** Owner scope: an explicit owner-id list, or null for "all owners" (org-wide). */
export type Scope = number[] | null;

const isWon = (d: { stage: string; status: string }) => d.stage === 'Closed Won' || d.status === 'won';
const isLost = (d: { stage: string; status: string }) => d.stage === 'Closed Lost' || d.status === 'lost';
const isOpen = (d: { stage: string; status: string }) => !isWon(d) && !isLost(d);

const round1 = (n: number) => Math.round(n * 10) / 10;
const weighted = (amount: number, prob: number) =>
  Math.round((amount || 0) * (Math.max(0, Math.min(100, prob || 0)) / 100));

/** Prisma `where` fragment for an owner scope ([-1] forces an empty result for an empty list). */
function ownerWhere(scope: Scope): Record<string, any> {
  return scope === null ? {} : { ownerId: { in: scope.length ? scope : [-1] } };
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

async function ownerNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const users = await prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** owner-id → {teamId, name} for active (non-archived) team memberships. */
async function ownerTeamMap(): Promise<Map<number, { teamId: number; name: string }>> {
  const members = await prisma.salesTeamMember.findMany({
    include: { team: { select: { id: true, name: true, archived: true } } },
  });
  const m = new Map<number, { teamId: number; name: string }>();
  for (const mem of members) if (mem.team && !mem.team.archived) m.set(mem.userId, { teamId: mem.team.id, name: mem.team.name });
  return m;
}

// ── BDE-wise lead pipeline (Pipeline Report → "BDE Pipeline Summary") ─────────
// ponytail: Y (checklist item count per into-stage transition) mirrors the
// frontend single source erp-frontend/lib/data/stageTransitionChecklists.ts.
// The two packages share no code, so keep these counts in sync if that config's
// item lists change. NQL is the entry stage (no into-transition → no checklist).
const STAGE_CHECKLIST_TOTALS: Record<string, number> = {
  NQL: 0, MQL: 4, SQL: 6, PQL: 5, SAL: 4, WON: 4, HOLD: 4, LOST: 5,
};

export interface BdePipelineLead {
  leadId: number; title: string; company: string; stage: string;
  checklistDone: number; checklistTotal: number;
}
export interface BdePipelineOwner {
  ownerId: number; name: string; totalLeads: number;
  byStage: { stage: string; count: number }[];
  leads: BdePipelineLead[];
}

/**
 * Groups the in-scope leads by owner (BDE), with per-stage counts and each lead's
 * current stage + checklist progress. Same owner scope + period window as the
 * Pipeline Report it augments (window applied to Lead.createdAt). Checklist "done"
 * (X) is the number of items checked on the most recent Stage Transition into the
 * lead's CURRENT stage — read from the existing `stage_changed` activity metadata,
 * NOT a new checklist store. "Total" (Y) comes from STAGE_CHECKLIST_TOTALS above.
 */
async function computeBdePipeline(scope: Scope, window?: Window): Promise<BdePipelineOwner[]> {
  const where: Record<string, any> = { ...ownerWhere(scope) };
  if (window) where.createdAt = { gte: window.start, lt: window.end };

  const [leads, stages] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: { id: true, title: true, stage: true, ownerId: true, customer: { select: { company: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' }, select: { name: true } }),
  ]);
  if (leads.length === 0) return [];

  // Latest checked-checklist count per lead — the most recent stage_changed
  // activity whose target stage matches the lead's CURRENT stage (one query).
  const stageByLead = new Map(leads.map((l) => [l.id, l.stage]));
  const acts = await prisma.activity_logs.findMany({
    where: { lead_id: { in: leads.map((l) => l.id) }, type: 'stage_changed' },
    select: { lead_id: true, metadata: true },
    orderBy: { created_at: 'desc' },
  });
  const doneByLead = new Map<number, number>();
  for (const a of acts) {
    if (a.lead_id == null || doneByLead.has(a.lead_id)) continue; // desc → first match is latest
    const m = (a.metadata ?? {}) as any;
    if (m.toStage && m.toStage === stageByLead.get(a.lead_id)) {
      doneByLead.set(a.lead_id, Array.isArray(m.checklist) ? m.checklist.length : 0);
    }
  }

  const names = await ownerNames(Array.from(new Set(leads.map((l) => l.ownerId).filter((x): x is number => x != null))));
  const totalFor = (stage: string) => STAGE_CHECKLIST_TOTALS[(stage || '').toUpperCase()] ?? 0;

  // Group by owner, preserving the createdAt-desc order within each BDE's lead list.
  const byOwnerId = new Map<number, typeof leads>();
  for (const l of leads) {
    const oid = l.ownerId ?? -1;
    (byOwnerId.get(oid) ?? byOwnerId.set(oid, []).get(oid)!).push(l);
  }

  return Array.from(byOwnerId.entries())
    .map(([ownerId, own]) => ({
      ownerId,
      name: ownerId === -1 ? 'Unassigned' : names.get(ownerId) || 'Unassigned',
      totalLeads: own.length,
      byStage: stages
        .map((s) => ({ stage: s.name, count: own.filter((l) => l.stage === s.name).length }))
        .filter((s) => s.count > 0),
      leads: own.map((l) => ({
        leadId: l.id,
        title: l.title,
        company: l.customer?.company || '—',
        stage: l.stage,
        checklistDone: doneByLead.get(l.id) ?? 0,
        checklistTotal: totalFor(l.stage),
      })),
    }))
    .sort((a, b) => b.totalLeads - a.totalLeads);
}

// ── SE-034 Pipeline Summary ──────────────────────────────────────────────────
export async function computePipelineSummary(scope: Scope, window?: Window) {
  const deals = await prisma.deal.findMany({
    where: ownerWhere(scope),
    select: { amount: true, probability: true, stage: true, status: true, ownerId: true, closedAt: true },
  });
  const stages = await prisma.dealStage.findMany({ orderBy: { orderIndex: 'asc' } });
  const inWin = (d: { closedAt: Date | null }) => !window || (!!d.closedAt && d.closedAt >= window.start && d.closedAt < window.end);

  const open = deals.filter(isOpen);
  const won = deals.filter((d) => isWon(d) && inWin(d));
  const lost = deals.filter((d) => isLost(d) && inWin(d));

  const byStage = stages.map((s) => {
    const inStage = deals.filter((d) => d.stage === s.name);
    return {
      stage: s.name,
      orderIndex: s.orderIndex,
      count: inStage.length,
      value: inStage.reduce((a, d) => a + (d.amount || 0), 0),
      weightedForecast: inStage.reduce((a, d) => a + weighted(d.amount, d.probability), 0),
    };
  });

  const ownerIds = Array.from(new Set(deals.map((d) => d.ownerId)));
  const names = await ownerNames(ownerIds);
  const byOwner = ownerIds
    .map((oid) => {
      const od = deals.filter((d) => d.ownerId === oid);
      const odOpen = od.filter(isOpen);
      return {
        ownerId: oid,
        name: names.get(oid) || 'Unassigned',
        openCount: odOpen.length,
        pipelineValue: odOpen.reduce((a, d) => a + (d.amount || 0), 0),
        forecast: odOpen.reduce((a, d) => a + weighted(d.amount, d.probability), 0),
        wonValue: od.filter((d) => isWon(d) && inWin(d)).reduce((a, d) => a + (d.amount || 0), 0),
      };
    })
    .sort((a, b) => b.pipelineValue - a.pipelineValue);

  return {
    totals: { total: deals.length, open: open.length, won: won.length, lost: lost.length },
    revenue: {
      pipelineValue: open.reduce((s, d) => s + (d.amount || 0), 0),
      forecastRevenue: open.reduce((s, d) => s + weighted(d.amount, d.probability), 0),
      wonValue: won.reduce((s, d) => s + (d.amount || 0), 0),
      lostValue: lost.reduce((s, d) => s + (d.amount || 0), 0),
      avgDealValue: deals.length ? Math.round(deals.reduce((s, d) => s + (d.amount || 0), 0) / deals.length) : 0,
    },
    byStage,
    byOwner,
    // Additive: BDE-wise LEAD pipeline + per-lead checklist progress. Same scope
    // + window; existing consumers ignore it.
    bdePipeline: await computeBdePipeline(scope, window),
  };
}

// ── SE-035 Win Rate (overall + by owner / team / product) ────────────────────
export async function computeWinRate(scope: Scope, window?: Window) {
  const deals = await prisma.deal.findMany({
    where: ownerWhere(scope),
    select: { stage: true, status: true, ownerId: true, products: true, closedAt: true, amount: true },
  });
  const inWin = (d: { closedAt: Date | null }) => !window || (!!d.closedAt && d.closedAt >= window.start && d.closedAt < window.end);
  const closed = deals.filter((d) => (isWon(d) || isLost(d)) && inWin(d));
  const wonTotal = closed.filter(isWon).length;
  const lostTotal = closed.filter(isLost).length;
  const rate = (w: number, l: number) => (w + l > 0 ? round1((w / (w + l)) * 100) : null); // null = N/A

  const ownerIds = Array.from(new Set(closed.map((d) => d.ownerId)));
  const names = await ownerNames(ownerIds);
  const byOwner = ownerIds
    .map((oid) => {
      const w = closed.filter((d) => d.ownerId === oid && isWon(d)).length;
      const l = closed.filter((d) => d.ownerId === oid && isLost(d)).length;
      return { ownerId: oid, name: names.get(oid) || 'Unassigned', won: w, lost: l, winRate: rate(w, l) };
    })
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  const teamMap = await ownerTeamMap();
  const teamAgg = new Map<number, { name: string; won: number; lost: number }>();
  for (const d of closed) {
    const t = teamMap.get(d.ownerId);
    if (!t) continue;
    const row = teamAgg.get(t.teamId) ?? { name: t.name, won: 0, lost: 0 };
    if (isWon(d)) row.won++; else row.lost++;
    teamAgg.set(t.teamId, row);
  }
  const byTeam = [...teamAgg.entries()]
    .map(([teamId, r]) => ({ teamId, name: r.name, won: r.won, lost: r.lost, winRate: rate(r.won, r.lost) }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  // Approximate: Deal.products is free-text CSV; multi-product deals double-count.
  const prodAgg = new Map<string, { won: number; lost: number }>();
  for (const d of closed) {
    for (const p of (d.products || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const row = prodAgg.get(p) ?? { won: 0, lost: 0 };
      if (isWon(d)) row.won++; else row.lost++;
      prodAgg.set(p, row);
    }
  }
  const byProduct = [...prodAgg.entries()]
    .map(([product, r]) => ({ product, won: r.won, lost: r.lost, winRate: rate(r.won, r.lost) }))
    .sort((a, b) => b.won + b.lost - (a.won + a.lost));

  return {
    overall: { won: wonTotal, lost: lostTotal, winRate: rate(wonTotal, lostTotal) },
    byOwner,
    byTeam,
    byProduct,
    approximateProduct: true,
  };
}

// ── SE-036 Lost Deal Analysis ────────────────────────────────────────────────
export async function computeLostDealAnalysis(scope: Scope, window?: Window) {
  const where: Record<string, any> = { ...ownerWhere(scope), status: 'lost' };
  if (window) where.closedAt = { gte: window.start, lt: window.end };
  const deals = await prisma.deal.findMany({
    where,
    select: { amount: true, lossReason: true, competitors: true, lostFromStage: true, closedAt: true },
  });

  const total = deals.length;
  const totalValue = deals.reduce((s, d) => s + (d.amount || 0), 0);

  const aggBy = (key: (d: (typeof deals)[number]) => string | null) => {
    const m = new Map<string, { count: number; value: number }>();
    for (const d of deals) {
      const k = key(d);
      if (!k) continue;
      const r = m.get(k) ?? { count: 0, value: 0 };
      r.count++; r.value += d.amount || 0;
      m.set(k, r);
    }
    return [...m.entries()]
      .map(([label, r]) => ({ label, count: r.count, value: r.value, pct: total ? round1((r.count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);
  };

  const byLossReason = aggBy((d) => (d.lossReason || '').trim() || 'Unspecified');
  const byStage = aggBy((d) => (d.lostFromStage || '').trim() || null);

  const compM = new Map<string, { count: number; value: number }>();
  for (const d of deals)
    for (const c of (d.competitors || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const r = compM.get(c) ?? { count: 0, value: 0 };
      r.count++; r.value += d.amount || 0;
      compM.set(c, r);
    }
  const byCompetitor = [...compM.entries()]
    .map(([label, r]) => ({ label, count: r.count, value: r.value }))
    .sort((a, b) => b.count - a.count);

  // Disqualified leads (reason breakdown).
  const leadWhere: Record<string, any> = { status: 'disqualified', ...ownerWhere(scope) };
  if (window) leadWhere.updatedAt = { gte: window.start, lt: window.end };
  const dqLeads = await prisma.lead.findMany({ where: leadWhere, select: { disqualifyReason: true } });
  const dqM = new Map<string, number>();
  for (const l of dqLeads) {
    const k = (l.disqualifyReason || '').trim() || 'Unspecified';
    dqM.set(k, (dqM.get(k) || 0) + 1);
  }
  const byDisqualifyReason = [...dqM.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  // Monthly loss trend (last 6 months).
  const now = new Date();
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const trendDeals = await prisma.deal.findMany({
    where: { ...ownerWhere(scope), status: 'lost', closedAt: { gte: trendStart } },
    select: { closedAt: true, amount: true },
  });
  const trend: { period: string; count: number; value: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    trend.push({ period: monthKey(d), count: 0, value: 0 });
  }
  for (const dl of trendDeals) {
    if (!dl.closedAt) continue;
    const b = trend.find((x) => x.period === monthKey(dl.closedAt!));
    if (b) { b.count++; b.value += dl.amount || 0; }
  }

  const insights: string[] = [];
  if (total > 0 && byLossReason[0]) insights.push(`${byLossReason[0].pct}% of lost deals cite "${byLossReason[0].label}".`);
  if (byStage[0]) insights.push(`The "${byStage[0].label}" stage has the highest loss count.`);
  if (byCompetitor[0]) insights.push(`"${byCompetitor[0].label}" is the most-cited competitor in lost deals.`);

  return { total, totalValue, byLossReason, byCompetitor, byStage, byDisqualifyReason, trend, insights, approximateCompetitor: true };
}

// ── SE-033 Lead Source Report ────────────────────────────────────────────────
const CONVERTED_LEAD_STATUSES = ['converted', 'won'];
export async function computeLeadSourceReport(scope: Scope, window?: Window) {
  const where: Record<string, any> = { ...ownerWhere(scope) };
  if (window) where.createdAt = { gte: window.start, lt: window.end };
  const leads = await prisma.lead.findMany({ where, select: { source: true, status: true, stage: true } });

  const m = new Map<string, { total: number; qualified: number; converted: number }>();
  for (const l of leads) {
    const src = (l.source || 'unknown').trim() || 'unknown';
    const r = m.get(src) ?? { total: 0, qualified: 0, converted: 0 };
    r.total++;
    if (l.stage && l.stage !== 'NQL') r.qualified++;
    if (CONVERTED_LEAD_STATUSES.includes(l.status)) r.converted++;
    m.set(src, r);
  }
  const sources = [...m.entries()]
    .map(([source, r]) => ({ source, total: r.total, qualified: r.qualified, converted: r.converted, conversionRate: r.total ? round1((r.converted / r.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  const totalLeads = leads.length;
  const totalConverted = sources.reduce((s, x) => s + x.converted, 0);
  return { totalLeads, totalConverted, overallConversionRate: totalLeads ? round1((totalConverted / totalLeads) * 100) : 0, sources };
}

// ── SE-044.2 Team Target Dashboard (R/Y/G + cross-team) ──────────────────────
const band = (pct: number, hasTarget: boolean): 'green' | 'yellow' | 'red' | 'neutral' =>
  !hasTarget ? 'neutral' : pct >= 100 ? 'green' : pct >= 70 ? 'yellow' : 'red';

export async function computeTeamTargetDashboard(ctx: SalesAuthContext) {
  const orgWide = canViewOrgReports(ctx);
  const now = new Date();
  const period = monthKey(now);
  const win = targetService.periodWindow(period, 'monthly');

  const teamWhere: Record<string, any> = { archived: false };
  if (!orgWide) teamWhere.managerId = ctx.userId;
  const teams = await prisma.salesTeam.findMany({
    where: teamWhere,
    include: { members: { select: { userId: true } }, manager: { select: { id: true, name: true } } },
  });

  const memberIds = new Set<number>();
  const teamViews: any[] = [];
  for (const t of teams) {
    let target = 0, achieved = 0;
    for (const mem of t.members) {
      memberIds.add(mem.userId);
      const tg = await prisma.salesTarget.findFirst({ where: { ownerId: mem.userId, period, periodType: 'monthly', type: 'revenue' } });
      target += tg?.targetAmount ?? 0;
      achieved += await targetService.computeActual(mem.userId, 'revenue', win);
    }
    const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
    teamViews.push({
      teamId: t.id, name: t.name, manager: t.manager?.name ?? null, memberCount: t.members.length,
      target, achieved, remaining: Math.max(0, target - achieved), achievementPct: pct, status: band(pct, target > 0),
    });
  }
  teamViews.sort((a, b) => b.achievementPct - a.achievementPct);

  const names = await ownerNames([...memberIds]);
  const bdeViews: any[] = [];
  for (const id of memberIds) {
    const tg = await prisma.salesTarget.findFirst({ where: { ownerId: id, period, periodType: 'monthly', type: 'revenue' } });
    const target = tg?.targetAmount ?? 0;
    const achieved = await targetService.computeActual(id, 'revenue', win);
    const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
    bdeViews.push({ ownerId: id, name: names.get(id) || 'Unknown', target, achieved, remaining: Math.max(0, target - achieved), achievementPct: pct, status: band(pct, target > 0) });
  }
  bdeViews.sort((a, b) => b.achievementPct - a.achievementPct);

  const withTarget = teamViews.filter((t) => t.target > 0);
  return {
    period,
    bands: { green: '≥100% achieved', yellow: '70–99% near target', red: '<70% behind', neutral: 'no target assigned' },
    teams: teamViews,
    bdes: bdeViews,
    rankings: { topTeams: withTarget.slice(0, 3), bottomTeams: withTarget.slice(-3).reverse() },
  };
}

// ── Executive Analytics (org-wide; forecasting + rankings) ───────────────────
export async function computeExecutiveAnalytics(window?: Window) {
  const now = new Date();
  const monthWin = window ?? targetService.periodWindow(monthKey(now), 'monthly');
  const quarterWin = targetService.periodWindow(`${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`, 'quarterly');
  const yearWin = targetService.periodWindow(`${now.getFullYear()}`, 'yearly');

  const deals = await prisma.deal.findMany({
    select: { amount: true, probability: true, stage: true, status: true, ownerId: true, closedAt: true, expectedCloseDate: true },
  });
  const inWin = (d: { closedAt: Date | null }, w: Window) => !!d.closedAt && d.closedAt >= w.start && d.closedAt < w.end;
  const open = deals.filter(isOpen);

  const revenue = {
    wonThisPeriod: deals.filter((d) => isWon(d) && inWin(d, monthWin)).reduce((s, d) => s + (d.amount || 0), 0),
    pipelineValue: open.reduce((s, d) => s + (d.amount || 0), 0),
    forecast: open.reduce((s, d) => s + weighted(d.amount, d.probability), 0),
  };

  // Forecasting: weighted value of open deals whose expected close falls in the window.
  const fc = (w: Window) =>
    open.filter((d) => d.expectedCloseDate && d.expectedCloseDate >= w.start && d.expectedCloseDate < w.end)
      .reduce((s, d) => s + weighted(d.amount, d.probability), 0);
  const forecasting = { month: fc(monthWin), quarter: fc(quarterWin), year: fc(yearWin) };

  const closed = deals.filter((d) => isWon(d) || isLost(d));
  const won = closed.filter(isWon).length;
  const lost = closed.filter(isLost).length;
  const winRate = won + lost > 0 ? round1((won / (won + lost)) * 100) : null;

  // Rankings.
  const ownerIds = Array.from(new Set(deals.map((d) => d.ownerId)));
  const names = await ownerNames(ownerIds);
  const topBdes = ownerIds
    .map((oid) => {
      const winsInPeriod = deals.filter((d) => d.ownerId === oid && isWon(d) && inWin(d, monthWin));
      return { ownerId: oid, name: names.get(oid) || 'Unassigned', revenue: winsInPeriod.reduce((s, d) => s + (d.amount || 0), 0), wonCount: winsInPeriod.length };
    })
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const source = await computeLeadSourceReport(null);
  const conversion = source.overallConversionRate;
  const topSources = source.sources.slice(0, 5);

  // Conversion rates: deal = won / all deals; project = won deals that became projects.
  const totalDeals = deals.length;
  const dealConversionRate = totalDeals > 0 ? round1((won / totalDeals) * 100) : 0;
  const [wonWithProject, wonTotal] = await Promise.all([
    prisma.deal.count({ where: { status: 'won', projectId: { not: null } } }),
    prisma.deal.count({ where: { status: 'won' } }),
  ]);
  const projectConversionRate = wonTotal > 0 ? round1((wonWithProject / wonTotal) * 100) : 0;

  // SE-037 forecast vs actual for the current period (org-wide).
  const forecastVsActual = await computeForecastVsActual(null, monthWin);

  return {
    period: monthKey(now),
    revenue,
    forecasting,
    forecastVsActual: { forecast: forecastVsActual.forecast, actual: forecastVsActual.actual, variance: forecastVsActual.variance, achievementPct: forecastVsActual.achievementPct },
    rates: { winRate, conversionRate: conversion, dealConversionRate, projectConversionRate },
    rankings: { topBdes, topSources },
  };
}

// ── SE-037.1 Revenue Forecast vs Actual ──────────────────────────────────────
export async function computeForecastVsActual(scope: Scope, window?: Window) {
  const deals = await prisma.deal.findMany({
    where: ownerWhere(scope),
    select: { amount: true, probability: true, stage: true, status: true, ownerId: true, closedAt: true, expectedCloseDate: true },
  });

  const wonInWindow = (d: (typeof deals)[number]) =>
    isWon(d) && (!window || (!!d.closedAt && d.closedAt >= window.start && d.closedAt < window.end));
  const openInWindow = (d: (typeof deals)[number]) =>
    isOpen(d) && (!window || (!!d.expectedCloseDate && d.expectedCloseDate >= window.start && d.expectedCloseDate < window.end));

  const calc = (list: typeof deals) => {
    const actual = list.filter(wonInWindow).reduce((s, d) => s + (d.amount || 0), 0);
    // Forecast = realized (won) + weighted expectation of open deals due in window.
    const forecast = actual + list.filter(openInWindow).reduce((s, d) => s + weighted(d.amount, d.probability), 0);
    const variance = forecast - actual;
    return { forecast, actual, variance, achievementPct: forecast > 0 ? round1((actual / forecast) * 100) : 0 };
  };

  const overall = calc(deals);
  const ownerIds = Array.from(new Set(deals.map((d) => d.ownerId)));
  const names = await ownerNames(ownerIds);
  const byOwner = ownerIds
    .map((oid) => ({ ownerId: oid, name: names.get(oid) || 'Unassigned', ...calc(deals.filter((d) => d.ownerId === oid)) }))
    .filter((o) => o.forecast > 0 || o.actual > 0)
    .sort((a, b) => b.actual - a.actual);

  return { ...overall, byOwner };
}

// ── SE-038.1 Activity Report ─────────────────────────────────────────────────
export async function computeActivityReport(scope: Scope, window?: Window) {
  const inScope = scope === null ? undefined : { in: scope.length ? scope : [-1] };
  const range = (field: string) => (window ? { [field]: { gte: window.start, lt: window.end } } : {});

  const [interactions, followUps, tasks] = await Promise.all([
    prisma.leadInteraction.findMany({ where: { ...(inScope ? { authorId: inScope } : {}), ...range('interactionDate') }, select: { authorId: true, type: true } }),
    prisma.followUp.findMany({ where: { ...(inScope ? { ownerId: inScope } : {}), status: 'completed', ...range('completedAt') }, select: { ownerId: true } }),
    prisma.salesTask.findMany({ where: { ...(inScope ? { assigneeId: inScope } : {}), status: 'completed', ...range('completedAt') }, select: { assigneeId: true } }),
  ]);

  type Row = { ownerId: number; name: string; calls: number; meetings: number; emails: number; followUps: number; tasks: number; total: number };
  const map = new Map<number, Row>();
  const row = (id: number): Row => {
    let r = map.get(id);
    if (!r) { r = { ownerId: id, name: '', calls: 0, meetings: 0, emails: 0, followUps: 0, tasks: 0, total: 0 }; map.set(id, r); }
    return r;
  };
  for (const i of interactions) {
    const r = row(i.authorId);
    if (i.type === 'Call') r.calls++;
    else if (i.type === 'Meeting') r.meetings++;
    else if (i.type === 'Email') r.emails++;
  }
  for (const f of followUps) row(f.ownerId).followUps++;
  for (const t of tasks) row(t.assigneeId).tasks++;

  const names = await ownerNames([...map.keys()]);
  const byOwner = [...map.values()].map((r) => {
    r.name = names.get(r.ownerId) || 'Unassigned';
    r.total = r.calls + r.meetings + r.emails + r.followUps + r.tasks;
    return r;
  }).sort((a, b) => b.total - a.total);

  const totals = byOwner.reduce(
    (t, r) => ({ calls: t.calls + r.calls, meetings: t.meetings + r.meetings, emails: t.emails + r.emails, followUps: t.followUps + r.followUps, tasks: t.tasks + r.tasks, totalActivities: t.totalActivities + r.total }),
    { calls: 0, meetings: 0, emails: 0, followUps: 0, tasks: 0, totalActivities: 0 },
  );

  const days = window ? Math.max(1, Math.round((window.end.getTime() - window.start.getTime()) / (24 * 60 * 60 * 1000))) : 1;
  const weeks = Math.max(1, days / 7);
  const rates = {
    activitiesPerDay: round1(totals.totalActivities / days),
    callsPerDay: round1(totals.calls / days),
    meetingsPerWeek: round1(totals.meetings / weeks),
    followUpsCompleted: totals.followUps,
  };

  return { range: window ? { start: window.start.toISOString(), end: window.end.toISOString(), days } : null, totals, rates, byOwner };
}

/** Parse ?period=&periodType= (or ?from&to) into a Window, or undefined for all-time. */
export function windowFromQuery(query: Record<string, any>): Window | undefined {
  if (typeof query.from === 'string' && typeof query.to === 'string') {
    const start = new Date(query.from);
    const end = new Date(query.to);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) return { start, end };
  }
  if (typeof query.period === 'string') {
    const periodType: PeriodType =
      typeof query.periodType === 'string' && (targetService.VALID_PERIOD_TYPES as string[]).includes(query.periodType)
        ? (query.periodType as PeriodType)
        : targetService.inferPeriodType(query.period);
    if (targetService.isValidPeriod(query.period, periodType)) return targetService.periodWindow(query.period, periodType);
  }
  return undefined;
}
