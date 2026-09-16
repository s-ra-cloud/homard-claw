import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnedPdfPids = vi.hoisted(() => [] as number[]);

// Keep real process behavior while observing the actual child PID. This lets
// lifecycle tests assert the service did not merely reject early while a
// resource-limited parser process remained alive.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: unknown[]) => {
      const child = original.spawn(
        args[0] as string,
        args[1] as readonly string[],
        args[2] as Parameters<typeof original.spawn>[2],
      );
      if (args[0] === "/bin/sh" && Array.isArray(args[1])
        && args[1].includes("pdf-extract-limit") && child.pid) {
        spawnedPdfPids.push(child.pid);
      }
      return child;
    },
  };
});

import {
  extractPdfText,
  PdfExtractionError,
  PDF_EXTRACTION_LIMITS,
} from "./extract";

/**
 * Small deterministic PDF fixtures. They intentionally use only plain PDF
 * syntax so tests exercise PDF.js in the isolated child process rather than a
 * fixture generator. Fixture cases cover text, a scan-like blank page,
 * malformed/encrypted metadata, and a document over the page limit.
 */
function pdfFixture(
  pageStreams: string[],
  encrypt = false,
  compressStreams = false,
): Uint8Array {
  const objects: string[] = [];
  const pageObjectIds = pageStreams.map((_, index) => 3 + index * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`);
  for (const [index, stream] of pageStreams.entries()) {
    const pageId = pageObjectIds[index]!;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pageStreams.length * 2 + 3} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    const encoded = compressStreams
      ? deflateSync(Buffer.from(stream, "latin1")).toString("latin1")
      : stream;
    objects[pageId] = `<< /Length ${Buffer.byteLength(encoded, "latin1")}${compressStreams ? " /Filter /FlateDecode" : ""} >>\nstream\n${encoded}\nendstream`;
  }
  const fontId = pageStreams.length * 2 + 3;
  objects[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  if (encrypt) {
    // PDF.js identifies a standard-security dictionary before attempting to
    // read the page content, yielding its PasswordException safe error path.
    objects[fontId] =
      "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>";
  }

  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt ? ` /Encrypt ${fontId + 1} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

function textPage(text: string): string {
  return `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
}

function expectPdfChildrenReaped(): void {
  expect(spawnedPdfPids.length).toBeGreaterThan(0);
  for (const pid of spawnedPdfPids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
}

function unicodePdfFixture(pageStreams = ["BT /F1 12 Tf 72 720 Td <00E9> Tj ET"]): Uint8Array {
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "3 beginbfchar\n<00E9> <00E9>\n<0001> <4E2D>\n<0002> <D83DDE00>\nendbfchar\n" +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const pageObjectIds = pageStreams.map((_, index) => 3 + index * 2);
  const fontId = pageStreams.length * 2 + 3;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`,
  ];
  for (const [index, stream] of pageStreams.entries()) {
    const pageId = pageObjectIds[index]!;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[fontId - 1] =
    `<< /Type /Font /Subtype /Type0 /BaseFont /Identity-H /Encoding /Identity-H /DescendantFonts [${fontId + 1} 0 R] /ToUnicode ${fontId + 2} 0 R >>`;
  objects[fontId] =
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Identity-H /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>";
  objects[fontId + 1] = `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`;
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(document.length);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

describe("extractPdfText", () => {
  it("retrieves a later answer without reading earlier pages", async () => {
    const text = await extractPdfText(pdfFixture([
      textPage("Earlier material ".repeat(450)),
      textPage("The renewal date is October 12."),
      textPage("Unrequested appendix"),
    ]), { pdfPages: "2" });
    expect(text).toContain("pages 2-2 of 3");
    expect(text).toContain("outside it were not read");
    expect(text).toContain("--- Page 2");
    expect(text).toContain("October 12");
    expect(text).not.toContain("Earlier material");
    expect(text).not.toContain("Unrequested appendix");
    expect(text.length).toBeLessThan(4000);
  });

  it("labels a selected range including pages without text", async () => {
    const text = await extractPdfText(pdfFixture([textPage("first"), "", textPage("third")]), { pdfPages: "2-3" });
    expect(text).toContain("pages 2-3 of 3");
    expect(text).toContain("Page 2 (no extractable text");
    expect(text).toContain("Page 3");
    expect(text).not.toContain("first");
    const blank = await extractPdfText(pdfFixture([""]), { pdfPages: "1" });
    expect(blank).toContain("no extractable text");
  });

  it.each(["0", "2-1", "1-6", "101", "1,2", "1.5", "", "2-100", " 2"])(
    "rejects invalid selection %s before spawning", async (pdfPages) => {
      await expect(extractPdfText(pdfFixture([textPage("one")]), { pdfPages }))
        .rejects.toMatchObject({ kind: "invalid_page_range" });
      expect(spawnedPdfPids).toHaveLength(0);
    },
  );

  it("refuses a partly missing range rather than returning a misleading subset", async () => {
    await expect(extractPdfText(pdfFixture([textPage("one")]), { pdfPages: "1-2" }))
      .rejects.toMatchObject({ kind: "page_out_of_range" });
  });

  beforeEach(() => {
    spawnedPdfPids.splice(0);
  });

  it("extracts text with PG-safe page boundaries", async () => {
    const result = await extractPdfText(pdfFixture([textPage("M\\374nchen A\\000B")]));

    expect(result).toContain("--- Page 1 (text only; visual and image content omitted) ---");
    // The WinAnsi test font deliberately includes a non-ASCII octal escape;
    // PDF.js normalizes unsupported glyphs rather than exposing binary data.
    expect(result).toContain("M nchen A B");
    expect(result).not.toContain("\0");
  });

  it("preserves Unicode extracted through a PDF ToUnicode map", async () => {
    const result = await extractPdfText(unicodePdfFixture());

    expect(result).toContain("é");
  });

  it("returns near-cap CJK and emoji ToUnicode text through the bounded protocol", async () => {
    const textOperators = Array.from(
      { length: 1_000 },
      () => `<${"00010002".repeat(32)}> Tj`,
    ).join(" ");
    const page = `BT /F1 12 Tf 72 720 Td ${textOperators} ET`;
    const result = await extractPdfText(unicodePdfFixture([page, page]));

    expect(Array.from(result).length).toBeGreaterThan(100_000);
    expect(Array.from(result).length).toBeLessThanOrEqual(PDF_EXTRACTION_LIMITS.maxOutputChars);
    expect(result).toContain("中");
    expect(result).toContain("😀");
  });

  it("returns a clear safe error for scan-like image-only PDFs", async () => {
    await expect(extractPdfText(pdfFixture(["q Q"]))).rejects.toMatchObject({
      kind: "scanned",
      message: "The PDF contains no extractable text; visual or image content cannot be read.",
    } satisfies Partial<PdfExtractionError>);
  });

  it("retains an omission marker for blank pages in mixed PDFs", async () => {
    const result = await extractPdfText(pdfFixture(["q Q", textPage("readable")]));

    expect(result).toContain("--- Page 1 (no extractable text; visual and image content may be omitted) ---");
    expect(result).toContain("readable");
  });

  it("uses a fixed error for malformed PDFs without reflecting PDF bytes", async () => {
    await expect(extractPdfText(Buffer.from("%PDF-secret@example.test"))).rejects.toMatchObject({
      kind: "invalid_pdf",
      message: "The file is not a valid PDF.",
    } satisfies Partial<PdfExtractionError>);
  });

  it("does not replace an exiting malformed-PDF parser error with resource_limit", async () => {
    // Repetition makes the fd-3/procfs exit ordering deterministic enough to
    // cover the zombie-sampling regression without accepting either outcome.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(extractPdfText(Buffer.from("%PDF-malformed"))).rejects.toMatchObject({
        kind: "invalid_pdf",
        message: "The file is not a valid PDF.",
      } satisfies Partial<PdfExtractionError>);
    }
  });

  it("uses the safe encrypted-PDF failure", async () => {
    await expect(extractPdfText(pdfFixture([textPage("private")], true))).rejects.toMatchObject({
      kind: "encrypted",
      message: "The PDF is encrypted and cannot be read without a password.",
    } satisfies Partial<PdfExtractionError>);
  });

  it("enforces input and page resource caps before returning document text", async () => {
    await expect(extractPdfText(new Uint8Array(PDF_EXTRACTION_LIMITS.maxInputBytes + 1))).rejects.toMatchObject({
      kind: "input_too_large",
    } satisfies Partial<PdfExtractionError>);
    await expect(extractPdfText(pdfFixture(Array.from({ length: 101 }, () => "q Q")))).rejects.toMatchObject({
      kind: "page_limit",
    } satisfies Partial<PdfExtractionError>);
  });

  it("reserves an explicit omission notice at the 1.5M scalar boundary", async () => {
    // @ts-expect-error The unbundled worker intentionally exposes only this
    // pure boundary helper for exact above-limit regression coverage.
    const { appendBoundedPdfText } = await import("./extract-worker.mjs") as {
      appendBoundedPdfText: (
        current: string,
        addition: string,
      ) => { text: string; chars: number; truncated: boolean };
    };
    const notice =
      "\n--- Text extraction truncated at the 1500000-character limit; remaining text and visual/image content may be omitted. ---";
    const bounded = appendBoundedPdfText("", "😀".repeat(1_500_100));
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.endsWith(notice)).toBe(true);
    expect(Array.from(bounded.text)).toHaveLength(PDF_EXTRACTION_LIMITS.maxOutputChars);
  });

  it("kills no child for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(extractPdfText(pdfFixture([textPage("ignored")]), { signal: controller.signal }))
      .rejects.toMatchObject({ kind: "cancelled" } satisfies Partial<PdfExtractionError>);
  });

  it("cancels an in-flight isolated child", async () => {
    const controller = new AbortController();
    const extraction = extractPdfText(
      pdfFixture([textPage("A".repeat(10_000))]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);

    await expect(extraction).rejects.toMatchObject({
      kind: "cancelled",
    } satisfies Partial<PdfExtractionError>);
    expectPdfChildrenReaped();
  });

  it("kills a child at the supplied deadline", async () => {
    // Hold only the wall-clock reads steady until the child is spawned.
    // Real timers still expire the deadline; a busy runner must not consume
    // the 1ms budget before spawn and accidentally test queue expiry instead.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(extractPdfText(
        pdfFixture([textPage("deadline")]),
        { deadlineAt: now + 1 },
      )).rejects.toMatchObject({ kind: "timeout" } satisfies Partial<PdfExtractionError>);
      expectPdfChildrenReaped();
    } finally {
      clock.mockRestore();
    }
  });

  it("bounds the queue and releases reaped capacity for the next request", async () => {
    const deadlineAt = Date.now() + 20;
    const attempts = Array.from({ length: PDF_EXTRACTION_LIMITS.maxConcurrent + PDF_EXTRACTION_LIMITS.maxQueued + 1 }, () => (
      extractPdfText(pdfFixture([textPage("queued")]), { deadlineAt })
    ));
    const outcomes = await Promise.allSettled(attempts);
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => (outcome.reason as PdfExtractionError).kind);

    expect(failures).toContain("queue_full");
    expect(failures).toContain("timeout");
    // Each preceding child has emitted exit/reaped before its slot is
    // released; this real request would otherwise remain queue_full.
    await expect(extractPdfText(pdfFixture([textPage("after-reap")]))).resolves.toContain("after-reap");
  });

  it("enforces the same OS address-space envelope against external allocations", async () => {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("/bin/sh", [
        "-c",
        'ulimit -v "$1" || exit 125; shift; exec "$@"',
        "pdf-address-space-test",
        String(PDF_EXTRACTION_LIMITS.maxAddressSpaceBytes / 1024),
        process.execPath,
        `--max-old-space-size=${PDF_EXTRACTION_LIMITS.maxV8OldSpaceMb}`,
        "--disable-wasm-trap-handler",
        "-e",
        // This is an external ArrayBuffer rather than a V8 old-space object.
        // RLIMIT_AS rejects the reservation before it can consume host memory.
        "new ArrayBuffer(2 * 1024 * 1024 * 1024)",
      ], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", resolve);
    });

    expect(exitCode).not.toBe(0);
  });
});