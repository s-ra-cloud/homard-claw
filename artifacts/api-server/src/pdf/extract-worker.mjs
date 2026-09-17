import { readSync, writeSync } from "node:fs";
import process from "node:process";

const MAX_PAGES = 100;
const MAX_INPUT_BYTES = 40_000_000;
const MAX_OUTPUT_CHARS = 1_500_000;
const PAGE_PREFIX = "--- Page ";
const TEXT_PAGE_SUFFIX = " (text only; visual and image content omitted) ---\n";
const EMPTY_PAGE_SUFFIX = " (no extractable text; visual and image content may be omitted) ---\n";
const TRUNCATION_NOTICE =
  "\n--- Text extraction truncated at the 1500000-character limit; remaining text and visual/image content may be omitted. ---";

function error(kind) {
  respond({ type: "error", kind });
}

function result(text) {
  respond({ type: "result", text });
}

function respond(message) {
  try {
    // fd 3 is a private, bounded local protocol pipe. A single writeSync is
    // allowed to be partial for a pipe, especially for a multi-megabyte
    // document. Keep each write bounded and loop until the complete framed
    // JSON response has crossed the process edge.
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    for (let offset = 0; offset < payload.length;) {
      try {
        const written = writeSync(3, payload, offset, Math.min(16 * 1024, payload.length - offset));
        if (!Number.isInteger(written) || written <= 0) throw new Error("protocol write");
        offset += written;
      } catch (cause) {
        if (cause?.code !== "EAGAIN") throw cause;
        Atomics.wait(waitCell, 0, 0, 1);
      }
    }
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

function readStdin(target, offset, length) {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return readSync(0, target, offset, length);
    } catch (cause) {
      if (cause?.code !== "EAGAIN") throw cause;
      Atomics.wait(waitCell, 0, 0, 1);
    }
  }
}

export function appendBoundedPdfText(current, addition) {
  return appendBounded(current, Array.from(current).length, addition);
}

function appendBounded(current, currentChars, addition) {
  const reservedForNotice = Array.from(TRUNCATION_NOTICE).length;
  // Keep the notice reserved from the start. This means an exact-boundary
  // document is conservatively marked as clipped rather than silently losing
  // the fact that another page or glyph could not be represented.
  const remaining = MAX_OUTPUT_CHARS - reservedForNotice - currentChars;
  if (remaining <= 0) {
    return {
      text: current + TRUNCATION_NOTICE,
      chars: currentChars + reservedForNotice,
      truncated: true,
    };
  }
  const characters = Array.from(addition);
  if (characters.length <= remaining) {
    return {
      text: current + addition,
      chars: currentChars + characters.length,
      truncated: false,
    };
  }

  // Reserve space for an explicit, PG-safe truncation notice and avoid
  // splitting a Unicode scalar value (notably surrogate-pair emoji).
  return {
    text: current + characters.slice(0, remaining).join("") + TRUNCATION_NOTICE,
    chars: MAX_OUTPUT_CHARS,
    truncated: true,
  };
}

async function extract(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return error("invalid_pdf");
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      // The transferred fixed-length buffer spans this zero-copy Uint8Array,
      // so PDF.js accepts it without duplicating up to 40 MB inside the
      // bounded address space.
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      useWorkerFetch: false,
      stopAtErrors: true,
    });
    const document = await loadingTask.promise;
    const selected = process.argv.length > 3;
    const start = selected ? Number(process.argv[3]) : 1;
    const end = selected ? Number(process.argv[4]) : document.numPages;
    if (selected && (!Number.isInteger(start) || !Number.isInteger(end) ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 1 || end < start || end - start >= 5)) {
      await document.destroy();
      return error("invalid_page_range");
    }
    // MAX_PAGES bounds full-document work. An explicit selection remains
    // bounded to five pages, so it can safely address later pages in a longer
    // document without parsing every preceding page.
    if (!selected && document.numPages > MAX_PAGES) {
      await document.destroy();
      return error("page_limit");
    }
    if (end > document.numPages) {
      await document.destroy();
      return error("page_out_of_range");
    }
    let output = selected
      ? `[PDF selection: pages ${start}-${end} of ${document.numPages}. Only this range was read; pages outside it were not read. Text only; visual/image content omitted.]\n`
      : "";
    let outputChars = Array.from(output).length;
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
      const next = appendBounded(output, outputChars, boundary + text + "\n");
      output = next.text;
      outputChars = next.chars;
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
  const maxInputBytes = Number(process.argv[2]);
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 0 ||
    maxInputBytes > MAX_INPUT_BYTES
  ) {
    return error("extraction_failed");
  }
  let storage;
  let bytes;
  try {
    // Reserve one bounded slab before PDF.js loads. Retaining hundreds of
    // pipe-sized chunks and concatenating them can fragment the worker's
    // constrained address space even when the PDF is below the byte limit.
    storage = new ArrayBuffer(maxInputBytes, { maxByteLength: maxInputBytes });
    bytes = new Uint8Array(storage);
  } catch {
    return error("resource_limit");
  }
  const overflow = new Uint8Array(1);
  let length = 0;
  let reachedEof = false;
  try {
    while (length < maxInputBytes) {
      const read = readStdin(bytes, length, maxInputBytes - length);
      if (read === 0) {
        reachedEof = true;
        break;
      }
      length += read;
    }
    // The configured limit is inclusive. Probe one additional byte so an
    // exact-boundary PDF reaches parsing while any larger input is refused.
    if (!reachedEof && readStdin(overflow, 0, 1) > 0) {
      return error("input_too_large");
    }
    // Transfer releases the resizable buffer's unused maximum reservation and
    // leaves an exact fixed-length backing store. PDF.js can consume the full
    // span without copying it, while large extracted output retains headroom.
    bytes = new Uint8Array(storage.transferToFixedLength(length));
  } catch {
    return error("extraction_failed");
  }
  return extract(bytes);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  void readInput().catch(() => error("extraction_failed"));
}