import { describe, expect, it } from "vitest";
import {
  DOC_ALIGNMENTS,
  DOC_BULLETS,
  DOC_NAMED_STYLES,
  MAX_DOC_RANGE_SPAN,
  buildParagraphStyleRequests,
  collectDocParagraphTexts,
  countOccurrences,
  describeStyleFlags,
  docsTextStyle,
  flattenDocTabs,
  summarizeDocTabs,
  parseDocRange,
  parseHexColor,
  parseTextStyleFlags,
  summarizeDocContent,
  type DocTab,
} from "./docs";

describe("collectDocParagraphTexts / countOccurrences", () => {
  it("sees paragraphs in the body, nested tables, headers, and footnotes", () => {
    const document = {
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: "alpha one\n" } }] } },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              { textRun: { content: "alpha " } },
                              { textRun: { content: "two\n" } },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      headers: {
        h1: {
          content: [
            { paragraph: { elements: [{ textRun: { content: "alpha 3\n" } }] } },
          ],
        },
      },
      footnotes: {
        f1: {
          content: [
            { paragraph: { elements: [{ textRun: { content: "alpha 4\n" } }] } },
          ],
        },
      },
    };
    const texts = collectDocParagraphTexts(document);
    expect(texts).toHaveLength(4);
    expect(countOccurrences(texts, "alpha")).toBe(4);
  });

  it("joins runs within a paragraph so matches spanning runs are counted", () => {
    const texts = collectDocParagraphTexts({
      paragraph: {
        elements: [
          { textRun: { content: "al" } },
          { textRun: { content: "pha\n" } },
        ],
      },
    });
    expect(countOccurrences(texts, "alpha")).toBe(1);
  });

  it("counts overlap-free repeated occurrences and refuses empty needles", () => {
    expect(countOccurrences(["aaa bb aaa"], "aaa")).toBe(2);
    expect(countOccurrences(["anything"], "")).toBe(0);
  });
});

describe("summarizeDocTabs", () => {
  const tab = (
    tabId: string,
    title: string,
    text: string,
    childTabs: DocTab[] = [],
  ): DocTab => ({
    tabProperties: { tabId, title },
    documentTab: {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 1 + text.length,
            paragraph: { elements: [{ textRun: { content: text } }] },
          },
        ],
      },
    },
    childTabs,
  });

  it("renders a single-tab document as the plain outline", () => {
    const summary = summarizeDocTabs([tab("t.0", "Main", "Hello\n")]);
    expect(summary).toBe("[1..7) Hello⏎");
  });

  it("labels every tab — including nested child tabs — with its tabId", () => {
    const summary = summarizeDocTabs([
      tab("t.0", "Overview", "One\n", [tab("t.1", "Detail", "Two\n")]),
    ]);
    expect(summary).toContain('tab "Overview" (tabId t.0)');
    expect(summary).toContain('tab "Detail" (tabId t.1)');
    expect(summary).toContain("[1..5) One⏎");
    expect(summary).toContain("[1..5) Two⏎");
    expect(flattenDocTabs([tab("t.0", "a", "x", [tab("t.1", "b", "y")])])).toHaveLength(2);
  });
});

describe("parseHexColor", () => {
  it("parses #RRGGBB into rgb fractions", () => {
    expect(parseHexColor("#000000")).toEqual({ red: 0, green: 0, blue: 0 });
    expect(parseHexColor("#FFFFFF")).toEqual({ red: 1, green: 1, blue: 1 });
    expect(parseHexColor("#ff0000")).toEqual({ red: 1, green: 0, blue: 0 });
  });

  it("rejects malformed colors", () => {
    for (const bad of ["", "red", "#FFF", "#GGGGGG", "FFFFFF", "#FFFFFFF"]) {
      expect(parseHexColor(bad), bad).toBeNull();
    }
  });
});

