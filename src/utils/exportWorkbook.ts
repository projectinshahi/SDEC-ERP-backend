import ExcelJS from 'exceljs';

export type ExportFormat = 'xlsx' | 'csv';

/**
 * Serialize a header row + data rows to an XLSX or CSV Buffer using the
 * already-installed exceljs. Shared by the reporting export endpoint so every
 * report exports through one code path.
 */
export async function buildReportBuffer(
  sheetName: string,
  headers: string[],
  rows: (string | number)[][],
  format: ExportFormat,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet((sheetName || 'Report').slice(0, 31));
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((col) => { col.width = 22; });

  const buf = format === 'csv' ? await workbook.csv.writeBuffer() : await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

export interface ExportSheet {
  name: string;
  headers: string[];
  rows: (string | number)[][];
}

/**
 * SE-039.4 — multi-sheet workbook. XLSX writes every sheet; CSV (single-table)
 * falls back to the first sheet. Each sheet gets a bold, frozen header row.
 */
export async function buildMultiSheetBuffer(sheets: ExportSheet[], format: ExportFormat): Promise<Buffer> {
  if (format === 'csv') {
    const first = sheets[0] ?? { name: 'Report', headers: [], rows: [] };
    return buildReportBuffer(first.name, first.headers, first.rows, 'csv');
  }
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets.length ? sheets : [{ name: 'Report', headers: ['No data'], rows: [] }]) {
    const ws = workbook.addWorksheet((s.name || 'Sheet').slice(0, 31));
    ws.addRow(s.headers);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of s.rows) ws.addRow(r);
    ws.columns.forEach((col) => { col.width = 22; });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, s.headers.length) } };
  }
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/** MIME + extension for a format. */
export function exportMeta(format: ExportFormat): { mime: string; ext: string } {
  return format === 'csv'
    ? { mime: 'text/csv', ext: 'csv' }
    : { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}
