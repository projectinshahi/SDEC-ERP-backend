import { Request, Response } from 'express';
import {
  parseAnalyticsWindow,
  computeAttendanceSummary,
  computeStatusDistribution,
  computeAttendanceTrend,
  computeDepartmentRanking,
  computeRankings,
  computeEmployeeReport,
  computeEmployeeDetail,
  computeCompanyLeaveBreakdown,
  computeEmployeeReportExport,
  EMPLOYEE_REPORT_SORT_KEYS,
  type AttendanceFilters,
  type RankingMetric,
} from '../../services/attendanceAnalytics.service.js';
import {
  buildMultiSheetBuffer,
  exportMeta,
  type ExportFormat,
  type ExportSheet,
} from '../../utils/exportWorkbook.js';

/**
 * Attendance Analytics — HTTP handlers (Phase 1, Milestones 2 & 3.1).
 *
 * Thin wrappers over attendanceAnalytics.service (single source of metric math),
 * mirroring the Sales reports controller. Read-only; gated in the router by
 * `hr.analytics.view | hr.view`. Envelope: success → { success:true, data },
 * failure → { success:false, error } with the appropriate HTTP status.
 */

const strParam = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isSet = (v: string): boolean => v !== '' && v.toLowerCase() !== 'all';
const parseBool = (v: unknown): boolean => ['true', '1', 'yes'].includes(strParam(v).toLowerCase());

const VALID_RANKING_METRICS: RankingMetric[] = [
  'perfect_attendance',
  'most_absent',
  'most_late',
  'low_attendance',
];

type FilterResult =
  | { ok: true; filters: AttendanceFilters }
  | { ok: false; message: string };

/** Parse the shared analytics filters (window + department + employeeId). */
function parseFilters(req: Request): FilterResult {
  const win = parseAnalyticsWindow(req.query as Record<string, any>);
  if (!win.ok) return { ok: false, message: win.message };

  let employeeId: number | undefined;
  const employeeIdRaw = strParam(req.query.employeeId);
  if (employeeIdRaw !== '') {
    const n = Number(employeeIdRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, message: 'employeeId must be a positive integer.' };
    }
    employeeId = n;
  }

  const department = strParam(req.query.department);
  return {
    ok: true,
    filters: {
      from: win.window.from,
      to: win.window.to,
      department: isSet(department) ? department : undefined,
      employeeId,
    },
  };
}

/** GET /hr/analytics/summary */
export const getAnalyticsSummary = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });
    const data = await computeAttendanceSummary(parsed.filters);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building attendance summary:', error);
    return res.status(500).json({ success: false, error: 'Failed to build attendance summary' });
  }
};

/** GET /hr/analytics/status-distribution */
export const getAnalyticsStatusDistribution = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });
    const data = await computeStatusDistribution(parsed.filters);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building status distribution:', error);
    return res.status(500).json({ success: false, error: 'Failed to build status distribution' });
  }
};

/** GET /hr/analytics/trend?granularity=day|week|month&compare=true */
export const getAnalyticsTrend = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });

    const granularityRaw = strParam(req.query.granularity).toLowerCase();
    if (granularityRaw && !['day', 'week', 'month'].includes(granularityRaw)) {
      return res.status(400).json({ success: false, error: 'granularity must be day, week or month.' });
    }
    const data = await computeAttendanceTrend(parsed.filters, {
      granularity: granularityRaw || undefined,
      compare: parseBool(req.query.compare),
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building attendance trend:', error);
    return res.status(500).json({ success: false, error: 'Failed to build attendance trend' });
  }
};

/** GET /hr/analytics/by-department?compare=true  (Department Ranking) */
export const getAnalyticsDepartmentRanking = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });
    const data = await computeDepartmentRanking(parsed.filters, { compare: parseBool(req.query.compare) });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building department ranking:', error);
    return res.status(500).json({ success: false, error: 'Failed to build department ranking' });
  }
};

/** GET /hr/analytics/rankings?metric=&limit=&threshold= */
export const getAnalyticsRankings = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });

    const metricRaw = strParam(req.query.metric).toLowerCase();
    if (metricRaw && !VALID_RANKING_METRICS.includes(metricRaw as RankingMetric)) {
      return res
        .status(400)
        .json({ success: false, error: `metric must be one of: ${VALID_RANKING_METRICS.join(', ')}.` });
    }

    const limitRaw = Number(strParam(req.query.limit));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(50, limitRaw) : 10;

    const thresholdRaw = Number(strParam(req.query.threshold));
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 100 ? thresholdRaw : 90;

    const data = await computeRankings(parsed.filters, {
      metric: metricRaw ? (metricRaw as RankingMetric) : undefined,
      limit,
      threshold,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building rankings:', error);
    return res.status(500).json({ success: false, error: 'Failed to build rankings' });
  }
};