describe("parseTextStyleFlags", () => {
  it("parses tri-state flags, links, and colors", () => {
    const parsed = parseTextStyleFlags({
      bold: "true",
      italic: "false",
      linkUrl: "https://example.com/x",
      textColor: "#1A73E8",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.bold).toBe(true);
    expect(parsed.flags.italic).toBe(false);
    expect(parsed.flags.underline).toBeUndefined();
    expect(parsed.flags.linkUrl).toBe("https://example.com/x");
    expect(parsed.flags.color).toBeTruthy();
  });

  it("rejects non-boolean flags, bad links, bad colors, and empty requests", () => {
    expect(parseTextStyleFlags({ bold: "yes" }).ok).toBe(false);
    expect(parseTextStyleFlags({ linkUrl: "javascript:alert(1)" }).ok).toBe(
      false,
    );
    expect(parseTextStyleFlags({ linkUrl: "ftp://x" }).ok).toBe(false);
    expect(parseTextStyleFlags({ textColor: "blue" }).ok).toBe(false);
    const empty = parseTextStyleFlags({});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("No formatting");
  });

  it("treats empty strings as absent", () => {
    const parsed = parseTextStyleFlags({ bold: "", strikethrough: "true" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.bold).toBeUndefined();
    expect(parsed.flags.strikethrough).toBe(true);
  });
});

describe("docsTextStyle + describeStyleFlags", () => {
  it("builds the style and matching field mask, false meaning removal", () => {
    const parsed = parseTextStyleFlags({
      bold: "true",
      strikethrough: "false",
      textColor: "#000000",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { textStyle, fields } = docsTextStyle(parsed.flags);
    expect(textStyle).toEqual({
      bold: true,
      strikethrough: false,
      foregroundColor: {
        color: { rgbColor: { red: 0, green: 0, blue: 0 } },
      },
    });
    expect(fields).toBe("bold,strikethrough,foregroundColor");
    expect(describeStyleFlags(parsed.flags)).toBe(
      "bold, remove strikethrough, text color",
    );
  });
});

describe("parseDocRange", () => {
  it("accepts a bounded [start, end) with start >= 1", () => {
    expect(parseDocRange(1, 10)).toEqual({ ok: true, startIndex: 1, endIndex: 10 });
    expect(parseDocRange("5", "6")).toEqual({ ok: true, startIndex: 5, endIndex: 6 });
  });

  it("rejects non-integers, index 0, inverted ranges, and oversized spans", () => {
    expect(parseDocRange(1.5, 3).ok).toBe(false);
    expect(parseDocRange("a", 3).ok).toBe(false);
    expect(parseDocRange(0, 3).ok).toBe(false);
    expect(parseDocRange(5, 5).ok).toBe(false);
    expect(parseDocRange(9, 3).ok).toBe(false);
    expect(parseDocRange(1, 2 + MAX_DOC_RANGE_SPAN).ok).toBe(false);
  });
});

describe("buildParagraphStyleRequests", () => {
  const range = { startIndex: 1, endIndex: 20 };

  it("builds one updateParagraphStyle for style+alignment and a bullets request", () => {
    const built = buildParagraphStyleRequests(
      { namedStyle: "heading2", alignment: "center", bullets: "disc" },
      range,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.requests).toEqual([
      {
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: "HEADING_2", alignment: "CENTER" },
          fields: "namedStyleType,alignment",
        },
      },
      {
        createParagraphBullets: {
          range,
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      },
    ]);
    expect(built.described).toBe("style heading2, center alignment, disc bullets");
  });

  it('maps bullets "none" to deleteParagraphBullets', () => {
    const built = buildParagraphStyleRequests({ bullets: "none" }, range);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.requests).toEqual([{ deleteParagraphBullets: { range } }]);
  });

  it("rejects unknown vocabulary, listing the accepted values", () => {
    const badStyle = buildParagraphStyleRequests({ namedStyle: "h2" }, range);
    expect(badStyle.ok).toBe(false);
    if (!badStyle.ok) {
      for (const key of Object.keys(DOC_NAMED_STYLES)) {
        expect(badStyle.error).toContain(key);
      }
    }
    const badAlign = buildParagraphStyleRequests({ alignment: "left" }, range);
    expect(badAlign.ok).toBe(false);
    if (!badAlign.ok) {
      for (const key of Object.keys(DOC_ALIGNMENTS)) {
        expect(badAlign.error).toContain(key);
      }
    }
    const badBullets = buildParagraphStyleRequests({ bullets: "square" }, range);
    expect(badBullets.ok).toBe(false);
    if (!badBullets.ok) {
      for (const key of Object.keys(DOC_BULLETS)) {
        expect(badBullets.error).toContain(key);
      }
    }
  });

  it("rejects a request that styles nothing", () => {
    const built = buildParagraphStyleRequests({}, range);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("No paragraph styling");
  });
});

describe("summarizeDocContent", () => {
  it("lists exact index spans, styles, tables, and section breaks", () => {
    const summary = summarizeDocContent([
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 14,
        paragraph: {
          paragraphStyle: { namedStyleType: "HEADING_1" },
          elements: [
            { startIndex: 1, endIndex: 14, textRun: { content: "Project Plan\n" } },
          ],
        },
      },
      {
        startIndex: 14,
        endIndex: 20,
        paragraph: {
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          elements: [
            { startIndex: 14, endIndex: 17, textRun: { content: "One" } },
            { startIndex: 17, endIndex: 20, textRun: { content: "Two\n" } },
          ],
        },
      },
      { startIndex: 20, endIndex: 60, table: { rows: 2, columns: 3 } },
    ]);
    const lines = summary.split("\n");
    expect(lines[0]).toBe("[0..1) [section break]");
    expect(lines[1]).toBe("[1..14) HEADING_1 Project Plan⏎");
    // NORMAL_TEXT is the default and stays unlabeled; runs concatenate.
    expect(lines[2]).toBe("[14..20) OneTwo⏎");
    expect(lines[3]).toContain("[20..60) [table 2x3");
  });

  it("elides the middle of very long paragraphs", () => {
    const summary = summarizeDocContent([
      {
        startIndex: 1,
        endIndex: 1001,
        paragraph: {
          elements: [{ textRun: { content: "x".repeat(1000) } }],
        },
      },
    ]);
    expect(summary).toContain("[…]");
    expect(summary.length).toBeLessThan(400);
  });
});
