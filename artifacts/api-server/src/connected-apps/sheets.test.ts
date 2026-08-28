import { describe, expect, it } from "vitest";
import {
  MAX_CELL_CHARS,
  columnToIndex,
  indexToColumn,
  parseA1Range,
  parseSheetValues,
  quoteTab,
  rowsToRowData,
} from "./sheets";

describe("column letters", () => {
  it("round-trips indices and letters", () => {
    for (const [letters, index] of [
      ["A", 0],
      ["Z", 25],
      ["AA", 26],
      ["AZ", 51],
      ["BA", 52],
      ["ZZ", 701],
      ["AAA", 702],
    ] as const) {
      expect(columnToIndex(letters)).toBe(index);
      expect(indexToColumn(index)).toBe(letters);
    }
  });
});

describe("parseA1Range", () => {
  it("parses a plain bounded range with a tab", () => {
    const parsed = parseA1Range("Sheet1!A1:D50");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.range).toMatchObject({
      tab: "Sheet1",
      startRowIndex: 0,
      endRowIndex: 50,
      startColumnIndex: 0,
      endColumnIndex: 4,
      rowCount: 50,
      columnCount: 4,
      cellCount: 200,
      normalized: "'Sheet1'!A1:D50",
    });
  });

  it("parses quoted tab names, unescaping doubled quotes", () => {
    const parsed = parseA1Range("'Q3 ''Budget'''!B2:C3");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.range.tab).toBe("Q3 'Budget'");
    expect(parsed.range.normalized).toBe("'Q3 ''Budget'''!B2:C3");
  });

  it("accepts a single cell as a 1x1 range and tolerates $ anchors", () => {
    const parsed = parseA1Range("$B$2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.range).toMatchObject({
      tab: null,
      rowCount: 1,
      columnCount: 1,
      cellCount: 1,
      normalized: "B2:B2",
    });
  });

  it("normalizes reversed corners so the start is top-left", () => {
    const parsed = parseA1Range("Sheet1!D50:A1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.range.normalized).toBe("'Sheet1'!A1:D50");
  });

  it("rejects open-ended and malformed ranges", () => {
    for (const bad of [
      "",
      "Sheet1!A:A", // unbounded rows
      "Sheet1!1:20", // unbounded columns
      "Sheet1!A1:C", // corner without a row
      "Sheet1!A1:B2:C3",
      "Sheet1!", // empty range part
      "!A1:B2", // empty tab
      "Sheet1!AAAA1:B2", // beyond the grid
    ]) {
      const parsed = parseA1Range(bad);
      expect(parsed.ok, `expected rejection: ${JSON.stringify(bad)}`).toBe(
        false,
      );
    }
  });
});

describe("parseSheetValues", () => {
  const limits = { maxRows: 10, maxCells: 20 };

  it("accepts rows of strings, numbers, booleans, and null", () => {
    const parsed = parseSheetValues(
      '[["Name","Total"],["Ada",42],["Bob",null],["Flag",true]]',
      limits,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rowCount).toBe(4);
    expect(parsed.columnCount).toBe(2);
    expect(parsed.cellCount).toBe(8);
    expect(parsed.rectangular).toBe(true);
  });

  it("flags ragged rows without rejecting them", () => {
    const parsed = parseSheetValues('[["a","b","c"],["d"]]', limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rectangular).toBe(false);
    expect(parsed.columnCount).toBe(3);
  });

  it("rejects non-JSON, non-arrays, empty payloads, and bad cells", () => {
    for (const bad of [
      "not json",
      '{"a":1}',
      "[]",
      "[[]]",
      '[["a"],{}]',
      '[[{"nested":true}]]',
      '[[["nested"]]]',
    ]) {
      const parsed = parseSheetValues(bad, limits);
      expect(parsed.ok, `expected rejection: ${bad}`).toBe(false);
    }
  });

  it("enforces the row, cell, and cell-size caps", () => {
    const tooManyRows = JSON.stringify(
      Array.from({ length: 11 }, () => ["x"]),
    );
    expect(parseSheetValues(tooManyRows, limits).ok).toBe(false);
    const tooManyCells = JSON.stringify(
      Array.from({ length: 7 }, () => ["a", "b", "c"]),
    );
    expect(parseSheetValues(tooManyCells, limits).ok).toBe(false);
    const oversizedCell = JSON.stringify([["y".repeat(MAX_CELL_CHARS + 1)]]);
    expect(parseSheetValues(oversizedCell, limits).ok).toBe(false);
    const nonFinite = "[[1e999]]"; // JSON.parse yields Infinity
    expect(parseSheetValues(nonFinite, limits).ok).toBe(false);
  });
});

describe("rowsToRowData", () => {
  it("maps cell types to ExtendedValue, treating leading = as a formula", () => {
    const rows = rowsToRowData([["plain", "=SUM(A1:A2)", 3.5, true, null]]);
    expect(rows).toEqual([
      {
        values: [
          { userEnteredValue: { stringValue: "plain" } },
          { userEnteredValue: { formulaValue: "=SUM(A1:A2)" } },
          { userEnteredValue: { numberValue: 3.5 } },
          { userEnteredValue: { boolValue: true } },
          {},
        ],
      },
    ]);
  });
});

describe("quoteTab", () => {
  it("quotes and escapes tab titles for A1 notation", () => {
    expect(quoteTab("Sheet1")).toBe("'Sheet1'");
    expect(quoteTab("Bob's Data")).toBe("'Bob''s Data'");
  });
});
