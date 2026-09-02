import { describe, expect, it } from "vitest";
import {
  MAX_SLIDE_RANGE_SPAN,
  SLIDE_LAYOUTS,
  collectSlidesTexts,
  parseSlideTextRange,
  slideObjectIdForAction,
  slidesTextStyle,
  summarizePresentation,
} from "./slides";
import { countOccurrences, parseTextStyleFlags } from "./docs";

describe("collectSlidesTexts", () => {
  it("sees shape text, table cells, and speaker notes anywhere in the tree", () => {
    const presentation = {
      slides: [
        {
          objectId: "p1",
          pageElements: [
            {
              shape: {
                text: { textElements: [{ textRun: { content: "Q2 plan\n" } }] },
              },
            },
            {
              table: {
                tableRows: [
                  {
                    tableCells: [
                      {
                        text: {
                          textElements: [{ textRun: { content: "Q2 data" } }],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
          slideProperties: {
            notesPage: {
              pageElements: [
                {
                  shape: {
                    text: {
                      textElements: [{ textRun: { content: "mention Q2" } }],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    };
    const texts = collectSlidesTexts(presentation);
    expect(texts).toHaveLength(3);
    expect(countOccurrences(texts, "Q2")).toBe(3);
  });

  it("joins runs within one text body so split matches are counted", () => {
    const texts = collectSlidesTexts({
      text: {
        textElements: [
          { textRun: { content: "Q" } },
          { textRun: { content: "2" } },
        ],
      },
    });
    expect(countOccurrences(texts, "Q2")).toBe(1);
  });
});

describe("SLIDE_LAYOUTS", () => {
  it("maps every friendly key to a Slides predefined layout name", () => {
    expect(SLIDE_LAYOUTS.blank).toBe("BLANK");
    expect(SLIDE_LAYOUTS.title_and_body).toBe("TITLE_AND_BODY");
    for (const value of Object.values(SLIDE_LAYOUTS)) {
      expect(value).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("slideObjectIdForAction", () => {
  it("derives a deterministic, Slides-legal object id from a UUID", () => {
    const id = slideObjectIdForAction("99999999-8888-7777-6666-555555555555");
    expect(id).toBe("hc-99999999-8888-7777-6666-555555555555");
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(50);
    expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_:-]*$/);
    // Deterministic: same action, same id.
    expect(slideObjectIdForAction("99999999-8888-7777-6666-555555555555")).toBe(id);
  });

  it("strips illegal characters and caps the length", () => {
    const id = slideObjectIdForAction("a!b@c#d$e%f^g&h*i(j)k".repeat(5));
    expect(id.length).toBeLessThanOrEqual(50);
    expect(id).toMatch(/^hc-[A-Za-z0-9_-]+$/);
  });
});

describe("parseSlideTextRange", () => {
  it("accepts [start, end) with start >= 0", () => {
    expect(parseSlideTextRange(0, 5)).toEqual({
      ok: true,
      startIndex: 0,
      endIndex: 5,
    });
  });

  it("rejects non-integers, negatives, inverted ranges, and oversized spans", () => {
    expect(parseSlideTextRange(0.5, 2).ok).toBe(false);
    expect(parseSlideTextRange(-1, 2).ok).toBe(false);
    expect(parseSlideTextRange(3, 3).ok).toBe(false);
    expect(parseSlideTextRange(5, 2).ok).toBe(false);
    expect(parseSlideTextRange(0, MAX_SLIDE_RANGE_SPAN + 1).ok).toBe(false);
  });
});

describe("slidesTextStyle", () => {
  it("wraps colors as opaqueColor and links like Docs", () => {
    const parsed = parseTextStyleFlags({
      underline: "true",
      linkUrl: "https://example.com",
      textColor: "#FF0000",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { style, fields } = slidesTextStyle(parsed.flags);
    expect(style).toEqual({
      underline: true,
      link: { url: "https://example.com" },
      foregroundColor: {
        opaqueColor: { rgbColor: { red: 1, green: 0, blue: 0 } },
      },
    });
    expect(fields).toBe("underline,link,foregroundColor");
  });
});

describe("summarizePresentation", () => {
  it("lists slide ids, text elements with lengths, tables, and speaker notes", () => {
    const summary = summarizePresentation([
      {
        objectId: "p1",
        slideProperties: {
          notesPage: {
            notesProperties: { speakerNotesObjectId: "notes-1" },
            pageElements: [
              {
                objectId: "notes-1",
                shape: {
                  text: {
                    textElements: [{ textRun: { content: "Say hi first" } }],
                  },
                },
              },
            ],
          },
        },
        pageElements: [
          {
            objectId: "title-1",
            shape: {
              placeholder: { type: "TITLE" },
              text: { textElements: [{ textRun: { content: "Q3 Review\n" } }] },
            },
          },
          { objectId: "tbl-1", table: { rows: 4, columns: 2 } },
          { objectId: "img-1" }, // no text body: not listed
        ],
      },
      { objectId: "p2", pageElements: [] },
    ]);
    expect(summary).toContain(
      "Slide 1 (slideObjectId p1, speaker notes elementObjectId notes-1):",
    );
    expect(summary).toContain("text element title-1 (TITLE), length 10: Q3 Review⏎");
    expect(summary).toContain("table element tbl-1 (4x2)");
    expect(summary).not.toContain("img-1");
    expect(summary).toContain("speaker notes, length 12: Say hi first");
    expect(summary).toContain("Slide 2 (slideObjectId p2):");
    expect(summary).toContain("(no text elements)");
  });

  it("handles an empty presentation", () => {
    expect(summarizePresentation([])).toBe("The presentation has no slides.");
  });
});
