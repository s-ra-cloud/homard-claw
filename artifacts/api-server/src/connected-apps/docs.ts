/**
 * Pure helpers for the Google Docs operations: bounded range/text
 * validation, closed formatting vocabularies, batchUpdate request builders,
 * and document-structure summarization. No I/O lives here — every limit is
 * enforced before a request is ever built, and everything is unit-testable
 * in isolation (the same contract as sheets.ts).
 *
 * Docs indexes are UTF-16 code-unit positions, which is exactly what
 * JavaScript string indexes/lengths are — so lengths computed here line up
 * with what the Docs API counts.
 */

/** Longest text a single insert or replacement may carry. */
export const MAX_DOC_TEXT_CHARS = 20_000;
/** Widest index span a single delete/format/style request may cover. */
export const MAX_DOC_RANGE_SPAN = 50_000;
/** Longest needle for replace-all matching. */
export const MAX_DOC_FIND_CHARS = 1_000;
/**
 * Most occurrences one approved replace-all may change. The executor
 * counts occurrences against the SAME revision the edit is fenced to, so
 * this bound is exact: past it, the agent must use bounded ranges instead
 * of one approval quietly rewriting an arbitrarily large document.
 */
export const MAX_REPLACE_OCCURRENCES = 100;

/**
 * Collect the text of every paragraph anywhere in a Docs API JSON payload
 * — body, tables (arbitrarily nested), headers, footers, footnotes, and
 * tabs all carry text as paragraph objects, so a deep walk that joins each
 * paragraph's runs sees everything replaceAllText can touch. Matches never
 * span paragraphs (every paragraph ends in a newline), so counting per
 * paragraph is counting the document.
 */
export function collectDocParagraphTexts(
  node: unknown,
  out: string[] = [],
): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectDocParagraphTexts(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const paragraph = record.paragraph as
      | { elements?: { textRun?: { content?: string } }[] }
      | undefined;
    if (paragraph && Array.isArray(paragraph.elements)) {
      out.push(
        paragraph.elements.map((e) => e?.textRun?.content ?? "").join(""),
      );
    }
    for (const value of Object.values(record)) {
      collectDocParagraphTexts(value, out);
    }
  }
  return out;
}

/** Total occurrences of a non-empty needle across the collected texts. */
export function countOccurrences(texts: string[], needle: string): number {
  if (needle.length === 0) return 0;
  let total = 0;
  for (const text of texts) total += text.split(needle).length - 1;
  return total;
}

/* ------------------------- shared text styling ------------------------- */

/**
 * The formatting switches shared by the Docs and Slides text-style
 * operations. Each flag is tri-state: absent (leave unchanged), true
 * (apply), false (remove).
 */
export type TextStyleFlags = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Absolute http(s) URL to link the range to. */
  linkUrl?: string;
  /** Text color as RGB fractions (parsed from #RRGGBB). */
  color?: { red: number; green: number; blue: number };
};

export type TextStyleFlagsResult =
  | { ok: true; flags: TextStyleFlags }
  | { ok: false; error: string };

/** Parse "#RRGGBB" into API rgb fractions; null when malformed. */
export function parseHexColor(
  hex: string,
): { red: number; green: number; blue: number } | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return {
    red: ((n >> 16) & 0xff) / 255,
    green: ((n >> 8) & 0xff) / 255,
    blue: (n & 0xff) / 255,
  };
}

const FLAG_NAMES = ["bold", "italic", "underline", "strikethrough"] as const;

/**
 * Parse the optional formatting params (bold/italic/underline/strikethrough
 * as "true"/"false", linkUrl, textColor). At least one option must be
 * present — a formatting request that changes nothing is a mistake worth
 * telling the agent about, not an approvable no-op.
 */
export function parseTextStyleFlags(
  params: Record<string, unknown>,
): TextStyleFlagsResult {
  const flags: TextStyleFlags = {};
  for (const name of FLAG_NAMES) {
    const raw = params[name];
    if (raw === undefined || raw === null || raw === "") continue;
    const text = String(raw).trim().toLowerCase();
    if (text !== "true" && text !== "false") {
      return {
        ok: false,
        error: `${name} must be "true" (apply it) or "false" (remove it).`,
      };
    }
    flags[name] = text === "true";
  }
  const linkRaw = params.linkUrl;
  if (linkRaw !== undefined && linkRaw !== null && linkRaw !== "") {
    const url = String(linkRaw).trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return {
        ok: false,
        error: "linkUrl must be an absolute http:// or https:// URL.",
      };
    }
    flags.linkUrl = url;
  }
  const colorRaw = params.textColor;
  if (colorRaw !== undefined && colorRaw !== null && colorRaw !== "") {
    const color = parseHexColor(String(colorRaw));
    if (!color) {
      return {
        ok: false,
        error: 'textColor must be a hex color like "#1A73E8".',
      };
    }
    flags.color = color;
  }
  if (Object.keys(flags).length === 0) {
    return {
      ok: false,
      error:
        "No formatting was requested. Set at least one of: bold, italic, underline, strikethrough (each \"true\"/\"false\"), linkUrl, textColor.",
    };
  }
  return { ok: true, flags };
}

