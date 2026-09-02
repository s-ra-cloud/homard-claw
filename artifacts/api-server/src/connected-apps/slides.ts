/**
 * Pure helpers for the Google Slides operations: layout vocabulary,
 * bounded text-range validation, batchUpdate request builders, and
 * presentation-structure summarization. No I/O lives here — every limit is
 * enforced before a request is ever built, and everything is unit-testable
 * in isolation (the same contract as sheets.ts and docs.ts).
 *
 * Slides text indexes are UTF-16 code-unit positions within one shape or
 * table-cell text body, matching JavaScript string lengths.
 */

import type { TextStyleFlags } from "./docs";

/** Longest text a single insert or replacement may carry. */
export const MAX_SLIDE_TEXT_CHARS = 10_000;
/** Widest index span a single delete/format request may cover. */
export const MAX_SLIDE_RANGE_SPAN = 20_000;
/** Longest needle for replace-all matching. */
export const MAX_SLIDE_FIND_CHARS = 1_000;

/**
 * Collect the text of every text body anywhere in a Slides API JSON
 * payload: shapes and table cells (on slides, notes pages, layouts, and
 * masters) all carry text as a { textElements: [...] } block, so a deep
 * walk that joins each block's runs sees everything replaceAllText can
 * touch. Counting a scoped slide's own subtree may overcount (its notes
 * page rides along) — never undercount, which is the direction that
 * matters for bounding.
 */
export function collectSlidesTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectSlidesTexts(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const textElements = record.textElements as
      | { textRun?: { content?: string } }[]
      | undefined;
    if (Array.isArray(textElements)) {
      out.push(textElements.map((e) => e?.textRun?.content ?? "").join(""));
    }
    for (const value of Object.values(record)) collectSlidesTexts(value, out);
  }
  return out;
}

/**
 * Closed set of predefined layouts for new slides. These are the Slides
 * API's own predefined layout names behind friendlier keys.
 */
export const SLIDE_LAYOUTS: Record<string, string> = {
  blank: "BLANK",
  title: "TITLE",
  title_and_body: "TITLE_AND_BODY",
  title_only: "TITLE_ONLY",
  section_header: "SECTION_HEADER",
  title_and_two_columns: "TITLE_AND_TWO_COLUMNS",
  one_column_text: "ONE_COLUMN_TEXT",
  main_point: "MAIN_POINT",
  big_number: "BIG_NUMBER",
  caption_only: "CAPTION_ONLY",
};

/**
 * Deterministic page-object id for a slide created (or duplicated) by an
 * action. Presence of this id in the presentation later is the creation's
 * receipt during crash recovery. Slides object ids must be 5-50 chars from
 * [A-Za-z0-9_-:] starting alphanumeric/underscore; action ids are UUIDs,
 * so "hc-<uuid>" always qualifies (39 chars).
 */
