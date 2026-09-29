import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import prisma from '../config/db.js';
import { getSalesAuth } from '../utils/salesAuth.js';
import {
  EXPENSE_VIEW_KEYS, REPORT_EXPORT_KEYS, canAny,
  buildExpenseWhere, loadExpenses, summarize, isYmd, money,
  type ExpenseRow, type CategoryTotal,
} from '../services/marketingFinance.service.js';

/**
 * MK-004.6 — per-client expense report.
 *
 * ONE builder feeds BOTH formats. `GET .../export` returns the report as JSON
 * (the PDF is rendered from exactly this payload) and `GET .../export.xlsx`
 * streams the same object as a workbook. Neither recomputes anything: rows,
 * category totals and the grand total all come from the shared
 * marketingFinance service that the on-screen dashboard also calls, so the
 * screen, the spreadsheet and the PDF cannot report different numbers.
 *
 * SCOPE: approved rows only, which is the MK-004.3 reporting rule. Pending and
 * rejected submissions are never exported — they are not yet (or never will be)
 * client spend.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export interface ExpenseReport {
  client: { id: number; name: string };
  range: { from: string | null; to: string | null };
  generatedAt: string;
  currency: 'INR';
  scope: string;
  rows: ExpenseRow[];
  categories: CategoryTotal[];
  grandTotal: number;
  count: number;
}

/** Report parameters, validated. Returns a field error rather than an empty
 *  report when the request itself is wrong. */
type ParamResult =
  | { error: string; fieldErrors: Record<string, string>; status: number }
  | { clientId: number; from: string | null; to: string | null };

function readParams(req: Request): ParamResult {
  const clientId = intId(req.query.clientId);
  if (!clientId) {
    return {
      status: 400,
      error: 'Choose a client to export.',
      fieldErrors: { clientId: 'Choose a client to export.' },
    };
  }
  const from = isYmd(req.query.from) ? String(req.query.from).trim() : null;
  const to = isYmd(req.query.to) ? String(req.query.to).trim() : null;

  // A reversed range is a mistake, not an empty report — say so.
  if (from && to && to < from) {
    return {
      status: 400,
      error: 'The end date cannot be earlier than the start date.',
      fieldErrors: { to: 'The end date cannot be earlier than the start date.' },
    };
  }
  // A malformed date silently ignored would export the WRONG range and look
  // successful, so reject it explicitly.
  for (const [k, raw] of [['from', req.query.from], ['to', req.query.to]] as const) {
    if (raw !== undefined && raw !== '' && !isYmd(raw)) {
      return { status: 400, error: 'Enter a valid date.', fieldErrors: { [k]: 'Enter a valid date.' } };
    }
  }
  return { clientId, from, to };
}