/** GET /hr/analytics/employee-report?page&pageSize&sort&order&search&threshold */
export const getAnalyticsEmployeeReport = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });

    const pageRaw = Number(strParam(req.query.page));
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    const pageSizeRaw = Number(strParam(req.query.pageSize));
    const pageSize =
      Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 25;

    const sortRaw = strParam(req.query.sort);
    if (sortRaw && !EMPLOYEE_REPORT_SORT_KEYS.includes(sortRaw)) {
      return res
        .status(400)
        .json({ success: false, error: `sort must be one of: ${EMPLOYEE_REPORT_SORT_KEYS.join(', ')}.` });
    }
    const sort = sortRaw || 'attendancePct';

    const orderRaw = strParam(req.query.order).toLowerCase();
    if (orderRaw && orderRaw !== 'asc' && orderRaw !== 'desc') {
      return res.status(400).json({ success: false, error: 'order must be asc or desc.' });
    }
    const order: 'asc' | 'desc' = orderRaw === 'desc' ? 'desc' : 'asc';

    const search = strParam(req.query.search) || undefined;

    const thresholdRaw = Number(strParam(req.query.threshold));
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 100 ? thresholdRaw : 90;

    const data = await computeEmployeeReport(parsed.filters, {
      page,
      pageSize,
      sort,
      order,
      search,
      threshold,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building employee report:', error);
    return res.status(500).json({ success: false, error: 'Failed to build employee report' });
  }
};

/** GET /hr/analytics/employee/:id  (Employee drill-down — M3.3) */
export const getAnalyticsEmployeeDetail = async (req: Request, res: Response) => {
  try {
    const id = Number(strParam(req.params.id));
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Employee id must be a positive integer.' });
    }

    const win = parseAnalyticsWindow(req.query as Record<string, any>);
    if (!win.ok) return res.status(400).json({ success: false, error: win.message });

    const data = await computeEmployeeDetail({
      from: win.window.from,
      to: win.window.to,
      employeeId: id,
    });
    if (!data) return res.status(404).json({ success: false, error: 'Employee not found.' });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error building employee detail:', error);
    return res.status(500).json({ success: false, error: 'Failed to build employee detail' });
  }
};

/* =============================================================================
   Export (Milestone 4.1) — Excel / CSV. Thin handler over the shared exceljs
   builder (buildMultiSheetBuffer/exportMeta); all data comes from the analytics
   service (no metric math here). PDF is client-side (M4.3), not this endpoint.
============================================================================= */

const VALID_EXPORT_TYPES = ['workbook', 'summary', 'departments', 'employees', 'leaves'] as const;
type ExportType = (typeof VALID_EXPORT_TYPES)[number];

