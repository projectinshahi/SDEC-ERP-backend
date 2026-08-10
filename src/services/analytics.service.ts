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
/**
 * Daily BDE performance KPIs. Stage counts are the CURRENT pipeline snapshot;
 * the "…Yesterday"/"…Today" figures are derived from the SAME data already
 * fetched here — stage-transition activity (each move INTO a stage IS that
 * activity: → MQL = meaningful conversation, → SQL = discovery meeting, → PQL =
 * proposal sent, → SAL = negotiation, → WON = win) plus lead createdAt/leadValue,
 * and a single follow-ups query for scheduled meetings. No new calculations that
 * already live elsewhere; no duplicate pipeline queries.
 */
export interface BdeKpis {
  newLeadsYesterday: number;
  nql: number; mql: number; sql: number; pql: number; sal: number; won: number; hold: number; lost: number;
  meaningfulConversationsYesterday: number;
  discoveryMeetingsYesterday: number;
  proposalsSentYesterday: number;
  proposalValueYesterday: number;
  negotiationsActiveYesterday: number;
  wonRevenueYesterday: number;
  nextDayMeetingsToday: number;
}
export interface BdePipelineOwner {
  ownerId: number; name: string; totalLeads: number;
  byStage: { stage: string; count: number }[];
  leads: BdePipelineLead[];
  kpis: BdeKpis;
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
      select: { id: true, title: true, stage: true, ownerId: true, leadValue: true, createdAt: true, customer: { select: { company: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' }, select: { name: true } }),
  ]);
  if (leads.length === 0) return [];

  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Latest checked-checklist count per lead — the most recent stage_changed
  // activity whose target stage matches the lead's CURRENT stage (one query,
  // also reused below for the per-stage "…Yesterday" transition KPIs).
  const acts = await prisma.activity_logs.findMany({
    where: { lead_id: { in: leads.map((l) => l.id) }, type: 'stage_changed' },
    select: { lead_id: true, metadata: true, created_at: true },
    orderBy: { created_at: 'desc' },
  });
  const doneByLead = new Map<number, number>();
  for (const a of acts) {
    if (a.lead_id == null || doneByLead.has(a.lead_id)) continue; // desc → first match is latest
    const m = (a.metadata ?? {}) as any;
    if (m.toStage && m.toStage === leadById.get(a.lead_id)?.stage) {
      doneByLead.set(a.lead_id, Array.isArray(m.checklist) ? m.checklist.length : 0);
    }
  }

  // ── Daily KPIs ──────────────────────────────────────────────────────────
  // Calendar yesterday / tomorrow boundaries (server-local).
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY_MS = 86_400_000;
  const yStart = new Date(todayStart.getTime() - DAY_MS);
  const tomStart = new Date(todayStart.getTime() + DAY_MS);
  const dayAfterTom = new Date(todayStart.getTime() + 2 * DAY_MS);

  // Per-owner tally of yesterday's stage transitions (→stage counts + ₹ into
  // PQL/WON), derived from the acts already fetched.
  // ponytail: transitions are for leads within the report window; a lead created
  // outside the period that moved yesterday won't count. Drop the createdAt
  // window on `leads` if yesterday-KPIs must be period-independent.
  const yTrans = new Map<number, { toMql: number; toSql: number; toPql: number; toSal: number; toWon: number; pqlValue: number; wonValue: number }>();
  const bump = (oid: number) => yTrans.get(oid) ?? yTrans.set(oid, { toMql: 0, toSql: 0, toPql: 0, toSal: 0, toWon: 0, pqlValue: 0, wonValue: 0 }).get(oid)!;
  for (const a of acts) {
    if (a.lead_id == null || !a.created_at || a.created_at < yStart || a.created_at >= todayStart) continue;
    const lead = leadById.get(a.lead_id);
    if (!lead?.ownerId) continue;
    const to = String((a.metadata as any)?.toStage || '').toUpperCase();
    const t = bump(lead.ownerId);
    const val = lead.leadValue || 0;
    if (to === 'MQL') t.toMql++;
    else if (to === 'SQL') t.toSql++;
    else if (to === 'PQL') { t.toPql++; t.pqlValue += val; }
    else if (to === 'SAL') t.toSal++;
    else if (to === 'WON') { t.toWon++; t.wonValue += val; }
  }

  // Next-day meetings scheduled today (the one metric not derivable from leads /
  // stage activity) — a single scoped follow-ups query, grouped in JS (groupBy
  // OOMs tsc in this backend).
  const meetings = await prisma.followUp.findMany({
    where: { ...ownerWhere(scope), type: 'meeting', createdAt: { gte: todayStart, lt: tomStart }, scheduledDate: { gte: tomStart, lt: dayAfterTom } },
    select: { ownerId: true },
  });
  const meetingByOwner = new Map<number, number>();
  for (const m of meetings) meetingByOwner.set(m.ownerId, (meetingByOwner.get(m.ownerId) ?? 0) + 1);

  const names = await ownerNames(Array.from(new Set(leads.map((l) => l.ownerId).filter((x): x is number => x != null))));
  const totalFor = (stage: string) => STAGE_CHECKLIST_TOTALS[(stage || '').toUpperCase()] ?? 0;

  // Group by owner, preserving the createdAt-desc order within each BDE's lead list.
  const byOwnerId = new Map<number, typeof leads>();
  for (const l of leads) {
    const oid = l.ownerId ?? -1;
    (byOwnerId.get(oid) ?? byOwnerId.set(oid, []).get(oid)!).push(l);
  }
  const countStage = (own: typeof leads, s: string) => own.filter((l) => (l.stage || '').toUpperCase() === s).length;

  return Array.from(byOwnerId.entries())
    .map(([ownerId, own]) => {
      const t = ownerId === -1 ? undefined : yTrans.get(ownerId);
      return {
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
        kpis: {
          newLeadsYesterday: own.filter((l) => l.createdAt >= yStart && l.createdAt < todayStart).length,
          nql: countStage(own, 'NQL'), mql: countStage(own, 'MQL'), sql: countStage(own, 'SQL'),
          pql: countStage(own, 'PQL'), sal: countStage(own, 'SAL'), won: countStage(own, 'WON'),
          hold: countStage(own, 'HOLD'), lost: countStage(own, 'LOST'),
          meaningfulConversationsYesterday: t?.toMql ?? 0,
          discoveryMeetingsYesterday: t?.toSql ?? 0,
          proposalsSentYesterday: t?.toPql ?? 0,
          proposalValueYesterday: t?.pqlValue ?? 0,
          negotiationsActiveYesterday: t?.toSal ?? 0,
          wonRevenueYesterday: t?.wonValue ?? 0,
          nextDayMeetingsToday: ownerId === -1 ? 0 : meetingByOwner.get(ownerId) ?? 0,
        },
      };
    })
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

// ── Sales Performance Report (SINGLE source of truth for the exported PDF) ────
// One filtered lead query drives every section, so no two sections can disagree.
// The caller passes a `where` ALREADY scoped (utils/leadFilters + leadOwnerScope)
// and the report window; targets come from the existing SalesTarget model and the
// canonical target.service period math. Nothing is fabricated: metrics the data
// cannot support are returned as an explicit null / available:false.
const REPORT_FUNNEL = ['NQL', 'MQL', 'SQL', 'PQL', 'SAL', 'WON'];
const REPORT_ACTIVE = ['NQL', 'MQL', 'SQL', 'PQL', 'SAL'];
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function monthsBetween(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d < end) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); d.setMonth(d.getMonth() + 1); }
  return out;
}