/** Build the report. No `take`: a report is never silently truncated to a page. */
async function buildReport(clientId: number, from: string | null, to: string | null): Promise<ExpenseReport | null> {
  const client = await prisma.marketing_clients.findFirst({
    where: { id: clientId, active: true }, select: { id: true, name: true },
  });
  // Same answer for "no such client" and "inactive client": probing ids must not
  // reveal which clients exist.
  if (!client) return null;

  const where = buildExpenseWhere({ clientId, from, to }, true);
  const rows = await loadExpenses(where);
  const { total, categories } = summarize(rows);

  return {
    client,
    range: { from, to },
    generatedAt: new Date().toISOString(),
    currency: 'INR',
    scope: 'Approved expenses only',
    rows,
    categories,
    grandTotal: total,
    count: rows.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/expenses/export — the report as JSON (the PDF source)
// ─────────────────────────────────────────────────────────────────────────────
export const getExpenseReport = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    // Exporting needs BOTH the right to see the figures and the right to take
    // them out of the system.
    if (!canAny(ctx, EXPENSE_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing expenses.' });
    }
    if (!canAny(ctx, REPORT_EXPORT_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to export Marketing reports.' });
    }

    const p = readParams(req);
    if ('error' in p) return res.status(p.status).json({ error: p.error, fieldErrors: p.fieldErrors });

    const report = await buildReport(p.clientId, p.from, p.to);
    if (!report) return res.status(404).json({ error: 'Client not found.' });

    // An empty range is a VALID report with zero rows and a zero total — not an
    // error, and not fabricated rows.
    return res.json({ success: true, report });
  } catch (error) {
    console.error('Error building expense report:', error);
    return res.status(500).json({ error: 'Failed to build the expense report' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/expenses/export.xlsx — the same report as a workbook
// ─────────────────────────────────────────────────────────────────────────────
export const exportExpensesXlsx = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing expenses.' });
    }
    if (!canAny(ctx, REPORT_EXPORT_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to export Marketing reports.' });
    }

    const p = readParams(req);
    if ('error' in p) return res.status(p.status).json({ error: p.error, fieldErrors: p.fieldErrors });

    const report = await buildReport(p.clientId, p.from, p.to);
    if (!report) return res.status(404).json({ error: 'Client not found.' });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SDEC ERP';
    wb.created = new Date();

    /* Sheet 1 — line items. Written row by row from `report.rows`; amounts go in
     * as NUMBERS with a currency format, so Excel can sum them and the reader
     * gets a real spreadsheet rather than text that looks like money. */
    const ws = wb.addWorksheet('Expenses');
    const rangeLabel = report.range.from || report.range.to
      ? `${report.range.from ?? 'start'} to ${report.range.to ?? 'today'}`
      : 'All dates';
    ws.addRow([`Expense report — ${report.client.name}`]);
    ws.addRow([`Period: ${rangeLabel}`]);
    ws.addRow([`Scope: ${report.scope}`]);
    ws.addRow([`Generated: ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC`]);
    ws.addRow([]);
    ws.getRow(1).font = { bold: true, size: 14 };

    const header = ['Date', 'Category', 'Title', 'Project', 'Vendor', 'Description', 'Amount (INR)'];
    const headerRow = ws.addRow(header);
    headerRow.font = { bold: true };
    const headerIndex = headerRow.number;

    for (const r of report.rows) {
      ws.addRow([
        r.date ?? '', r.category, r.title, r.projectName ?? '',
        r.vendor ?? '', r.notes ?? '', r.amount,
      ]);
    }

    const totalRow = ws.addRow(['', '', '', '', '', 'Grand total', report.grandTotal]);
    totalRow.font = { bold: true };

    ws.columns = [
      { width: 12 }, { width: 18 }, { width: 34 }, { width: 24 },
      { width: 20 }, { width: 40 }, { width: 16 },
    ];
    // Amount column, from the header row down, as currency.
    for (let i = headerIndex; i <= totalRow.number; i++) {
      ws.getCell(i, 7).numFmt = i === headerIndex ? 'General' : '#,##0.00';
      ws.getCell(i, 7).alignment = { horizontal: 'right' };
    }

    /* Sheet 2 — category totals, from the SAME `summarize()` output the line
     * items were built from, so the two sheets always reconcile. */
    const cs = wb.addWorksheet('Category totals');
    const cHeader = cs.addRow(['Category', 'Expenses', 'Amount (INR)', 'Share %']);
    cHeader.font = { bold: true };
    for (const c of report.categories) cs.addRow([c.name, c.count, c.amount, c.percent]);
    const cTotal = cs.addRow(['Grand total', report.count, report.grandTotal, report.count ? 100 : 0]);
    cTotal.font = { bold: true };
    cs.columns = [{ width: 26 }, { width: 12 }, { width: 16 }, { width: 10 }];
    for (let i = cHeader.number + 1; i <= cTotal.number; i++) cs.getCell(i, 3).numFmt = '#,##0.00';

    // An empty report still produces a valid, readable workbook with headers and
    // a zero total — never a broken or blank file.
    if (!report.rows.length) {
      ws.addRow([]);
      ws.addRow(['No approved expenses in this period.']);
    }

    const buffer = await wb.xlsx.writeBuffer();
    const safeClient = report.client.name.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="expenses-${safeClient}-${report.range.from ?? 'all'}-${report.range.to ?? 'all'}.xlsx"`,
    );
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Error exporting expenses to Excel:', error);
    return res.status(500).json({ error: 'Failed to export the expense report' });
  }
};

/**
 * MK-004.5 → MK-004.1 — influencer spend for a client, so the cost dashboard can
 * show committed influencer fees beside logged expenses WITHOUT the fee being
 * copied into finance_expense. One amount, one row, two readers.
 */
export async function influencerSpendForClient(
  clientId: number, from: string | null, to: string | null,
): Promise<{ committed: number; paid: number; pending: number; count: number }> {
  const where: Record<string, unknown> = {
    client_id: clientId,
    payment_status: { in: ['pending', 'paid'] },
  };
  if (from || to) {
    // A campaign counts if it OVERLAPS the window.
    if (to) where.start_date = { lte: new Date(`${to}T00:00:00.000Z`) };
    if (from) where.end_date = { gte: new Date(`${from}T00:00:00.000Z`) };
  }
  const rows = await prisma.marketing_influencers.findMany({
    where, select: { fee: true, payment_status: true },
  });
  const sum = (s: string) => money(rows.filter((r) => r.payment_status === s)
    .reduce((a, r) => a + Number(r.fee), 0));
  return {
    committed: money(rows.reduce((a, r) => a + Number(r.fee), 0)),
    paid: sum('paid'),
    pending: sum('pending'),
    count: rows.length,
  };
}