/** Options threaded into the employee sheet + Summary branding band. */
interface ExportSheetOptions {
  sort: string;
  order: 'asc' | 'desc';
  threshold: number;
  search?: string;
  generatedAt: string;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** attachment filename: workbook → Attendance_Analytics_<from>_to_<to>.<ext>;
 *  single table → Attendance_<Type>_<from>_to_<to>.<ext>. */
function buildExportFilename(type: ExportType, ext: string, f: AttendanceFilters): string {
  const range = `${f.from}_to_${f.to}`;
  if (type === 'workbook') return `Attendance_Analytics_${range}.${ext}`;
  return `Attendance_${capitalize(type)}_${range}.${ext}`;
}

async function buildSummarySheet(f: AttendanceFilters, generatedAt: string): Promise<ExportSheet> {
  const [summary, dist] = await Promise.all([
    computeAttendanceSummary(f),
    computeStatusDistribution(f),
  ]);
  const rows: (string | number)[][] = [
    ['Report', 'Attendance Analytics'],
    ['Company', 'SHAHI SOLUTIONS'],
    ['Period', `${f.from} to ${f.to} (${summary.range.days} days)`],
    ['Department', f.department ?? 'All'],
    ['Employee', f.employeeId != null ? `#${f.employeeId}` : 'All'],
    ['Generated At', generatedAt],
    ['', ''],
    ['Total Employees', summary.totalEmployees],
    ['Present', summary.present],
    ['Absent', summary.absent],
    ['Late', summary.late],
    ['Half Day Leave', summary.halfDay],
    ['Full Day Leave', summary.fullDayLeave],
    ['Approved Leave Days', summary.approvedLeaveDays],
    ['Working Days', summary.workingDays],
    ['Attendance %', summary.attendancePct],
    ['', ''],
    ['Status Distribution', `${dist.total} records`],
    ...dist.segments.map((s) => [s.label, `${s.count} (${s.pct}%)`] as (string | number)[]),
  ];
  return { name: 'Summary', headers: ['Metric', 'Value'], rows };
}

async function buildDepartmentsSheet(f: AttendanceFilters): Promise<ExportSheet> {
  const dept = await computeDepartmentRanking(f);
  const headers = [
    'Rank', 'Department', 'Headcount', 'Present', 'Absent', 'Late', 'Leave Days',
    'Working Days', 'Attendance %', 'Absenteeism %', 'Punctuality %', 'LOP*', 'Payable*',
  ];
  const rows = dept.departments.map((d) => [
    d.rank, d.department, d.headcount, d.present, d.absent, d.late, d.leaveDays,
    d.workingDays, d.attendancePct, d.absenteeismPct, d.punctualityPct, d.lopDays, d.payableDays,
  ]);
  return { name: 'Department Analytics', headers, rows };
}

async function buildEmployeesSheet(f: AttendanceFilters, opts: ExportSheetOptions): Promise<ExportSheet> {
  const { rows: report } = await computeEmployeeReportExport(f, {
    sort: opts.sort,
    order: opts.order,
    threshold: opts.threshold,
    search: opts.search,
  });
  const headers = [
    'Employee Code', 'Name', 'Department', 'Designation', 'Working Days', 'Present', 'Absent',
    'Late', 'Half Day', 'Full Day Leave', 'Attendance %', 'Absenteeism %', 'Punctuality %',
    'LOP*', 'Payable*', 'Perfect', 'At Risk',
  ];
  const rows = report.map((e) => [
    e.employeeCode, e.name, e.department, e.designation, e.workingDays, e.present, e.absent,
    e.late, e.halfDay, e.fullDayLeave, e.attendancePct, e.absenteeismPct, e.punctualityPct,
    e.lopDays, e.payableDays, e.perfectAttendance ? 'Yes' : 'No', e.atRisk ? 'Yes' : 'No',
  ]);
  return { name: 'Employee Report', headers, rows };
}

async function buildLeavesSheet(f: AttendanceFilters): Promise<ExportSheet> {
  const lb = await computeCompanyLeaveBreakdown(f);
  const headers = ['Leave Type', 'Requests', 'Days', 'Approved', 'Pending', 'Rejected'];
  const rows: (string | number)[][] = lb.items.map((i) => [
    i.leaveType, i.requests, i.days, i.approved, i.pending, i.rejected,
  ]);
  if (lb.items.length) rows.push(['Total', lb.totalRequests, lb.totalDays, '', '', '']);
  return { name: 'Leave Breakdown', headers, rows };
}

/** Build the sheet set for a requested export type (only the needed queries run). */
async function buildAttendanceExportSheets(
  type: ExportType,
  f: AttendanceFilters,
  opts: ExportSheetOptions,
): Promise<ExportSheet[]> {
  switch (type) {
    case 'summary':
      return [await buildSummarySheet(f, opts.generatedAt)];
    case 'departments':
      return [await buildDepartmentsSheet(f)];
    case 'employees':
      return [await buildEmployeesSheet(f, opts)];
    case 'leaves':
      return [await buildLeavesSheet(f)];
    case 'workbook':
    default:
      return Promise.all([
        buildSummarySheet(f, opts.generatedAt),
        buildDepartmentsSheet(f),
        buildEmployeesSheet(f, opts),
        buildLeavesSheet(f),
      ]);
  }
}

/** GET /hr/analytics/export?format=xlsx|csv&type=workbook|summary|departments|employees|leaves */
export const exportAnalytics = async (req: Request, res: Response) => {
  try {
    const parsed = parseFilters(req);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.message });

    const formatRaw = strParam(req.query.format).toLowerCase() || 'xlsx';
    if (formatRaw !== 'xlsx' && formatRaw !== 'csv') {
      return res.status(400).json({ success: false, error: 'format must be xlsx or csv.' });
    }
    const format = formatRaw as ExportFormat;

    const typeRaw = strParam(req.query.type).toLowerCase() || 'workbook';
    if (!VALID_EXPORT_TYPES.includes(typeRaw as ExportType)) {
      return res
        .status(400)
        .json({ success: false, error: `type must be one of: ${VALID_EXPORT_TYPES.join(', ')}.` });
    }
    // CSV is single-table: a 'workbook' request degrades to the Employee Report.
    const type: ExportType =
      format === 'csv' && typeRaw === 'workbook' ? 'employees' : (typeRaw as ExportType);

    // Employee-sheet sort/order/threshold/search — reuse the report whitelist.
    const sortRaw = strParam(req.query.sort);
    if (sortRaw && !EMPLOYEE_REPORT_SORT_KEYS.includes(sortRaw)) {
      return res
        .status(400)
        .json({ success: false, error: `sort must be one of: ${EMPLOYEE_REPORT_SORT_KEYS.join(', ')}.` });
    }
    const sort = sortRaw || 'attendancePct';

    const orderRaw = strParam(req.query.order).toLowerCase();
    if (orderRaw && orderRaw !== 'asc' && orderRaw !== 'desc') {
      return res.status(400).json({ success: false, error: 'order must be asc or desc.' });
    }
    const order: 'asc' | 'desc' = orderRaw === 'desc' ? 'desc' : 'asc';

    const thresholdRaw = Number(strParam(req.query.threshold));
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 100 ? thresholdRaw : 90;
    const search = strParam(req.query.search) || undefined;

    const generatedAt = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    });

    const sheets = await buildAttendanceExportSheets(type, parsed.filters, {
      sort,
      order,
      threshold,
      search,
      generatedAt,
    });
    const buffer = await buildMultiSheetBuffer(sheets, format);
    const { mime, ext } = exportMeta(format);
    const filename = buildExportFilename(type, ext, parsed.filters);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('Error exporting attendance analytics:', error);
    return res.status(500).json({ success: false, error: 'Failed to export attendance analytics' });
  }
};