/** Human summary of the parsed flags, for approval targets and results. */
export function describeStyleFlags(flags: TextStyleFlags): string {
  const parts: string[] = [];
  for (const name of FLAG_NAMES) {
    const value = flags[name];
    if (value !== undefined) parts.push(value ? name : `remove ${name}`);
  }
  if (flags.linkUrl) parts.push(`link to ${flags.linkUrl}`);
  if (flags.color) parts.push("text color");
  return parts.join(", ");
}

/**
 * Docs TextStyle + fields mask for updateTextStyle. (Slides wraps its
 * colors differently — see slides.ts.)
 */
export function docsTextStyle(flags: TextStyleFlags): {
  textStyle: Record<string, unknown>;
  fields: string;
} {
  const textStyle: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const name of FLAG_NAMES) {
    const value = flags[name];
    if (value === undefined) continue;
    textStyle[name] = value;
    fields.push(name);
  }
  if (flags.linkUrl !== undefined) {
    textStyle.link = { url: flags.linkUrl };
    fields.push("link");
  }
  if (flags.color !== undefined) {
    textStyle.foregroundColor = { color: { rgbColor: flags.color } };
    fields.push("foregroundColor");
  }
  return { textStyle, fields: fields.join(",") };
}

/* --------------------------- range validation --------------------------- */

export type DocRangeResult =
  | { ok: true; startIndex: number; endIndex: number }
  | { ok: false; error: string };

/**
 * Validate an explicit [startIndex, endIndex) pair against a document
 * body: integers, start >= 1 (index 0 is the body's immovable opening),
 * end > start, and a bounded span so one approval never covers an
 * unreviewably large stretch of text.
 */
export function parseDocRange(
  startRaw: unknown,
  endRaw: unknown,
  maxSpan = MAX_DOC_RANGE_SPAN,
): DocRangeResult {
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: "startIndex and endIndex must be integers." };
  }
  if (start < 1) {
    return {
      ok: false,
      error: "startIndex must be at least 1 (document text starts at index 1).",
    };
  }
  if (end <= start) {
    return {
      ok: false,
      error: "endIndex must be greater than startIndex (the range is [startIndex, endIndex)).",
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

/* ----------------------- paragraph style vocabulary ---------------------- */

/** Closed set of paragraph styles agents may apply. */
export const DOC_NAMED_STYLES: Record<string, string> = {
  normal: "NORMAL_TEXT",
  title: "TITLE",
  subtitle: "SUBTITLE",
  heading1: "HEADING_1",
  heading2: "HEADING_2",
  heading3: "HEADING_3",
  heading4: "HEADING_4",
  heading5: "HEADING_5",
  heading6: "HEADING_6",
};

/** Closed set of paragraph alignments agents may apply. */
export const DOC_ALIGNMENTS: Record<string, string> = {
  start: "START",
  center: "CENTER",
  end: "END",
  justified: "JUSTIFIED",
};

/** Closed set of list treatments: preset bullets, numbers, or none. */
export const DOC_BULLETS: Record<string, string | null> = {
  disc: "BULLET_DISC_CIRCLE_SQUARE",
  decimal: "NUMBERED_DECIMAL_ALPHA_ROMAN",
  none: null,
};

export type ParagraphStyleResult =
  | { ok: true; requests: Record<string, unknown>[]; described: string }
  | { ok: false; error: string };

/**
 * Build the batchUpdate requests for style_doc_paragraphs from its
 * optional namedStyle / alignment / bullets params. At least one must be
 * given; unknown values list the accepted vocabulary.
 */
export function buildParagraphStyleRequests(
  params: Record<string, unknown>,
  range: { startIndex: number; endIndex: number; tabId?: string },
): ParagraphStyleResult {
  const requests: Record<string, unknown>[] = [];
  const described: string[] = [];
  const paragraphStyle: Record<string, unknown> = {};
  const fields: string[] = [];

  const namedRaw = params.namedStyle;
  if (namedRaw !== undefined && namedRaw !== null && namedRaw !== "") {
    const key = String(namedRaw).trim().toLowerCase();
    const mapped = DOC_NAMED_STYLES[key];
    if (!mapped) {
      return {
        ok: false,
        error: `namedStyle "${namedRaw}" is not supported. Use one of: ${Object.keys(DOC_NAMED_STYLES).join(", ")}.`,
      };
    }
    paragraphStyle.namedStyleType = mapped;
    fields.push("namedStyleType");
    described.push(`style ${key}`);
  }
  const alignRaw = params.alignment;
  if (alignRaw !== undefined && alignRaw !== null && alignRaw !== "") {
    const key = String(alignRaw).trim().toLowerCase();
    const mapped = DOC_ALIGNMENTS[key];
    if (!mapped) {
      return {
        ok: false,
        error: `alignment "${alignRaw}" is not supported. Use one of: ${Object.keys(DOC_ALIGNMENTS).join(", ")}.`,
      };
    }
    paragraphStyle.alignment = mapped;
    fields.push("alignment");
    described.push(`${key} alignment`);
  }
  if (fields.length > 0) {
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle,
        fields: fields.join(","),
      },
    });
  }

  const bulletsRaw = params.bullets;
  if (bulletsRaw !== undefined && bulletsRaw !== null && bulletsRaw !== "") {
    const key = String(bulletsRaw).trim().toLowerCase();
    if (!(key in DOC_BULLETS)) {
      return {
        ok: false,
        error: `bullets "${bulletsRaw}" is not supported. Use one of: ${Object.keys(DOC_BULLETS).join(", ")}.`,
      };
    }
    const preset = DOC_BULLETS[key];
    requests.push(
      preset === null
        ? { deleteParagraphBullets: { range } }
        : { createParagraphBullets: { range, bulletPreset: preset } },
    );
    described.push(preset === null ? "remove bullets" : `${key} bullets`);
  }

  if (requests.length === 0) {
    return {
      ok: false,
      error:
        "No paragraph styling was requested. Set at least one of: namedStyle, alignment, bullets.",
    };
  }
  return { ok: true, requests, described: described.join(", ") };
}

