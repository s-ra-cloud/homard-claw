/**
 * Pure helpers for the Google Sheets operations: A1-range parsing and
 * bounding, JSON row-values validation, and RowData conversion. No I/O
 * lives here — every limit is enforced before a request is ever built, and
 * everything is unit-testable in isolation.
 */

/** Hard caps keeping reads and mutations bounded and reviewable. */
export const MAX_READ_CELLS = 5_000;
export const MAX_MUTATION_CELLS = 500;
export const MAX_APPEND_ROWS = 100;
/** Longest string a single cell may carry. */
export const MAX_CELL_CHARS = 2_000;

/** Grid bounds we accept (Sheets itself caps a document at 10M cells). */
const MAX_COLUMNS = 18_278; // "ZZZ"
const MAX_ROW = 1_000_000;

export type ParsedA1Range = {
  /** Tab title, or null when the range named no tab (Sheets uses the first). */
  tab: string | null;
  /** GridRange-style: 0-based start, exclusive end. */
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  rowCount: number;
  columnCount: number;
  cellCount: number;
  /** Canonical A1 text (tab quoted when present), safe to send to Google. */
  normalized: string;
};

export type A1ParseResult =
  | { ok: true; range: ParsedA1Range }
  | { ok: false; error: string };

/** "A" → 0, "Z" → 25, "AA" → 26 ... */
export function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 0 → "A", 25 → "Z", 26 → "AA" ... */
export function indexToColumn(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Quote a tab title for A1 notation (embedded ' doubles). */
export function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

/**
 * Parse an explicit, BOUNDED A1 range like "Sheet1!A1:D50",
 * "'Q3 Budget'!B2:B2", or a single cell "A1". Open-ended references
 * ("A:A", "Sheet1!1:20", "A1:C") are rejected: every operation works on a
 * rectangle whose size is known before any request is made. Corners are
 * normalized so the start is always the top-left.
 */
export function parseA1Range(input: string): A1ParseResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "The range is empty." };
  let tab: string | null = null;
  let rangePart = text;
  const bang = text.lastIndexOf("!");
  if (bang >= 0) {
    let rawTab = text.slice(0, bang).trim();
    rangePart = text.slice(bang + 1).trim();
    if (rawTab.startsWith("'") && rawTab.endsWith("'") && rawTab.length >= 2) {
      rawTab = rawTab.slice(1, -1).replace(/''/g, "'");
    }
    if (!rawTab) {
      return { ok: false, error: "The tab name before '!' is empty." };
    }
    if (rawTab.length > 100) {
      return { ok: false, error: "The tab name exceeds 100 characters." };
    }
    tab = rawTab;
  }
  const corners = rangePart.split(":");
  if (corners.length > 2) {
    return {
      ok: false,
      error: `"${rangePart}" is not a valid A1 range (too many ':').`,
    };
  }
  const first = CELL_REF.exec(corners[0]!.trim());
  const second =
    corners.length === 2 ? CELL_REF.exec(corners[1]!.trim()) : first;
  if (!first || !second) {
    return {
      ok: false,
      error: `"${rangePart}" is not a bounded A1 range. Use explicit corners like A1:D50 — open-ended ranges (A:A, 1:20) are not allowed.`,
    };
  }
  const colA = columnToIndex(first[1]!);
  const rowA = Number(first[2]);
  const colB = columnToIndex(second[1]!);
  const rowB = Number(second[2]);
  if (rowA < 1 || rowB < 1) {
    return { ok: false, error: "Row numbers start at 1." };
  }
  if (Math.max(rowA, rowB) > MAX_ROW || Math.max(colA, colB) >= MAX_COLUMNS) {
    return { ok: false, error: "The range lies outside the supported grid." };
  }
  const startColumnIndex = Math.min(colA, colB);
  const endColumnIndex = Math.max(colA, colB) + 1;
  const startRowIndex = Math.min(rowA, rowB) - 1;
  const endRowIndex = Math.max(rowA, rowB);
  const rowCount = endRowIndex - startRowIndex;
  const columnCount = endColumnIndex - startColumnIndex;
  const normalized = `${tab ? `${quoteTab(tab)}!` : ""}${indexToColumn(startColumnIndex)}${startRowIndex + 1}:${indexToColumn(endColumnIndex - 1)}${endRowIndex}`;
  return {
    ok: true,
    range: {
      tab,
      startRowIndex,
      endRowIndex,
      startColumnIndex,
      endColumnIndex,
      rowCount,
      columnCount,
      cellCount: rowCount * columnCount,
      normalized,
    },
  };
}