export function slideObjectIdForAction(actionId: string): string {
  return `hc-${actionId.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 50);
}

export type SlideRangeResult =
  | { ok: true; startIndex: number; endIndex: number }
  | { ok: false; error: string };

/**
 * Validate an explicit [startIndex, endIndex) pair inside one text
 * element: integers, start >= 0, end > start, bounded span.
 */
export function parseSlideTextRange(
  startRaw: unknown,
  endRaw: unknown,
  maxSpan = MAX_SLIDE_RANGE_SPAN,
): SlideRangeResult {
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: "startIndex and endIndex must be integers." };
  }
  if (start < 0) {
    return { ok: false, error: "startIndex must be at least 0." };
  }
  if (end <= start) {
    return {
      ok: false,
      error:
        "endIndex must be greater than startIndex (the range is [startIndex, endIndex)).",
    };
  }
  if (end - start > maxSpan) {
    return {
      ok: false,
      error: `The range spans ${end - start} characters; a single operation is limited to ${maxSpan}. Split it into smaller ranges.`,
    };
  }
  return { ok: true, startIndex: start, endIndex: end };
}

/**
 * Slides TextStyle + fields mask for updateTextStyle. Same switches as
 * Docs, but Slides wraps colors as optionalColor/opaqueColor.
 */
export function slidesTextStyle(flags: TextStyleFlags): {
  style: Record<string, unknown>;
  fields: string;
} {
  const style: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const name of ["bold", "italic", "underline", "strikethrough"] as const) {
    const value = flags[name];
    if (value === undefined) continue;
    style[name] = value;
    fields.push(name);
  }
  if (flags.linkUrl !== undefined) {
    style.link = { url: flags.linkUrl };
    fields.push("link");
  }
  if (flags.color !== undefined) {
    style.foregroundColor = { opaqueColor: { rgbColor: flags.color } };
    fields.push("foregroundColor");
  }
  return { style, fields: fields.join(",") };
}

/* ----------------------- structure summarization ------------------------ */

type SlidesTextElement = { textRun?: { content?: string } };

type SlidesPageElement = {
  objectId?: string;
  shape?: {
    placeholder?: { type?: string };
    text?: { textElements?: SlidesTextElement[] };
  };
  table?: { rows?: number; columns?: number };
};

export type SlidesSlide = {
  objectId?: string;
  slideProperties?: {
    notesPage?: {
      notesProperties?: { speakerNotesObjectId?: string };
      pageElements?: SlidesPageElement[];
    };
  };
  pageElements?: SlidesPageElement[];
};

/** Longest text echoed per element before eliding the middle. */
const ELEMENT_ECHO_CHARS = 200;

function echoText(text: string): string {
  const flat = text.replace(/\n/g, "⏎");
  if (flat.length <= ELEMENT_ECHO_CHARS) return flat;
  const half = Math.floor(ELEMENT_ECHO_CHARS / 2);
  return `${flat.slice(0, half)} […] ${flat.slice(-half)}`;
}

function elementText(element: SlidesPageElement): string | null {
  const runs = element.shape?.text?.textElements;
  if (!runs) return null;
  return runs.map((r) => r.textRun?.content ?? "").join("");
}

/**
 * Render a presentation as one block per slide: the slide's objectId (for
 * slide operations), its speaker-notes text element id (for note edits),
 * and each text-bearing element with its id, placeholder role, current
 * text, and text length (the valid insertion range is [0..length]).
 */
export function summarizePresentation(slides: SlidesSlide[]): string {
  if (slides.length === 0) return "The presentation has no slides.";
  const blocks: string[] = [];
  slides.forEach((slide, i) => {
    const lines: string[] = [];
    const notesId =
      slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    lines.push(
      `Slide ${i + 1} (slideObjectId ${slide.objectId ?? "?"}${notesId ? `, speaker notes elementObjectId ${notesId}` : ""}):`,
    );
    const elements = slide.pageElements ?? [];
    let listed = 0;
    for (const element of elements) {
      if (element.table) {
        lines.push(
          `  - table element ${element.objectId ?? "?"} (${element.table.rows ?? "?"}x${element.table.columns ?? "?"}) — table cell text is not editable through these operations`,
        );
        listed += 1;
        continue;
      }
      const text = elementText(element);
      if (text === null) continue;
      const role = element.shape?.placeholder?.type;
      lines.push(
        `  - text element ${element.objectId ?? "?"}${role ? ` (${role})` : ""}, length ${text.length}: ${echoText(text)}`,
      );
      listed += 1;
    }
    if (listed === 0) lines.push("  - (no text elements)");
    const noteText = (slide.slideProperties?.notesPage?.pageElements ?? [])
      .filter((e) => e.objectId === notesId)
      .map((e) => elementText(e) ?? "")
      .join("");
    if (notesId && noteText.trim()) {
      lines.push(`  - speaker notes, length ${noteText.length}: ${echoText(noteText)}`);
    }
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n");
}