/* ----------------------- structure summarization ------------------------ */

type DocParagraphElement = {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string };
};

export type DocStructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    paragraphStyle?: { namedStyleType?: string };
    elements?: DocParagraphElement[];
  };
  table?: { rows?: number; columns?: number };
  sectionBreak?: unknown;
};

/** Longest text echoed per paragraph line before eliding the middle. */
const PARAGRAPH_ECHO_CHARS = 300;

function echoText(text: string): string {
  const flat = text.replace(/\n/g, "⏎");
  if (flat.length <= PARAGRAPH_ECHO_CHARS) return flat;
  const half = Math.floor(PARAGRAPH_ECHO_CHARS / 2);
  return `${flat.slice(0, half)} […] ${flat.slice(-half)}`;
}

/**
 * Render a document body as one line per structural element:
 * "[start..end) STYLE text". This is what makes bounded index-based edits
 * possible — the agent reads exact positions instead of guessing them.
 * Table interiors are not expanded; their text is available through
 * google_drive.read_file's plain-text export.
 */
export type DocTab = {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: { body?: { content?: DocStructuralElement[] } };
  childTabs?: DocTab[];
};

/** Depth-first flattening of a document's tab tree (child tabs nest). */
export function flattenDocTabs(tabs: DocTab[], out: DocTab[] = []): DocTab[] {
  for (const tab of tabs) {
    out.push(tab);
    if (Array.isArray(tab.childTabs)) flattenDocTabs(tab.childTabs, out);
  }
  return out;
}

/**
 * Render a whole document fetched with includeTabsContent=true. A
 * single-tab document reads exactly like the plain body outline; a
 * multi-tab document labels every tab with its tabId and title so edits
 * can target tabs beyond the first (edits without a tabId always land on
 * the FIRST tab).
 */
export function summarizeDocTabs(tabs: DocTab[]): string {
  const flat = flattenDocTabs(tabs);
  if (flat.length <= 1) {
    return summarizeDocContent(flat[0]?.documentTab?.body?.content ?? []);
  }
  return flat
    .map((tab) => {
      const id = tab.tabProperties?.tabId ?? "?";
      const title = tab.tabProperties?.title ?? "";
      const outline = summarizeDocContent(
        tab.documentTab?.body?.content ?? [],
      );
      return `=== tab "${title}" (tabId ${id}) — pass tabId to edit THIS tab; without it, edits land on the first tab ===\n${outline}`;
    })
    .join("\n");
}

export function summarizeDocContent(content: DocStructuralElement[]): string {
  const lines: string[] = [];
  for (const element of content) {
    const start = element.startIndex ?? 0;
    const end = element.endIndex ?? start;
    const span = `[${start}..${end})`;
    if (element.paragraph) {
      const style = element.paragraph.paragraphStyle?.namedStyleType;
      const text = (element.paragraph.elements ?? [])
        .map((e) => e.textRun?.content ?? "")
        .join("");
      lines.push(
        `${span}${style && style !== "NORMAL_TEXT" ? ` ${style}` : ""} ${echoText(text)}`.trimEnd(),
      );
    } else if (element.table) {
      lines.push(
        `${span} [table ${element.table.rows ?? "?"}x${element.table.columns ?? "?"} — cell text is not listed here; read it via google_drive.read_file. Edits inside the table use the global indexes within this span.]`,
      );
    } else if (element.sectionBreak) {
      lines.push(`${span} [section break]`);
    } else {
      lines.push(`${span} [other structural element]`);
    }
  }
  return lines.join("\n");
}
