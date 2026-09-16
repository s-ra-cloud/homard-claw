import { writeSync } from "node:fs";
import process from "node:process";

const MAX_PAGES = 100;
const MAX_OUTPUT_CHARS = 100_000;
const PAGE_PREFIX = "--- Page ";
const TEXT_PAGE_SUFFIX = " (text only; visual and image content omitted) ---\n";
const EMPTY_PAGE_SUFFIX = " (no extractable text; visual and image content may be omitted) ---\n";
const TRUNCATION_NOTICE =
  "\n--- Text extraction truncated at the 100000-character limit; remaining text and visual/image content may be omitted. ---";

function error(kind) {
  respond({ type: "error", kind });
}

function result(text) {
  respond({ type: "result", text });
}

function respond(message) {
  try {
    // fd 3 is a private, bounded local protocol pipe. stdout/stderr remain
    // ignored, so PDF content cannot reach application logs or terminal IO.
    writeSync(3, JSON.stringify(message));
  } catch {
    // The parent may have cancelled and closed the pipe.
  }
  process.exit(0);
}

function pgSafe(value) {
  // PostgreSQL text rejects U+0000. PDF strings can contain it, including in
  // malformed ToUnicode maps, so remove it before crossing the process edge.
  return value.replace(/\u0000/g, "");
}

function appendBounded(current, addition) {
  const reservedForNotice = Array.from(TRUNCATION_NOTICE).length;
  // Keep the notice reserved from the start. This means an exact-boundary
  // document is conservatively marked as clipped rather than silently losing
  // the fact that another page or glyph could not be represented.
  const remaining = MAX_OUTPUT_CHARS - reservedForNotice - Array.from(current).length;
  if (remaining <= 0) return { text: current + TRUNCATION_NOTICE, truncated: true };
  const characters = Array.from(addition);
  if (characters.length <= remaining) return { text: current + addition, truncated: false };

  // Reserve space for an explicit, PG-safe truncation notice and avoid
  // splitting a Unicode scalar value (notably surrogate-pair emoji).
  return {
    text: current + characters.slice(0, remaining).join("") + TRUNCATION_NOTICE,
    truncated: true,
  };
}

async function extract(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return error("invalid_pdf");
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      useWorkerFetch: false,
      stopAtErrors: true,
    });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PAGES) {
      await document.destroy();
      return error("page_limit");
    }

    const selected = process.argv.length > 2;
    const start = selected ? Number(process.argv[2]) : 1;
    const end = selected ? Number(process.argv[3]) : document.numPages;
    if (selected && (!Number.isInteger(start) || !Number.isInteger(end) ||
      start < 1 || end < start || end > MAX_PAGES || end - start >= 5)) {
      await document.destroy();
      return error("invalid_page_range");
    }
    if (end > document.numPages) {
      await document.destroy();
      return error("page_out_of_range");
    }
    let output = selected
      ? `[PDF selection: pages ${start}-${end} of ${document.numPages}. Only this range was read; pages outside it were not read. Text only; visual/image content omitted.]\n`
      : "";
    let hasExtractableText = false;
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      const text = pgSafe(content.items.map((item) => (
        typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : "") : ""
      )).join(""));
      const hasPageText = text.trim().length > 0;
      hasExtractableText ||= hasPageText;
      const boundary = `${PAGE_PREFIX}${pageNumber}${hasPageText ? TEXT_PAGE_SUFFIX : EMPTY_PAGE_SUFFIX}`;
      const next = appendBounded(output, boundary + text + "\n");
      output = next.text;
      page.cleanup();
      if (next.truncated) {
        await document.destroy();
        result(output);
        return;
      }
    }
    await document.destroy();
    if (!hasExtractableText && !selected) return error("scanned");
    result(output);
  } catch (cause) {
    const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
    if (name === "PasswordException") return error("encrypted");
    if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") {
      return error("invalid_pdf");
    }
    return error("extraction_failed");
  }
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > 25_000_000) return error("input_too_large");
    chunks.push(chunk);
  }
  return extract(Buffer.concat(chunks, length));
}

void readInput().catch(() => error("extraction_failed"));