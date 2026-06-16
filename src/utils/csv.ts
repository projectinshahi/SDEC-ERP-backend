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
