import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeOperation,
  formatDriveDocumentSummary,
  UNEXPECTED_APP_ERROR_MESSAGE,
} from "./connections";
import { findOperation } from "./catalog";
import * as googleCredentials from "../google/credentials";
import { logger } from "../lib/logger";
import { resetDrivePdfExtractionSessionsForTests } from "./drive-transport";

describe("google_drive.read_file production diagnostics", () => {
  it("keeps a continuation and valid Unicode boundaries with long metadata", () => {
    const continuation = "cursor-".repeat(100);
    const summary = formatDriveDocumentSummary(
      "名".repeat(500),
      "fallback",
      "application/pdf",
      "😀".repeat(4_000),
      3,
      continuation,
    );
    expect(summary.length).toBeLessThanOrEqual(4_000);
    expect(summary).toContain(`continuation="${continuation}"`);
    expect(summary).toContain("[Earlier content omitted");
    expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(summary).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("allows a larger bounded result only for complete-PDF summary batches", () => {
    const summary = formatDriveDocumentSummary(
      "long.pdf",
      "fallback",
      "application/pdf",
      "page text ".repeat(3_000),
      0,
      "summary-cursor",
      28_000,
    );
    expect(summary.length).toBeLessThanOrEqual(28_000);
    expect(summary.length).toBeGreaterThan(4_000);
    expect(summary).toContain('continuation="summary-cursor"');
    expect(summary).toContain("page text");
  });

  it("returns native summary evidence with exact continuations, not coverage parsed from document prose", async () => {
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "token", email: "owner@example.com", googleSub: "sub",
    });
    const pages = Array.from({ length: 26 }, (_, i) =>
      `PAGE_${i + 1}_START ` +
      "PDF_SUMMARY_NEXT_PAGE=600 COMPLETE PDF COVERAGE ".repeat(35) +
      ` PAGE_${i + 1}_END`,
    );
    const fixture = pdfFixture(pages);
    let downloads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("alt=media")) {
        downloads += 1;
        return new Response(fixture);
      }
      return new Response(JSON.stringify({
        id: "native-evidence",
        name: "native-evidence.pdf",
        mimeType: "application/pdf",
        modifiedTime: "2026-09-17T10:00:00.000Z",
      }));
    });
    const run = (params: Record<string, unknown>) => executeOperation(
      findOperation("google_drive.read_pdf_summary_batch")!,
      { fileId: "native-evidence", ...params },
      { workspaceId: "native-evidence-workspace", taskId: "native-evidence-task", actionId: "action" },
    );
    try {
      let result = await run({ startPage: 1 });
      let offset = 0;
      let text = "";
      let chunks = 0;
      while (result.ok && result.pdfSummary) {
        const evidence = result.pdfSummary;
        expect(evidence.fileId).toBe("native-evidence");
        expect(evidence.textStart).toBe(offset);
        expect(evidence.text.length).toBeLessThanOrEqual(20_000);
        expect(evidence.coverage).toMatchObject({
          startPage: 1, endPage: 25, totalPages: 26, extractionTruncated: false,
        });
        text += evidence.text;
        offset += Array.from(evidence.text).length;
        chunks += 1;
        expect(chunks).toBeLessThan(10);
        if (!evidence.continuation) {
          expect(evidence.coverage.batchComplete).toBe(true);
          expect(evidence.coverage.nextPage).toBe(26);
          const final = await run({
            startPage: 26, revisionToken: evidence.coverage.revisionToken,
          });
          expect(final.ok && final.pdfSummary?.coverage).toMatchObject({
            startPage: 26, endPage: 26, totalPages: 26, batchComplete: true, nextPage: null,
          });
          break;
        }
        expect(evidence.coverage.batchComplete).toBe(false);
        expect(result.summary).toContain("Do not use google_drive.read_file");
        result = await run({
          continuation: evidence.continuation, revisionToken: evidence.coverage.revisionToken,
        });
      }
      expect(result.ok).toBe(true);
      expect(chunks).toBeGreaterThan(1);
      for (let page = 1; page <= 25; page += 1) {
        // PDF.js inserts line breaks at the small-font fixture's line boundaries.
        expect(text.replace(/\s+/g, "")).toContain(`PAGE_${page}_START`);
        expect(text.replace(/\s+/g, "")).toContain(`PAGE_${page}_END`);
      }
      expect(downloads).toBe(1);
      const ordinary = await executeOperation(
        findOperation("google_drive.read_file")!,
        { fileId: "native-evidence", pdfPages: "1-5" },
        { workspaceId: "native-evidence-workspace", taskId: "ordinary-task", actionId: "action" },
      );
      expect(ordinary.ok).toBe(true);
      expect(ordinary).not.toHaveProperty("pdfSummary");
    } finally {
      resetDrivePdfExtractionSessionsForTests();
    }
  }, 30_000);

  it("truncates mixed BMP and astral filenames at a scalar boundary", () => {
    const filename = `${"a".repeat(179)}😀tail`;
    const summary = formatDriveDocumentSummary(
      filename,
      "fallback",
      "text/plain",
      "body",
    );

    expect(summary).toContain(`File: "${"a".repeat(179)} [filename truncated;`);
    expect(summary).toContain("[filename truncated; 6 character(s) omitted]");
    expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(summary).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("marks earlier content on every noninitial bounded chunk, including final", () => {
    const chunks = ["abc", "def", "ghi"];
    const summaries = chunks.map((chunk, index) =>
      formatDriveDocumentSummary(
        "document.pdf",
        "fallback",
        "application/pdf",
        chunk,
        index * 3,
        index < chunks.length - 1 ? `cursor-${index}` : undefined,
      ),
    );
    expect(summaries[0]).not.toContain("[Earlier content omitted");
    expect(summaries[1]).toContain("[Earlier content omitted");
    expect(summaries[2]).toContain("[Earlier content omitted");
    expect(chunks.join("")).toBe("abcdefghi");
  });

  it("answers from a later page through the bounded executor, retaining source and omission labels", async () => {
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "token", email: "owner@example.com", googleSub: "sub",
    });
    const fixture = pdfFixture(["Earlier material ".repeat(450), "The renewal date is October 12.", "Appendix ".repeat(900)]);
    vi.stubGlobal("fetch", async (url: string) => String(url).includes("alt=media")
      ? new Response(fixture)
      : new Response(JSON.stringify({ name: "renewal.pdf", mimeType: "application/pdf" })));
    const run = (pdfPages?: string) => executeOperation(findOperation("google_drive.read_file")!,
      { fileId: "report", ...(pdfPages ? { pdfPages } : {}) },
      { workspaceId: "workspace", taskId: "task", actionId: "action" });
    const beginning = await run();
    expect(beginning).toMatchObject({
      ok: true,
      summary: expect.stringContaining("More content is available"),
    });
    if (beginning.ok) {
      expect(beginning.summary).toMatch(/continuation="[^"]+"/);
      expect(beginning.summary.length).toBeLessThanOrEqual(4000);
    }
    const later = await run("2");
    expect(later).toMatchObject({ ok: true });
    if (later.ok) {
      expect(later.summary).toContain('File: "renewal.pdf"');
      expect(later.summary).toContain("pages 2-2 of 3");
      expect(later.summary).toContain("outside it were not read");
      expect(later.summary).toContain("October 12");
      expect(later.summary).not.toContain("Earlier material");
      expect(later.summary.length).toBeLessThanOrEqual(4000);
    }
    const clipped = await run("3");
    expect(clipped).toMatchObject({
      ok: true,
      summary: expect.stringContaining("More content is available"),
    });
    expect(await run("4")).toMatchObject({ ok: false, message: expect.stringContaining("does not exist") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("logs safe stage and completion records with task/action/workspace context", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        requestCount++ === 0
          ? new Response(
              JSON.stringify({
                id: "secret-file-id",
                name: "private-file-name",
                mimeType: "text/plain",
              }),
            )
          : new Response("private file body"),
    );

    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-file-id" },
      {
        taskId: "task-drive-log",
        actionId: "action-drive-log",
        workspaceId: "workspace-drive-log",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(requestCount).toBe(2);
    const driveCalls = infoSpy.mock.calls.filter(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).component === "google_drive_read",
    );
    expect(driveCalls.length).toBeGreaterThan(0);
    const stages = driveCalls.map(
      ([fields]) => (fields as Record<string, unknown>).stage,
    );
    expect(stages).toContain("credentials");
    expect(stages).toContain("metadata");
    expect(stages).toContain("download");
    expect(stages).toContain("complete");
    const completion = driveCalls.find(
      ([fields]) => (fields as Record<string, unknown>).stage === "complete",
    )![0] as Record<string, unknown>;
    expect(completion).toMatchObject({
      taskId: "task-drive-log",
      actionId: "action-drive-log",
      workspaceId: "workspace-drive-log",
      status: "success",
    });
    expect(completion.durationMs).toEqual(expect.any(Number));
    expect(completion.stageDurationMs).toEqual(expect.any(Number));
    const serialized = JSON.stringify(driveCalls);
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("secret-file-id");
    expect(serialized).not.toContain("private-file-name");
    expect(serialized).not.toContain("private file body");
  });

  it("rejects malformed continuations and ranges before downloading content", async () => {
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "token", email: "owner@example.com", googleSub: "sub",
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      requestCount += 1;
      return new Response(JSON.stringify({
        name: "bounded.pdf",
        mimeType: "application/pdf",
        modifiedTime: "2024-01-01T00:00:00.000Z",
      }));
    });

    const malformed = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "bounded", continuation: "not-a-valid-cursor!" },
      { workspaceId: "workspace", taskId: "task", actionId: "action" },
    );
    expect(malformed).toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive continuation is invalid or stale; start a new read.",
    });

    const invalidRange = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "bounded", textLimit: 0 },
      { workspaceId: "workspace", taskId: "task", actionId: "action" },
    );
    expect(invalidRange).toMatchObject({
      ok: false,
      message: expect.stringContaining("document range is invalid"),
    });
    expect(requestCount).toBe(2);
  });

  it("keeps the signed continuation visible with a long filename", async () => {
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "token", email: "owner@example.com", googleSub: "sub",
    });
    const longName = `${"x".repeat(490)}.pdf`;
    const fixture = pdfFixture("Long document ".repeat(900));
    vi.stubGlobal("fetch", async (url: string) => String(url).includes("alt=media")
      ? new Response(fixture)
      : new Response(JSON.stringify({
          name: longName,
          mimeType: "application/pdf",
        })));
    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "long-name" },
      { workspaceId: "workspace", taskId: "task", actionId: "action" },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary.length).toBeLessThanOrEqual(4000);
      expect(outcome.summary).toMatch(/continuation="[^"]+"/);
      expect(outcome.summary).not.toContain("earlier content was omitted");
    }
  });

  it("logs only failure class and provider status on a raw Drive refusal", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            error: {
              errors: [
                {
                  reason: "insufficientPermissions",
                  message: "private file details must not be logged",
                },
              ],
            },
          }),
          { status: 403 },
        ),
    );

    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-file-id" },
      {
        taskId: "task-drive-failure",
        actionId: "action-drive-failure",
        workspaceId: "workspace-drive-failure",
      },
    );

    expect(outcome.ok).toBe(false);
    const failureCall = warnSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).component === "google_drive_read",
    );
    expect(failureCall).toBeDefined();
    const fields = failureCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      taskId: "task-drive-failure",
      actionId: "action-drive-failure",
      workspaceId: "workspace-drive-failure",
      stage: "failure",
      status: "failed",
      failureClass: "permission",
      providerStatus: 403,
    });
    expect(fields.durationMs).toEqual(expect.any(Number));
    expect(fields.stageDurationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "private file details",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("secret-file-id");
  });

  it("extracts a real PDF through the executor without logging source or text", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const fixture = pdfFixture("Executor PDF fixture");
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async () => requestCount++ === 0
      ? new Response(JSON.stringify({
          id: "secret-pdf-id",
          name: "deterministic-report.pdf",
          mimeType: "application/pdf",
        }))
      : new Response(fixture));
    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-pdf-id" },
      {
        taskId: "task-drive-pdf",
        actionId: "action-drive-pdf",
        workspaceId: "workspace-drive-pdf",
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain('"deterministic-report.pdf"');
      expect(outcome.summary).toContain("--- Page 1 (text only;");
      expect(outcome.summary).toContain("Executor PDF fixture");
      expect(outcome.summary).not.toContain("%PDF-");
    }
    expect(requestCount).toBe(2);
    expect(infoSpy.mock.calls.some(([fields]) =>
      typeof fields === "object" && fields !== null &&
      (fields as Record<string, unknown>).stage === "extract")).toBe(true);
    const logs = JSON.stringify([infoSpy.mock.calls, warnSpy.mock.calls]);
    for (const marker of ["secret-access-token", "secret-pdf-id",
      "deterministic-report.pdf", "Executor PDF fixture"]) {
      expect(logs).not.toContain(marker);
    }
  });

  it("keeps parser rejection outcomes and diagnostics content-free", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const privateMarker = "PRIVATE PDF BODY";
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async () => requestCount++ === 0
      ? new Response(JSON.stringify({
          id: "secret-pdf-id",
          name: "private-payroll.pdf",
          mimeType: "application/pdf",
        }))
      : new Response(`%PDF-${privateMarker}`));
    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-pdf-id" },
      {
        taskId: "task-drive-pdf-rejection",
        actionId: "action-drive-pdf-rejection",
        workspaceId: "workspace-drive-pdf-rejection",
      },
    );
    expect(outcome).toEqual({
      ok: false,
      kind: "failed",
      message: "The file is not a valid PDF.",
    });
    const logs = JSON.stringify([infoSpy.mock.calls, warnSpy.mock.calls]);
    expect(logs).toContain("pdf_extraction");
    for (const marker of [privateMarker, "secret-access-token",
      "secret-pdf-id", "private-payroll.pdf"]) {
      expect(logs).not.toContain(marker);
      expect(JSON.stringify(outcome)).not.toContain(marker);
    }
  });

  it("does not return or log an unexpected executor exception", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const privateMarker = "PRIVATE EXECUTOR PARAMETER MARKER";
    const params = new Proxy(
      {},
      {
        get() {
          throw new Error(privateMarker);
        },
      },
    ) as Record<string, unknown>;

    const outcome = await executeOperation(
      findOperation("gmail.search")!,
      params,
      {
        taskId: "task-unexpected-executor",
        actionId: "action-unexpected-executor",
        workspaceId: "workspace-unexpected-executor",
      },
    );

    expect(outcome).toEqual({
      ok: false,
      kind: "failed",
      message: UNEXPECTED_APP_ERROR_MESSAGE,
    });
    expect(JSON.stringify(outcome)).not.toContain(privateMarker);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateMarker);
  });
});

/**
 * Small deterministic PDF fixture for the production executor path. The
 * transport passes these bytes to the shared isolated parser; no extractor
 * seam or checked-in document is involved.
 */
function pdfFixture(text: string | string[]): Uint8Array {
  const pages = Array.isArray(text) ? text : [text];
  const fontId = pages.length * 2 + 3;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  for (const [i, content] of pages.entries()) {
    const lines = content.match(/.{1,64}/g) ?? [""];
    const stream = `BT /F1 1 Tf 72 720 Td ${lines.map((line) => `(${line}) Tj 0 -1 Td`).join(" ")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}
