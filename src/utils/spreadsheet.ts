/**
 * Unified spreadsheet parser for the Lead import workflow.
 *
 * Accepts either a CSV or an XLSX file and returns the same normalized shape
 * (`{ headers, rows }`) the import controller already expects, so the source
 * mapping / validation logic is identical regardless of the upload format.
 *
 * XLSX is read with a small, dependency-free reader: an .xlsx file is a ZIP
 * archive of XML parts. We unzip the entries we need (`sharedStrings.xml` and
 * the first worksheet) using Node's built-in `zlib`, then extract cell values
 * with lightweight regex parsing. Only the first worksheet is used and the
 * first row is treated as the header row. Header keys are trimmed and
 * lower-cased for both formats.
 */

import zlib from 'node:zlib';
import { parseCsv, ParsedCsv } from './csv.js';

const isXlsx = (filename?: string, mimetype?: string): boolean => {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return true;
  const mt = (mimetype || '').toLowerCase();
  return mt.includes('spreadsheetml') || mt === 'application/vnd.ms-excel';
};

// ── Minimal ZIP reader (central-directory based) ───────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

const readZipEntries = (buf: Buffer): Map<string, ZipEntry> => {
  // Locate the End Of Central Directory record by scanning backwards (it may be
  // followed by a comment, so we can't assume it's at a fixed offset).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP/XLSX file (no EOCD record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16); // start of central directory

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

const extractEntry = (buf: Buffer, entry: ZipEntry): string => {
  // Re-read the (variable-length) local header to find where the data starts.
  const lh = entry.localHeaderOffset;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data.toString('utf-8'); // stored
  if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf-8'); // deflate
  throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
};

// ── XLSX cell helpers ──────────────────────────────────────────────────────

const xmlDecode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// Concatenate every <t>…</t> inside a shared-string <si> (handles rich text).
const textOf = (xml: string): string => {
  const parts: string[] = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(xmlDecode(m[1]));
  return parts.join('');
};

const parseSharedStrings = (xml: string): string[] => {
  const strings: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) strings.push(textOf(m[1]));
  return strings;
};

// "B12" → 1 (zero-based column index from the column letters).
const colIndex = (ref: string): number => {
  const letters = ref.replace(/[0-9]+/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

const parseSheet = (xml: string, shared: string[]): string[][] => {
  const matrix: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowM: RegExpExecArray | null;

  while ((rowM = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellM: RegExpExecArray | null;

    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      const attrs = cellM[1] || '';
      const body = cellM[2] || '';
      const refMatch = attrs.match(/r="([A-Z]+\d+)"/);
      const idx = refMatch ? colIndex(refMatch[1]) : cells.length;
      const typeMatch = attrs.match(/t="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : '';

      let value = '';
      if (type === 's') {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        const si = vMatch ? Number(xmlDecode(vMatch[1])) : NaN;
        value = !isNaN(si) && shared[si] !== undefined ? shared[si] : '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? xmlDecode(vMatch[1]) : '';
      }

      cells[idx] = value.trim();
    }

    // Normalise sparse arrays (skipped empty columns) into dense rows.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    if (cells.some((c) => c !== '')) matrix.push(cells);
  }
  return matrix;
};

const parseXlsx = (buffer: Buffer): ParsedCsv => {
  const entries = readZipEntries(buffer);

  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const shared = sharedEntry ? parseSharedStrings(extractEntry(buffer, sharedEntry)) : [];

  // Prefer sheet1.xml; otherwise fall back to the first worksheet part found.
  let sheetEntry = entries.get('xl/worksheets/sheet1.xml');
  if (!sheetEntry) {
    for (const [name, entry] of entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        sheetEntry = entry;
        break;
      }
    }
  }
  if (!sheetEntry) throw new Error('No worksheet found in the XLSX file.');

  const matrix = parseSheet(extractEntry(buffer, sheetEntry), shared);
  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((h) => h.trim().toLowerCase());
  const rows = matrix.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = (cells[idx] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
};

/**
 * Parses an uploaded CSV or XLSX file buffer into normalized header keys and
 * row objects. The format is detected from the filename / mimetype, defaulting
 * to CSV.
 */
export const parseSpreadsheet = async (
  buffer: Buffer,
  filename?: string,
  mimetype?: string,
): Promise<ParsedCsv> => {
  if (isXlsx(filename, mimetype)) return parseXlsx(buffer);
  return parseCsv(buffer.toString('utf-8'));
};
