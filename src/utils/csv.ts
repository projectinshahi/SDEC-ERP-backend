import type { Response } from 'express';

/**
 * Minimal, dependency-free CSV parser used by the Lead import workflow.
 *
 * Supports quoted fields (with embedded commas, quotes and newlines) and both
 * \n and \r\n line endings. Returns an array of row objects keyed by the
 * (trimmed, lower-cased) header names so callers can map columns regardless of
 * the original casing/spacing in the uploaded file.
 */

const splitRows = (content: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Handle \r\n as a single line break.
      if (char === '\r' && content[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Flush the trailing field/row if the file does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
};

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parses raw CSV text into normalized header keys and row objects.
 * Empty rows (all cells blank) are skipped.
 */
export const parseCsv = (content: string): ParsedCsv => {
  const raw = splitRows(content).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => h.trim().toLowerCase());
  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = (cells[idx] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
};


/**
 * M10 #47/#48 — THE shared CSV writer.
 *
 * One serializer, one escaping rule, one filename convention and one download
 * response. Each export supplies only its own column definitions, so the two
 * exports cannot drift into two different notions of "a safe CSV".
 */

export interface CsvColumn<T> {
  header: string;
  /** Return the raw value; formatting and escaping happen here, once. */
  value: (row: T) => unknown;
}

/**
 * Characters that make Excel / Sheets treat a cell as a FORMULA. A value
 * beginning with one of these is prefixed with a single quote so the
 * spreadsheet shows the literal text instead of evaluating it — the standard
 * defence against CSV injection (e.g. a card titled `=cmd|'/c calc'!A0`).
 *
 * The prefix is only added when the value actually starts with one of them, so
 * ordinary values — including negative numbers, which are emitted as numbers —
 * are never altered.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

function escapeCell(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  // Numbers are written as-is: a negative number must stay a number, not become
  // text, so the formula guard below deliberately only applies to strings.
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return raw ? 'TRUE' : 'FALSE';

  let s = String(raw);
  if (s.length && FORMULA_TRIGGERS.includes(s[0])) s = `'${s}`;
  // RFC 4180: wrap in quotes when the value contains a comma, a quote or a line
  // break, and double any embedded quote. Line breaks are PRESERVED inside the
  // quoted field rather than stripped, so multi-line text survives a round trip.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize rows to CSV text (header row + data rows, CRLF per RFC 4180). */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  return lines.join('\r\n');
}

/** Local calendar date as YYYY-MM-DD — the filename convention for exports. */
export function exportDateStamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Send a CSV download. A UTF-8 BOM is prepended so Excel renders accented and
 * non-Latin characters correctly instead of mojibake.
 */
export function sendCsv(res: Response, baseName: string, csv: string): void {
  const filename = `${baseName}_${exportDateStamp()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Exposed so a browser fetch() can read the filename off the response.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.send(`﻿${csv}`);
}
