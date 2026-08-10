import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, resolveReportScope, canViewOrgReports, isManager, leadOwnerScopeFilter } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { salesReportService } from '../services/salesReport.service.js';
import { buildLeadWhere } from '../utils/leadFilters.js';
import {
  computePipelineSummary,
  computeWinRate,
  computeLostDealAnalysis,
  computeLeadSourceReport,
  computeTeamTargetDashboard,
  computeExecutiveAnalytics,
  computeForecastVsActual,
  computeActivityReport,
  computeSalesPerformanceReport,
  windowFromQuery,
  type Scope,
  type Window,
} from '../services/analytics.service.js';
import { buildMultiSheetBuffer, exportMeta, type ExportFormat, type ExportSheet } from '../utils/exportWorkbook.js';

/**
 * SE-030..036 / SE-044.2 / Executive — Sales Reporting endpoints. Thin handlers
 * over analytics.service (single source of metric math); scope-aware via
 * resolveReportScope (BDE=self, Manager=team, Director/Admin=org).
 */

const DAY = 24 * 60 * 60 * 1000;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── Sales Performance Report — single filter-aware payload for the PDF export ─
// Uses the SAME filter builder + owner scope as the Pipeline leads list (getLeads),
// so every section reflects exactly the dataset the board is showing. Gated by
// sales.leads.view (any pipeline user can export their own scoped report).
export const getSalesPerformanceReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const where = buildLeadWhere(req.query as any);
    // Owner scope + My/All + explicit ?ownerId — identical to getLeads.
    const scope = await leadOwnerScopeFilter(ctx, typeof where.ownerId === 'number' ? where.ownerId : undefined);
    if (scope === undefined) delete where.ownerId;
    else where.ownerId = scope;

    // Report window from the same fromDate/toDate the board export sends.
    const { fromDate, toDate } = req.query;
    let window: Window | null = null;
    if ((typeof fromDate === 'string' && fromDate) || (typeof toDate === 'string' && toDate)) {
      const start = typeof fromDate === 'string' && fromDate ? new Date(fromDate) : new Date(0);
      const end = typeof toDate === 'string' && toDate ? new Date(new Date(toDate).setHours(23, 59, 59, 999)) : new Date();
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) window = { start, end };
    }

    const echo = (k: string) => (typeof req.query[k] === 'string' && req.query[k] !== 'all' ? String(req.query[k]) : null);
    const filters = {
      fromDate: echo('fromDate'), toDate: echo('toDate'), owner: echo('ownerId'),
      source: echo('source'), stage: echo('stage'), status: echo('status'), search: echo('search'),
    };

    res.json({ filters, ...(await computeSalesPerformanceReport(where, window)) });
  } catch (error) {
    console.error('Error building sales performance report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-034 Pipeline Summary ──────────────────────────────────────────────────
export const getPipelineReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    res.json(await computePipelineSummary(scope, windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building pipeline report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-035 Win Rate ──────────────────────────────────────────────────────────
export const getWinRateReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    res.json(await computeWinRate(scope, windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building win-rate report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-036 Lost Deal Analysis ────────────────────────────────────────────────
export const getLostDealReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    res.json(await computeLostDealAnalysis(scope, windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building lost-deal report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-033 Lead Source ───────────────────────────────────────────────────────
export const getLeadSourceReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    res.json(await computeLeadSourceReport(scope, windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building lead-source report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-037.1 Revenue Forecast vs Actual ──────────────────────────────────────
export const getForecastVsActual = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    res.json(await computeForecastVsActual(scope, windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building forecast-vs-actual report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-038.1 Activity Report ─────────────────────────────────────────────────
export const getActivityReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    // Default to the last 30 days when no range is supplied (rates need a window).
    let window: Window | undefined = windowFromQuery(req.query as any);
    if (!window) {
      const end = new Date();
      window = { start: new Date(end.getTime() - 30 * DAY), end };
    }
    res.json(await computeActivityReport(scope, window));
  } catch (error) {
    console.error('Error building activity report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-044.2 Team Target R/Y/G ───────────────────────────────────────────────
export const getTeamTargetReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    res.json(await computeTeamTargetDashboard(ctx));
  } catch (error) {
    console.error('Error building team-target report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Executive Analytics (org-wide) ───────────────────────────────────────────
export const getExecutiveReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canViewOrgReports(ctx) && !isManager(ctx)) {
      return res.status(403).json({ error: 'Forbidden: executive analytics are restricted to managers, directors and admins.' });
    }
    res.json(await computeExecutiveAnalytics(windowFromQuery(req.query as any)));
  } catch (error) {
    console.error('Error building executive analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-030.3 Daily Report Viewer ─────────────────────────────────────────────
const zeroMetrics = { calls: 0, meetings: 0, leadsCreated: 0, leadsContacted: 0, followUpsCompleted: 0, dealsCreated: 0, dealsWon: 0, dealsLost: 0, revenueWon: 0 };

export const getDailyReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateStr = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : ymd(today);
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const isCurrentOrFuture = dayStart.getTime() >= today.getTime();

    // Owners in scope (null = all active users).
    let ownerIds: number[];
    if (scope === null) {
      const users = await prisma.users.findMany({ where: { status: 'active' }, select: { id: true } });
      ownerIds = users.map((u) => u.id);
    } else {
      ownerIds = scope;
    }
    // Optional single-owner filter, constrained to scope.
    if (req.query.ownerId != null && !isNaN(Number(req.query.ownerId))) {
      const uid = Number(req.query.ownerId);
      if (scope === null || scope.includes(uid)) ownerIds = [uid];
    }

    const users = await prisma.users.findMany({ where: { id: { in: ownerIds.length ? ownerIds : [-1] } }, select: { id: true, name: true, email: true } });
    const nameMap = new Map(users.map((u) => [u.id, u]));

    const snaps = isCurrentOrFuture
      ? []
      : await prisma.dailyReport.findMany({ where: { reportDate: dayStart, ownerId: { in: ownerIds.length ? ownerIds : [-1] } } });
    const snapByOwner = new Map(snaps.map((s) => [s.ownerId, s]));

    const rows = [];
    for (const id of ownerIds) {
      const u = nameMap.get(id);
      const snap = snapByOwner.get(id);
      let metrics = snap
        ? {
            calls: snap.calls, meetings: snap.meetings, leadsCreated: snap.leadsCreated, leadsContacted: snap.leadsContacted,
            followUpsCompleted: snap.followUpsCompleted, dealsCreated: snap.dealsCreated, dealsWon: snap.dealsWon,
            dealsLost: snap.dealsLost, revenueWon: snap.revenueWon,
          }
        : null;
      let state: 'generated' | 'pending' | 'failed' = 'generated';
      if (!metrics) {
        // No snapshot: compute live (accurate for any day).
        metrics = await salesReportService.computeLiveSnapshot(id, dayStart);
        state = isCurrentOrFuture ? 'pending' : 'generated';
      }
      if (isCurrentOrFuture) state = 'pending'; // current day is still in progress
      rows.push({ ownerId: id, name: u?.name || 'Unknown', email: u?.email || null, reportDate: dateStr, state, ...(metrics ?? zeroMetrics) });
    }
    rows.sort((a, b) => b.calls + b.meetings - (a.calls + a.meetings));

    const totals = rows.reduce(
      (t, r) => ({
        calls: t.calls + r.calls, meetings: t.meetings + r.meetings, leadsCreated: t.leadsCreated + r.leadsCreated,
        leadsContacted: t.leadsContacted + r.leadsContacted, followUpsCompleted: t.followUpsCompleted + r.followUpsCompleted,
        dealsCreated: t.dealsCreated + r.dealsCreated, dealsWon: t.dealsWon + r.dealsWon, dealsLost: t.dealsLost + r.dealsLost,
        revenueWon: t.revenueWon + r.revenueWon,
      }),
      { ...zeroMetrics },
    );

    res.json({ date: dateStr, isLive: isCurrentOrFuture, rows, totals });
  } catch (error) {
    console.error('Error building daily report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-030.2 Report Scheduler CRUD ───────────────────────────────────────────
const VALID_FREQ = ['daily', 'weekly', 'monthly'];

function nextRunFrom(frequency: string, from: Date): Date {
  const d = new Date(from);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1);
  return d;
}

export const getReportSchedules = async (_req: Request, res: Response) => {
  try {
    const schedules = await prisma.reportSchedule.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(schedules);
  } catch (error) {
    console.error('Error fetching report schedules:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createReportSchedule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'A schedule name is required.' });
    if (!VALID_FREQ.includes(body.frequency)) return res.status(400).json({ error: 'Frequency must be daily, weekly or monthly.' });

    const recipients = Array.isArray(body.recipients) ? body.recipients.map((r: any) => Number(r)).filter((n: number) => !isNaN(n)) : [];

    // Execution time (HH:MM) sets the first run; default to next occurrence from now.
    let nextRunAt = new Date();
    if (typeof body.executionTime === 'string' && /^\d{2}:\d{2}$/.test(body.executionTime)) {
      const [h, m] = body.executionTime.split(':').map(Number);
      const t = new Date();
      t.setHours(h, m, 0, 0);
      if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
      nextRunAt = t;
    }

    const schedule = await prisma.reportSchedule.create({
      data: {
        name,
        reportType: typeof body.reportType === 'string' ? body.reportType : 'daily_activity',
        frequency: body.frequency,
        recipients,
        active: body.active !== false,
        nextRunAt,
        createdById: ctx.userId,
      },
    });
    await activityService.logActivity({ actorUserId: ctx.userId, type: 'report_schedule_created', description: `Created ${body.frequency} report schedule "${name}".` });
    res.status(201).json(schedule);
  } catch (error) {
    console.error('Error creating report schedule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateReportSchedule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid schedule id' });
    const existing = await prisma.reportSchedule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    const body = req.body ?? {};
    const data: Record<string, any> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (VALID_FREQ.includes(body.frequency)) {
      data.frequency = body.frequency;
      data.nextRunAt = nextRunFrom(body.frequency, new Date());
    }
    if (Array.isArray(body.recipients)) data.recipients = body.recipients.map((r: any) => Number(r)).filter((n: number) => !isNaN(n));
    if (typeof body.reportType === 'string') data.reportType = body.reportType;
    if (typeof body.active === 'boolean') data.active = body.active;

    const schedule = await prisma.reportSchedule.update({ where: { id }, data });
    await activityService.logActivity({ actorUserId: ctx.userId, type: 'report_schedule_updated', description: `Updated report schedule "${schedule.name}".` });
    res.json(schedule);
  } catch (error) {
    console.error('Error updating report schedule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteReportSchedule = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid schedule id' });
    await prisma.reportSchedule.delete({ where: { id } });
    await activityService.logActivity({ actorUserId: ctx.userId, type: 'report_schedule_deleted', description: `Deleted report schedule #${id}.` });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting report schedule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Export (Excel / CSV) ─────────────────────────────────────────────────────
const money = (n: number) => Math.round(n || 0);

async function buildExportSheets(type: string, scope: Scope, ctx: any, window: any): Promise<ExportSheet[]> {
  switch (type) {
    case 'pipeline': {
      const d = await computePipelineSummary(scope, window);
      const pipelineSheet: ExportSheet = { name: 'Pipeline', headers: ['Stage', 'Count', 'Value', 'Weighted Forecast'], rows: d.byStage.map((s) => [s.stage, s.count, money(s.value), money(s.weightedForecast)]) };
      // Additive: BDE Pipeline Summary — per-BDE stage counts + per-lead checklist.
      const bdeSummary: ExportSheet = {
        name: 'BDE Pipeline',
        headers: ['BDE', 'Stage', 'Leads'],
        rows: d.bdePipeline.flatMap((b) => b.byStage.map((s) => [b.name, s.stage, s.count] as (string | number)[])),
      };
      const bdeLeads: ExportSheet = {
        name: 'BDE Leads',
        headers: ['BDE', 'Lead', 'Company', 'Current Stage', 'Checklist Status'],
        rows: d.bdePipeline.flatMap((b) =>
          b.leads.map((l) => [b.name, l.title, l.company, l.stage, `${l.checklistDone} / ${l.checklistTotal} Completed`] as (string | number)[]),
        ),
      };
      // Additive: BDE Performance Summary — daily KPI metrics per BDE.
      const bdePerf: ExportSheet = {
        name: 'BDE Performance',
        headers: [
          'BDE', 'New Leads (Yst)', 'NQL', 'MQL', 'Meaningful Conv. (Yst)', 'SQL', 'Discovery Mtgs (Yst)', 'PQL',
          'Proposals Sent (Yst)', 'Proposal Value ₹ (Yst)', 'Negotiations (Yst)', 'SAL', 'WON', 'WON Revenue ₹ (Yst)',
          'HOLD', 'LOST', 'Next-Day Mtgs (Today)',
        ],
        rows: d.bdePipeline.map((b) => {
          const k = b.kpis;
          return [
            b.name, k.newLeadsYesterday, k.nql, k.mql, k.meaningfulConversationsYesterday, k.sql, k.discoveryMeetingsYesterday, k.pql,
            k.proposalsSentYesterday, money(k.proposalValueYesterday), k.negotiationsActiveYesterday, k.sal, k.won, money(k.wonRevenueYesterday),
            k.hold, k.lost, k.nextDayMeetingsToday,
          ] as (string | number)[];
        }),
      };
      return [pipelineSheet, bdeSummary, bdeLeads, bdePerf];
    }
    case 'win-rate': {
      const d = await computeWinRate(scope, window);
      return [{ name: 'Win Rate', headers: ['Owner', 'Won', 'Lost', 'Win Rate %'], rows: d.byOwner.map((o) => [o.name, o.won, o.lost, o.winRate ?? 'N/A']) }];
    }
    case 'lost-deals': {
      const d = await computeLostDealAnalysis(scope, window);
      return [{ name: 'Lost Deals', headers: ['Loss Reason', 'Count', 'Value', '% of Lost'], rows: d.byLossReason.map((r) => [r.label, r.count, money(r.value ?? 0), r.pct ?? 0]) }];
    }
    case 'lead-source': {
      const d = await computeLeadSourceReport(scope, window);
      return [{ name: 'Lead Source', headers: ['Source', 'Leads', 'Qualified', 'Converted', 'Conversion %'], rows: d.sources.map((s) => [s.source, s.total, s.qualified, s.converted, s.conversionRate]) }];
    }
    case 'team-target': {
      const d = await computeTeamTargetDashboard(ctx);
      return [{ name: 'Team Targets', headers: ['Team', 'Target', 'Achieved', 'Achievement %', 'Status'], rows: d.teams.map((t: any) => [t.name, money(t.target), money(t.achieved), t.achievementPct, t.status]) }];
    }
    case 'activity': {
      // SE-039.2 — sales team activity export.
      const d = await computeActivityReport(scope, window);
      return [{ name: 'Activity', headers: ['BDE', 'Calls', 'Meetings', 'Emails', 'Follow-ups', 'Tasks', 'Total'], rows: d.byOwner.map((o) => [o.name, o.calls, o.meetings, o.emails, o.followUps, o.tasks, o.total]) }];
    }
    case 'forecast': {
      const d = await computeForecastVsActual(scope, window);
      return [{
        name: 'Forecast vs Actual',
        headers: ['BDE', 'Forecast', 'Actual', 'Variance', 'Achievement %'],
        rows: [
          ['ALL', money(d.forecast), money(d.actual), money(d.variance), d.achievementPct],
          ...d.byOwner.map((o) => [o.name, money(o.forecast), money(o.actual), money(o.variance), o.achievementPct] as (string | number)[]),
        ],
      }];
    }
    case 'revenue': {
      // SE-039.3 — multi-sheet revenue & closed-deals export.
      const [pipe, win, fva] = await Promise.all([
        computePipelineSummary(scope, window),
        computeWinRate(scope, window),
        computeForecastVsActual(scope, window),
      ]);
      const summary: ExportSheet = {
        name: 'Summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Pipeline Value', money(pipe.revenue.pipelineValue)],
          ['Weighted Forecast', money(pipe.revenue.forecastRevenue)],
          ['Won Value', money(pipe.revenue.wonValue)],
          ['Lost Value', money(pipe.revenue.lostValue)],
          ['Closed Won Deals', pipe.totals.won],
          ['Closed Lost Deals', pipe.totals.lost],
          ['Win Rate %', win.overall.winRate ?? 'N/A'],
          ['Forecast (period)', money(fva.forecast)],
          ['Actual (period)', money(fva.actual)],
          ['Achievement %', fva.achievementPct],
        ],
      };
      const byOwner: ExportSheet = {
        name: 'By Owner',
        headers: ['Owner', 'Open', 'Pipeline Value', 'Forecast', 'Won Value'],
        rows: pipe.byOwner.map((o) => [o.name, o.openCount, money(o.pipelineValue), money(o.forecast), money(o.wonValue)]),
      };
      const winSheet: ExportSheet = {
        name: 'Win Rate',
        headers: ['Owner', 'Won', 'Lost', 'Win Rate %'],
        rows: win.byOwner.map((o) => [o.name, o.won, o.lost, o.winRate ?? 'N/A']),
      };
      return [summary, byOwner, winSheet];
    }
    case 'executive': {
      const d = await computeExecutiveAnalytics(window);
      return [{
        name: 'Executive',
        headers: ['Metric', 'Value'],
        rows: [
          ['Won (period)', money(d.revenue.wonThisPeriod)],
          ['Pipeline Value', money(d.revenue.pipelineValue)],
          ['Weighted Forecast', money(d.revenue.forecast)],
          ['Forecast (month)', money(d.forecasting.month)],
          ['Forecast (quarter)', money(d.forecasting.quarter)],
          ['Forecast (year)', money(d.forecasting.year)],
          ['Win Rate %', d.rates.winRate ?? 'N/A'],
          ['Conversion Rate %', d.rates.conversionRate],
          ['Deal Conversion %', d.rates.dealConversionRate],
          ['Project Conversion %', d.rates.projectConversionRate],
        ],
      }];
    }
    default:
      return [{ name: 'Report', headers: ['No data'], rows: [] }];
  }
}

export const exportReport = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const scope = await resolveReportScope(ctx);
    const window = windowFromQuery(req.query as any);
    const type = String(req.query.type || 'pipeline');
    const format: ExportFormat = req.query.format === 'csv' ? 'csv' : 'xlsx';

    // The executive export is org-wide (ignores scope) — gate it like the JSON
    // executive endpoint so a BDE/Viewer cannot exfiltrate company financials.
    if (type === 'executive' && !canViewOrgReports(ctx) && !isManager(ctx)) {
      return res.status(403).json({ error: 'Forbidden: executive analytics are restricted to managers, directors and admins.' });
    }

    const sheets = await buildExportSheets(type, scope, ctx, window);
    const buffer = await buildMultiSheetBuffer(sheets, format);
    const { mime, ext } = exportMeta(format);

    await activityService.logActivity({ actorUserId: ctx.userId, type: 'report_exported', description: `Exported ${type} report as ${ext.toUpperCase()}.` });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.${ext}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