/** One validated cell value. Strings beginning with "=" become formulas. */
export type SheetCell = string | number | boolean | null;

export type SheetValuesResult =
  | {
      ok: true;
      rows: SheetCell[][];
      rowCount: number;
      /** Width of the widest row. */
      columnCount: number;
      cellCount: number;
      /** True when every row has the same length. */
      rectangular: boolean;
    }
  | { ok: false; error: string };

/**
 * Parse and bound the `values` param: a JSON array of row arrays whose
 * cells are strings, numbers, booleans, or null. Anything else — objects,
 * nested arrays, non-finite numbers, oversized cells — is rejected with a
 * message the agent can act on.
 */
export function parseSheetValues(
  raw: string,
  limits: { maxRows: number; maxCells: number },
): SheetValuesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error:
        'values must be valid JSON: an array of row arrays, e.g. [["Name","Total"],["Ada",42]].',
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "values must be a non-empty JSON array of row arrays." };
  }
  if (parsed.length > limits.maxRows) {
    return {
      ok: false,
      error: `values has ${parsed.length} rows; the maximum here is ${limits.maxRows}.`,
    };
  }
  const rows: SheetCell[][] = [];
  let cellCount = 0;
  let columnCount = 0;
  let rectangular = true;
  for (const [i, row] of parsed.entries()) {
    if (!Array.isArray(row) || row.length === 0) {
      return {
        ok: false,
        error: `values row ${i + 1} must be a non-empty array of cells.`,
      };
    }
    const cells: SheetCell[] = [];
    for (const [j, cell] of row.entries()) {
      if (cell === null || typeof cell === "boolean") {
        cells.push(cell);
      } else if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          return {
            ok: false,
            error: `values row ${i + 1}, cell ${j + 1} is not a finite number.`,
          };
        }
        cells.push(cell);
      } else if (typeof cell === "string") {
        if (cell.length > MAX_CELL_CHARS) {
          return {
            ok: false,
            error: `values row ${i + 1}, cell ${j + 1} exceeds ${MAX_CELL_CHARS} characters.`,
          };
        }
        cells.push(cell);
      } else {
        return {
          ok: false,
          error: `values row ${i + 1}, cell ${j + 1} must be a string, number, boolean, or null.`,
        };
      }
    }
    cellCount += cells.length;
    if (rows.length > 0 && cells.length !== rows[0]!.length) rectangular = false;
    columnCount = Math.max(columnCount, cells.length);
    rows.push(cells);
  }
  if (cellCount > limits.maxCells) {
    return {
      ok: false,
      error: `values carries ${cellCount} cells; the maximum here is ${limits.maxCells}.`,
    };
  }
  return {
    ok: true,
    rows,
    rowCount: rows.length,
    columnCount,
    cellCount,
    rectangular,
  };
}

/** Sheets API ExtendedValue for one validated cell. */
type ExtendedValue =
  | { stringValue: string }
  | { numberValue: number }
  | { boolValue: boolean }
  | { formulaValue: string };

/**
 * Convert validated rows to Sheets RowData for updateCells/appendCells.
 * Strings starting with "=" are written as formulas (the owner-approved
 * payload carries them verbatim); null leaves the cell blank.
 */
export function rowsToRowData(
  rows: SheetCell[][],
): { values: { userEnteredValue?: ExtendedValue }[] }[] {
  return rows.map((row) => ({
    values: row.map((cell) => {
      if (cell === null) return {};
      if (typeof cell === "number") {
        return { userEnteredValue: { numberValue: cell } };
      }
      if (typeof cell === "boolean") {
        return { userEnteredValue: { boolValue: cell } };
      }
      if (cell.startsWith("=")) {
        return { userEnteredValue: { formulaValue: cell } };
      }
      return { userEnteredValue: { stringValue: cell } };
    }),
  }));
}
