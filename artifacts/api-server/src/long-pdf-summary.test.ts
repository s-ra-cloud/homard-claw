import { describe, expect, it } from "vitest";
import {
  LONG_PDF_CHECKPOINT_VERSION,
  LongPdfSummaryError,
  runLongPdfSummary,
  type LongPdfSummaryEvidence,
  type LongPdfSummaryCheckpoint,
} from "./long-pdf-summary";

function evidence(input: {
  start: number;
  end: number;
  total?: number;
  text: string;
  textStart?: number;
  continuation?: string;
  nextPage?: number | null;
  revision?: string;
}): LongPdfSummaryEvidence {
  return {
    fileId: "drive-file",
    text: input.text,
    textStart: input.textStart ?? 0,
    ...(input.continuation ? { continuation: input.continuation } : {}),
    coverage: {
      startPage: input.start,
      endPage: input.end,
      totalPages: input.total ?? 100,
      batchComplete: !input.continuation,
      extractionTruncated: false,
      nextPage: input.continuation ? null : (input.nextPage ?? null),
      revisionToken: input.revision ?? "signed-revision",
    },
  };
}

describe("runLongPdfSummary", () => {
  it("splits dense astral text to the actual UTF-16 prompt budget without losing a scalar", async () => {
    const source = "😀".repeat(8_000) + "漢".repeat(8_000);
    const sectionText: string[] = [];
    const result = await runLongPdfSummary({
      checkpoint: null,
      initialEvidence: evidence({ start: 1, end: 1, total: 1, text: source }),
      requestedFileId: "drive-file",
      readNext: async () => { throw new Error("unexpected read"); },
      maxSectionChars: 7_001,
      synthesize: async (request) => {
        expect(request.text.length).toBeLessThanOrEqual(7_001);
        expect(request.text).not.toMatch(/[\uD800-\uDBFF]$/);
        if (request.kind === "section") sectionText.push(request.text);
        return "Brief section.";
      },
      save: async () => {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    });
    expect(sectionText.join("")).toBe(source);
    expect(result.checkpoint.pending).toHaveLength(0);
  });

  it.each(["cancelled", "timeout"])("does not consume source when a synthesis returns after %s", async (reason) => {
    const controller = new AbortController();
    let saved: LongPdfSummaryCheckpoint | null = null;
    await expect(runLongPdfSummary({
      checkpoint: null,
      initialEvidence: evidence({ start: 1, end: 1, total: 1, text: "raw evidence" }),
      requestedFileId: "drive-file",
      readNext: async () => { throw new Error("unexpected read"); },
      synthesize: async () => {
        controller.abort(reason);
        return "Late provider result";
      },
      save: async (checkpoint) => { saved = structuredClone(checkpoint); },
      signal: controller.signal,
      deadlineAt: Date.now() + 60_000,
    })).rejects.toMatchObject({ kind: reason });
    expect(saved).toMatchObject({
      pending: [{ text: "raw evidence" }],
      sections: [],
      pendingSynthesis: { kind: "section" },
    });
  });

  it("stops a reduction that does not shrink rather than burning the entire call allowance", async () => {
    let calls = 0;
    const checkpoint: LongPdfSummaryCheckpoint = {
      version: LONG_PDF_CHECKPOINT_VERSION,
      fileId: "drive-file", revisionToken: "signed-revision",
      totalPages: 2, completedThroughPage: 2, jobDeadlineAt: Date.now() + 60_000,
      nextPage: null, continuation: null, expectedTextStart: null,
      pending: [], pendingSynthesis: null, readCount: 2, synthesisCount: 2,
      reduction: null, stage: "reducing", finalSummary: null,
      sections: [1, 2].map((page) => ({
        startPage: page, endPage: page, chunks: [], textScalars: 5_000, summary: "x".repeat(5_000),
      })),
    };
    await expect(runLongPdfSummary({
      checkpoint, requestedFileId: "drive-file", maxSectionChars: 7_000,
      readNext: async () => { throw new Error("unexpected read"); },
      verifyRevision: async () => evidence({ start: 1, end: 2, total: 2, text: "verified" }),
      synthesize: async (request) => { calls += 1; return request.text; },
      save: async () => {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    })).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("did not shorten") });
    expect(calls).toBe(2);
    expect(checkpoint.sections).toHaveLength(2);
  });

  it("drains every typed continuation and sends every page marker to bounded synthesis", async () => {
    const initial = evidence({
      start: 1,
      end: 25,
      total: 100,
      text: "PAGE 1\n".repeat(5_000),
      continuation: "first-more",
    });
    const reads = [
      evidence({
        start: 1,
        end: 25,
        total: 100,
        textStart: Array.from(initial.text).length,
        text: "PAGE 25\n".repeat(5_000),
        nextPage: 26,
      }),
      evidence({
        start: 26,
        end: 50,
        total: 100,
        text: "PAGE 26\n".repeat(5_000),
        nextPage: 51,
      }),
      evidence({
        start: 51,
        end: 75,
        total: 100,
        text: "PAGE 51\n".repeat(5_000),
        nextPage: 76,
      }),
      evidence({
        start: 76,
        end: 100,
        total: 100,
        text: "PAGE 100\n".repeat(5_000),
        nextPage: null,
      }),
    ];
    const requests: unknown[] = [];
    const sectionInputs: string[] = [];
    let saved = 0;
    const result = await runLongPdfSummary({
      checkpoint: null,
      initialEvidence: initial,
      requestedFileId: "drive-file",
      readNext: async (request) => {
        requests.push(request);
        const next = reads.shift();
        if (!next) throw new Error("unexpected read");
        return next;
      },
      synthesize: async (request) => {
        if (request.kind === "section") sectionInputs.push(request.text);
        return `${request.kind} pages ${request.startPage}-${request.endPage}`;
      },
      save: async () => {
        saved += 1;
      },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    });

    expect(requests).toEqual([
      { fileId: "drive-file", continuation: "first-more", revisionToken: "signed-revision" },
      { fileId: "drive-file", startPage: 26, revisionToken: "signed-revision" },
      { fileId: "drive-file", startPage: 51, revisionToken: "signed-revision" },
      { fileId: "drive-file", startPage: 76, revisionToken: "signed-revision" },
    ]);
    expect(sectionInputs.join("\n")).toContain("PAGE 1");
    expect(sectionInputs.join("\n")).toContain("PAGE 25");
    expect(sectionInputs.join("\n")).toContain("PAGE 26");
    expect(sectionInputs.join("\n")).toContain("PAGE 51");
    expect(sectionInputs.join("\n")).toContain("PAGE 100");
    expect(result.pagesProcessed).toBe(100);
    expect(result.totalPages).toBe(100);
    expect(saved).toBeGreaterThan(5);
  });

  it("uses scalar offsets for Unicode continuations instead of UTF-16 length", async () => {
    const initial = evidence({
      start: 1,
      end: 25,
      text: "💙",
      continuation: "unicode-next",
    });
    await expect(
      runLongPdfSummary({
        checkpoint: null,
        initialEvidence: initial,
        requestedFileId: "drive-file",
        readNext: async () =>
          evidence({
            start: 1,
            end: 100,
            total: 100,
            textStart: 1,
            text: "done",
            nextPage: null,
          }),
        synthesize: async () => "section",
        save: async () => {},
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ pagesProcessed: 100 });
  });

  it("leaves an ambiguous pre-dispatch synthesis marker fail-closed on restart", async () => {
    let persisted: any = null;
    await expect(
      runLongPdfSummary({
        checkpoint: null,
        initialEvidence: evidence({
          start: 1,
          end: 100,
          total: 100,
          text: "source text",
          nextPage: null,
        }),
        requestedFileId: "drive-file",
        readNext: async () => {
          throw new Error("no further read");
        },
        synthesize: async () => {
          throw new Error("simulated process loss after provider dispatch");
        },
        save: async (checkpoint) => {
          persisted = structuredClone(checkpoint);
        },
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow("simulated process loss");
    expect(persisted.pendingSynthesis).toMatchObject({ kind: "section" });

    await expect(
      runLongPdfSummary({
        checkpoint: persisted,
        requestedFileId: "drive-file",
        readNext: async () => {
          throw new Error("must not replay");
        },
        synthesize: async () => {
          throw new Error("must not replay");
        },
        save: async () => {},
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({
      name: "LongPdfSummaryError",
      kind: "invalid_evidence",
    });
  });

  it("re-checks revision before resuming a reduction checkpoint", async () => {
    const checkpoint = {
      version: LONG_PDF_CHECKPOINT_VERSION as typeof LONG_PDF_CHECKPOINT_VERSION,
      fileId: "drive-file",
      revisionToken: "old-revision",
      totalPages: 25,
      jobDeadlineAt: Date.now() + 60_000,
      nextPage: null,
      continuation: null,
      expectedTextStart: null,
      completedThroughPage: 25,
      pending: [],
      sections: [{
        startPage: 1,
        endPage: 25,
        textScalars: 10,
        chunks: [],
        summary: "saved section",
      }],
      reduction: null,
      pendingSynthesis: null,
      readCount: 0,
      synthesisCount: 0,
      stage: "reducing" as const,
      finalSummary: null,
    };
    await expect(
      runLongPdfSummary({
        checkpoint,
        requestedFileId: "drive-file",
        readNext: async () => {
          throw new Error("should only verify");
        },
        verifyRevision: async () =>
          evidence({
            start: 1,
            end: 25,
            revision: "new-revision",
            text: "not used as control metadata",
            nextPage: null,
          }),
        synthesize: async () => "must not synthesize",
        save: async () => {},
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 60_000,
      }),
    ).rejects.toBeInstanceOf(LongPdfSummaryError);
  });
});