// Explicit return type: without it, tsc deep-infers this large literal on top of
// Prisma's heavy generics and OOMs the compiler in this backend.
export async function computeSalesPerformanceReport(where: Record<string, any>, window: Window | null): Promise<any> {
  const leads = await prisma.lead.findMany({
    where,
    select: {
      id: true, title: true, stage: true, status: true, ownerId: true, leadValue: true,
      createdAt: true, updatedAt: true, disqualifyReason: true,
      customer: { select: { company: true } }, owner: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const up = (s: string | null) => (s || '').toUpperCase();
  const val = (l: { leadValue: number | null }) => l.leadValue || 0;
  const atStage = (name: string) => leads.filter((l) => up(l.stage) === name);
  const stageCount = (name: string) => atStage(name).length;
  const stageValue = (name: string) => atStage(name).reduce((s, l) => s + val(l), 0);

  // Cumulative funnel: reached[i] = current leads at stage i or later (incl WON).
  const reachedFrom = (i: number) => REPORT_FUNNEL.slice(i).reduce((s, st) => s + stageCount(st), 0);
  const rankOf = (l: { stage: string | null }) => REPORT_FUNNEL.indexOf(up(l.stage));

  const total = leads.length;
  const wonRevenue = stageValue('WON');
  const holdValue = stageValue('HOLD');
  const lostValue = stageValue('LOST');
  const activePipeline = REPORT_ACTIVE.reduce((s, st) => s + stageValue(st), 0);
  const activeCount = REPORT_ACTIVE.reduce((s, st) => s + stageCount(st), 0);
  const totalValue = leads.reduce((s, l) => s + val(l), 0);
  const avgDealValue = total > 0 ? Math.round(totalValue / total) : 0;
  const convertedCount = leads.filter((l) => (l.status || '').toLowerCase() === 'converted').length;
  const overallConversion = total > 0 ? Math.round((convertedCount / total) * 1000) / 10 : 0;

  // ── Target (existing SalesTarget model; canonical monthly period math) ─────
  const ownerIds = Array.from(new Set(leads.map((l) => l.ownerId).filter((x): x is number => x != null)));
  const now = new Date();
  const periods = window
    ? monthsBetween(window.start, window.end)
    : [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`];
  const targetByOwner = new Map<number, number>();
  if (ownerIds.length && periods.length) {
    const rows = await prisma.salesTarget.findMany({
      where: { ownerId: { in: ownerIds }, type: 'revenue', periodType: 'monthly', period: { in: periods } },
      select: { ownerId: true, targetAmount: true },
    });
    for (const r of rows) targetByOwner.set(r.ownerId, (targetByOwner.get(r.ownerId) || 0) + (r.targetAmount || 0));
  }
  const target = targetByOwner.size ? Array.from(targetByOwner.values()).reduce((s, t) => s + t, 0) : null;
  const targetAvailable = target != null && target > 0;
  const achievementPercentage = targetAvailable ? Math.round((wonRevenue / target!) * 1000) / 10 : null;
  const targetGap = targetAvailable ? Math.max(0, target! - wonRevenue) : null;
  const pipelineCoverage = targetAvailable && targetGap! > 0 ? Math.round((activePipeline / targetGap!) * 100) / 100 : null;

  // ── Funnel ────────────────────────────────────────────────────────────────
  const funnel = REPORT_FUNNEL.map((st, i) => {
    const cur = reachedFrom(i);
    const conv = i < REPORT_FUNNEL.length - 1 && cur > 0 ? Math.round((reachedFrom(i + 1) / cur) * 1000) / 10 : null;
    return { stage: st, opportunities: stageCount(st), value: stageValue(st), conversionToNext: conv };
  });

  // ── Execution (cohort of the filtered leads) ──────────────────────────────
  const proposalCohort = leads.filter((l) => rankOf(l) >= 3);
  const meetingWhere: Record<string, any> = { leadId: { in: leads.map((l) => l.id) }, type: 'meeting' };
  if (window) meetingWhere.createdAt = { gte: window.start, lt: window.end };
  const meetingsScheduled = leads.length ? await prisma.followUp.count({ where: meetingWhere }) : 0;
  const execution = {
    newLeads: total,
    meaningfulConversations: leads.filter((l) => rankOf(l) >= 1).length,
    discoveryMeetings: leads.filter((l) => rankOf(l) >= 2).length,
    proposalsSent: proposalCohort.length,
    proposalValue: proposalCohort.reduce((s, l) => s + val(l), 0),
    meetingsScheduled,
  };

  // ── Hold / Lost ───────────────────────────────────────────────────────────
  const reasonBreakdown = (stage: string) => {
    const m: Record<string, number> = {};
    for (const l of atStage(stage)) if (l.disqualifyReason) { const r = l.disqualifyReason.trim(); m[r] = (m[r] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
  };
  const holdLost = {
    hold: { count: stageCount('HOLD'), value: holdValue, reasons: reasonBreakdown('HOLD') },
    lost: { count: stageCount('LOST'), value: lostValue, reasons: reasonBreakdown('LOST') },
  };

  // ── Team / BDE performance ────────────────────────────────────────────────
  const ownerAgg = new Map<number, { name: string; opportunities: number; won: number; wonRevenue: number; active: number }>();
  for (const l of leads) {
    if (l.ownerId == null) continue;
    const o = ownerAgg.get(l.ownerId) ?? { name: l.owner?.name || 'Unassigned', opportunities: 0, won: 0, wonRevenue: 0, active: 0 };
    o.opportunities++;
    const st = up(l.stage);
    if (st === 'WON') { o.won++; o.wonRevenue += val(l); }
    if (REPORT_ACTIVE.includes(st)) o.active += val(l);
    ownerAgg.set(l.ownerId, o);
  }
  const teamPerformance = Array.from(ownerAgg.entries())
    .map(([ownerId, o]) => {
      const tgt = targetByOwner.get(ownerId) ?? null;
      return {
        ownerId, name: o.name, opportunities: o.opportunities,
        wonRevenue: o.wonRevenue, activePipeline: o.active,
        conversion: o.opportunities > 0 ? Math.round((o.won / o.opportunities) * 1000) / 10 : 0,
        target: tgt, achievement: tgt && tgt > 0 ? Math.round((o.wonRevenue / tgt) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.wonRevenue - a.wonRevenue);

  // ── Trend: Won Revenue over time (bucketed by the WON transition date) ─────
  const wonLeads = atStage('WON');
  const wonById = new Map(wonLeads.map((l) => [l.id, l]));
  const wonDateByLead = new Map<number, Date>();
  if (wonLeads.length) {
    const wonActs = await prisma.activity_logs.findMany({
      where: { lead_id: { in: wonLeads.map((l) => l.id) }, type: 'stage_changed' },
      select: { lead_id: true, metadata: true, created_at: true },
      orderBy: { created_at: 'desc' },
    });
    for (const a of wonActs) {
      if (a.lead_id == null || wonDateByLead.has(a.lead_id)) continue;
      if (up((a.metadata as any)?.toStage) === 'WON' && a.created_at) wonDateByLead.set(a.lead_id, a.created_at);
    }
    for (const l of wonLeads) if (!wonDateByLead.has(l.id)) wonDateByLead.set(l.id, l.updatedAt); // fallback
  }
  // Bucket size adapts to the range length (or the won-date span when no window).
  const dateNums = window ? [window.start.getTime(), window.end.getTime()] : [...wonDateByLead.values()].map((d) => d.getTime());
  const spanDays = dateNums.length ? (Math.max(...dateNums) - Math.min(...dateNums)) / 86_400_000 : 0;
  const bucket: 'day' | 'week' | 'month' = spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month';
  const bucketKey = (d: Date) => {
    if (bucket === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (bucket === 'week') { const t = new Date(d); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return ymdLocal(t); }
    return ymdLocal(d);
  };
  const trendMap = new Map<string, number>();
  for (const [leadId, d] of wonDateByLead) {
    if (window && (d < window.start || d >= window.end)) continue;
    trendMap.set(bucketKey(d), (trendMap.get(bucketKey(d)) || 0) + val(wonById.get(leadId)!));
  }
  const trendPoints = Array.from(trendMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, wonRevenue]) => ({ date, wonRevenue }));

  // ── Insights (data-supported only; unavailable metrics are simply omitted) ─
  const insights: { type: string; severity: 'high' | 'medium' | 'low'; message: string }[] = [];
  const activeLeads = leads.filter((l) => REPORT_ACTIVE.includes(up(l.stage)));
  const lastActivity = new Map<number, Date>();
  if (activeLeads.length) {
    const acts = await prisma.activity_logs.findMany({
      where: { lead_id: { in: activeLeads.map((l) => l.id) } },
      select: { lead_id: true, created_at: true },
      orderBy: { created_at: 'desc' },
    });
    for (const a of acts) if (a.lead_id != null && !lastActivity.has(a.lead_id) && a.created_at) lastActivity.set(a.lead_id, a.created_at);
  }
  const STALE_DAYS = 14;
  const staleCut = new Date(now.getTime() - STALE_DAYS * 86_400_000);
  const highValueCut = avgDealValue * 2; // relative to THIS dataset, never a hardcoded ₹ figure
  const staleHighValue = activeLeads.filter((l) => val(l) >= highValueCut && (lastActivity.get(l.id) ?? l.updatedAt) < staleCut);
  if (staleHighValue.length) insights.push({ type: 'stale_high_value', severity: 'high', message: `${staleHighValue.length} high-value opportunit${staleHighValue.length === 1 ? 'y has' : 'ies have'} had no activity in ${STALE_DAYS}+ days.` });
  if (holdLost.hold.count) insights.push({ type: 'hold_attention', severity: 'medium', message: `${holdLost.hold.count} opportunit${holdLost.hold.count === 1 ? 'y is' : 'ies are'} on Hold.` });
  const bigLost = atStage('LOST').filter((l) => val(l) >= highValueCut);
  if (bigLost.length) insights.push({ type: 'high_value_lost', severity: 'medium', message: `${bigLost.length} high-value opportunit${bigLost.length === 1 ? 'y was' : 'ies were'} lost.` });
  if (targetAvailable && targetGap! > 0 && activePipeline < targetGap!) insights.push({ type: 'pipeline_gap', severity: 'high', message: 'Active pipeline is below the remaining target gap (coverage under 1x).' });
  for (const t of teamPerformance) if (t.achievement != null && t.achievement < 50) insights.push({ type: 'bde_below_target', severity: 'medium', message: `${t.name} is at ${t.achievement}% of target.` });

  return {
    summary: {
      target, targetAvailable, wonRevenue, targetGap, achievementPercentage,
      activePipeline, activeOpportunities: activeCount, pipelineCoverage,
      avgDealValue, overallConversion, totalOpportunities: total,
      won: stageCount('WON'), hold: stageCount('HOLD'), lost: stageCount('LOST'), converted: convertedCount,
    },
    // Lead-based report: no lead-level probability exists, so weighted forecast is
    // explicitly unavailable (Deal-based forecast is intentionally NOT mixed in).
    forecast: { weightedForecast: null, available: false },
    execution,
    funnel,
    holdLost,
    teamPerformance,
    trend: { bucket, points: trendPoints },
    insights,
    targetPeriods: periods,
    generatedAt: now.toISOString(),
  };
}
