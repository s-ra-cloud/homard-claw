import type { DrivePdfCoverage } from "./connected-apps/drive-transport";

/**
 * The server, rather than a model-generated cursor, owns complete-PDF
 * traversal. Keep sections substantial enough to make a dense document
 * practical while leaving a safety margin below provider context limits.
 */
export const LONG_PDF_SECTION_MIN_CHARS = 60_000;
export const LONG_PDF_SECTION_TARGET_CHARS = 80_000;
export const LONG_PDF_SECTION_MAX_CHARS = 100_000;
export const LONG_PDF_CHECKPOINT_VERSION = 1;
/** Finite defence-in-depth cap; dense 600-page files normally need far fewer. */
export const LONG_PDF_MAX_READS = 256;
export const LONG_PDF_MAX_SYNTHESIS_CALLS = 128;

export type LongPdfSummaryEvidence = {
  fileId: string;
  text: string;
  textStart: number;
  continuation?: string;
  coverage: DrivePdfCoverage;
};

export type LongPdfSummaryChunkEvidence = {
  startPage: number;
  endPage: number;
  textStart: number;
  textScalars: number;
};

export type LongPdfSummarySection = {
  startPage: number;
  endPage: number;
  textScalars: number;
  chunks: LongPdfSummaryChunkEvidence[];
  summary: string;
};

type PendingChunk = LongPdfSummaryChunkEvidence & { text: string };

export type LongPdfSummaryCheckpoint = {
  version: typeof LONG_PDF_CHECKPOINT_VERSION;
  fileId: string;
  revisionToken: string;
  totalPages: number;
  /** Absolute finite job deadline; never reset by a restart. */
  jobDeadlineAt: number;
  /** Exact next transport position. `continuation` always wins over page. */
  nextPage: number | null;
  continuation: string | null;
  /** Expected scalar text offset only while draining one transport batch. */
  expectedTextStart: number | null;
  /** Last contiguous page whose entire batch has been read and synthesized. */
  completedThroughPage: number;
  pending: PendingChunk[];
  sections: LongPdfSummarySection[];
  /**
   * Reduction state is checkpointed after every model call. Source is kept
   * until its replacement level commits, so a restart cannot drop a section.
   */
  reduction: {
    level: number;
    source: LongPdfSummarySection[];
    completed: LongPdfSummarySection[];
  } | null;
  /**
   * Written before every provider synthesis dispatch. A process crash after
   * that write leaves an intentionally ambiguous marker: the next claimant
   * must stop with the retained partial result, never silently bill/replay
   * the same text.
   */
  pendingSynthesis: {
    kind: "section" | "reduction";
    level: number;
    startPage: number;
    endPage: number;
    sectionChunkCount?: number;
    reductionGroupIndex?: number;
  } | null;
  readCount: number;
  synthesisCount: number;
  stage: "traversing" | "reducing" | "complete";
  finalSummary: string | null;
};

export type LongPdfReadRequest =
  | { fileId: string; startPage: number; continuation?: undefined; revisionToken?: string }
  | { fileId: string; startPage?: undefined; continuation: string; revisionToken: string };

export type LongPdfSynthesisRequest = {
  kind: "section" | "reduction";
  level: number;
  startPage: number;
  endPage: number;
  /**
   * Untrusted document or model material. The worker supplies it only in a
   * no-tools, fresh provider context; it must never be parsed as metadata.
   */
  text: string;
  chunks: LongPdfSummaryChunkEvidence[];
};

export class LongPdfSummaryError extends Error {
  constructor(
    readonly kind:
      | "invalid_evidence"
      | "revision_changed"
      | "timeout"
      | "cancelled"
      | "limit",
    message: string,
    readonly partialOutput: string | null = null,
  ) {
    super(message);
    this.name = "LongPdfSummaryError";
  }
}

export type LongPdfSummaryRunResult = {
  checkpoint: LongPdfSummaryCheckpoint;
  output: string;
  pagesProcessed: number;
  totalPages: number;
};

export type RunLongPdfSummaryInput = {
  /** Existing state is loaded privately by the worker, never from request JSON. */
  checkpoint: LongPdfSummaryCheckpoint | null;
  /** Required for a new traversal; omitted when safely resuming a checkpoint. */
  initialEvidence?: LongPdfSummaryEvidence;
  requestedFileId: string;
  readNext: (request: LongPdfReadRequest) => Promise<LongPdfSummaryEvidence>;
  /**
   * Re-check the exact Drive revision before resuming a reduction or serving
   * a previously completed checkpoint. It deliberately returns typed native
   * evidence rather than parsing formatted action prose.
   */
  verifyRevision?: () => Promise<LongPdfSummaryEvidence>;
  synthesize: (request: LongPdfSynthesisRequest) => Promise<string>;
  save: (checkpoint: LongPdfSummaryCheckpoint) => Promise<void>;
  signal: AbortSignal;
  deadlineAt: number;
  onProgress?: (message: string) => Promise<void> | void;
  now?: () => number;
  maxReads?: number;
  maxSynthesisCalls?: number;
  /** Context-derived scalar-safe source ceiling for one provider call. */
  maxSectionChars?: number;
};

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function pagesProcessed(checkpoint: LongPdfSummaryCheckpoint): number {
  if (checkpoint.sections.length === 0) return 0;
  return Math.min(
    checkpoint.completedThroughPage,
    Math.max(...checkpoint.sections.map((section) => section.endPage)),
    // Chunk page ranges are deliberately coarse. If any text from a batch
    // remains unsynthesized, none of that batch can count as fully covered.
    checkpoint.pending.length
      ? Math.min(...checkpoint.pending.map((chunk) => chunk.startPage)) - 1
      : checkpoint.totalPages,
  );
}

export function longPdfPartialOutput(checkpoint: LongPdfSummaryCheckpoint, reason: string): string {
  const pages = pagesProcessed(checkpoint);
  const completed = checkpoint.sections.map((section) => section.summary).join("\n\n");
  return [
    `Partial PDF summary — ${reason}`,
    `Coverage synthesized through page ${pages} of ${checkpoint.totalPages}.`,
    completed ? `Completed sections:\n${completed}` : "No section completed yet.",
  ].join("\n\n");
}
const partialOutput = longPdfPartialOutput;

function stopIfNeeded(
  checkpoint: LongPdfSummaryCheckpoint,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): void {
  if (signal.aborted) {
    const kind = signal.reason === "timeout" ? "timeout" : "cancelled";
    throw new LongPdfSummaryError(
      kind,
      kind === "timeout"
        ? "The long-PDF summary reached its execution deadline."
        : "The long-PDF summary was cancelled.",
      partialOutput(checkpoint, kind === "timeout" ? "time limit reached" : "cancelled"),
    );
  }
  if (now() >= deadlineAt) {
    throw new LongPdfSummaryError(
      "timeout",
      "The long-PDF summary reached its execution deadline.",
      partialOutput(checkpoint, "time limit reached"),
    );
  }
}

function validCoverage(coverage: DrivePdfCoverage): boolean {
  return Number.isSafeInteger(coverage.startPage) &&
    Number.isSafeInteger(coverage.endPage) &&
    Number.isSafeInteger(coverage.totalPages) &&
    coverage.startPage >= 1 &&
    coverage.endPage >= coverage.startPage &&
    coverage.endPage <= coverage.totalPages &&
    typeof coverage.revisionToken === "string" &&
    coverage.revisionToken.length > 0;
}

function newCheckpoint(evidence: LongPdfSummaryEvidence): LongPdfSummaryCheckpoint {
  if (
    evidence.coverage.startPage !== 1 ||
    evidence.coverage.extractionTruncated ||
    !validCoverage(evidence.coverage)
  ) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The initial PDF summary read did not provide valid page-one coverage.",
    );
  }
  return {
    version: LONG_PDF_CHECKPOINT_VERSION,
    fileId: evidence.fileId,
    revisionToken: evidence.coverage.revisionToken,
    totalPages: evidence.coverage.totalPages,
    jobDeadlineAt: Date.now(), // replaced from the caller's bounded lifecycle before first save
    nextPage: 1,
    continuation: null,
    expectedTextStart: null,
    completedThroughPage: 0,
    pending: [],
    sections: [],
    reduction: null,
    pendingSynthesis: null,
    readCount: 0,
    synthesisCount: 0,
    stage: "traversing",
    finalSummary: null,
  };
}

export function validateLongPdfSummaryCheckpoint(
  checkpoint: LongPdfSummaryCheckpoint,
): LongPdfSummaryCheckpoint {
  if (
    checkpoint.version !== LONG_PDF_CHECKPOINT_VERSION ||
    !checkpoint.fileId ||
    !checkpoint.revisionToken ||
    !Number.isSafeInteger(checkpoint.totalPages) ||
    checkpoint.totalPages < 1 ||
    !Number.isSafeInteger(checkpoint.jobDeadlineAt) ||
    !Array.isArray(checkpoint.pending) ||
    !Array.isArray(checkpoint.sections) ||
    checkpoint.pendingSynthesis === undefined ||
    !Number.isSafeInteger(checkpoint.readCount) ||
    !Number.isSafeInteger(checkpoint.synthesisCount)
    || !Number.isSafeInteger(checkpoint.completedThroughPage)
    || checkpoint.completedThroughPage < 0
    || checkpoint.completedThroughPage > checkpoint.totalPages
  ) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The saved long-PDF summary checkpoint is invalid and cannot be resumed safely.",
    );
  }
  return checkpoint;
}

/**
 * Validate typed native evidence structurally. Do not inspect PDF text for
 * tokens, cursors, or any trusted control value: all such values arrive on
 * the separately typed `coverage` object.
 */
export function appendLongPdfEvidence(
  checkpoint: LongPdfSummaryCheckpoint,
  evidence: LongPdfSummaryEvidence,
): LongPdfSummaryCheckpoint {
  const coverage = evidence.coverage;
  if (
    evidence.fileId !== checkpoint.fileId ||
    !validCoverage(coverage) ||
    coverage.extractionTruncated
  ) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary transport returned incomplete or mismatched coverage.",
      partialOutput(checkpoint, "transport coverage could not be verified"),
    );
  }
  if (coverage.revisionToken !== checkpoint.revisionToken) {
    throw new LongPdfSummaryError(
      "revision_changed",
      "The Drive file changed while its PDF summary was running; the revision-bound summary was stopped.",
      partialOutput(checkpoint, "the file revision changed"),
    );
  }
  if (coverage.totalPages !== checkpoint.totalPages) {
    throw new LongPdfSummaryError(
      "revision_changed",
      "The Drive PDF page count changed while its summary was running; the revision-bound summary was stopped.",
      partialOutput(checkpoint, "the file revision changed"),
    );
  }
  const continuing = checkpoint.continuation !== null;
  if (coverage.startPage !== checkpoint.nextPage) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary transport did not advance the expected contiguous range.",
      partialOutput(checkpoint, "contiguous coverage could not be verified"),
    );
  }
  if (!Number.isSafeInteger(evidence.textStart) || evidence.textStart < 0) {
    throw new LongPdfSummaryError("invalid_evidence", "The PDF text offset is invalid.");
  }
  if (
    continuing &&
    evidence.textStart !== checkpoint.expectedTextStart
  ) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary continuation did not return the expected contiguous text offset.",
      partialOutput(checkpoint, "text continuation could not be verified"),
    );
  }
  if (!coverage.batchComplete && !evidence.continuation) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary transport left a batch incomplete without a continuation.",
    );
  }
  if (
    coverage.batchComplete &&
    coverage.nextPage !==
      (coverage.endPage === coverage.totalPages ? null : coverage.endPage + 1)
  ) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary transport reported an invalid next-page cursor.",
    );
  }
  if (checkpoint.sections.length === 0 && checkpoint.pending.length === 0 &&
    !continuing && evidence.textStart !== 0) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The first PDF summary text range did not start at scalar offset zero.",
    );
  }
  checkpoint.pending.push({
    startPage: coverage.startPage,
    endPage: coverage.endPage,
    textStart: evidence.textStart,
    textScalars: scalarLength(evidence.text),
    text: evidence.text,
  });
  checkpoint.continuation = evidence.continuation ?? null;
  checkpoint.nextPage = evidence.continuation
    ? coverage.startPage
    : coverage.nextPage;
  checkpoint.expectedTextStart = evidence.continuation
    ? evidence.textStart + scalarLength(evidence.text)
    : null;
  if (coverage.batchComplete) checkpoint.completedThroughPage = coverage.endPage;
  if (coverage.batchComplete && evidence.continuation) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "The PDF summary transport reported both a completed batch and a continuation.",
    );
  }
  return checkpoint;
}

function pendingScalarLength(checkpoint: LongPdfSummaryCheckpoint): number {
  return checkpoint.pending.reduce((total, chunk) => total + chunk.textScalars, 0);
}

function takePendingSection(
  checkpoint: LongPdfSummaryCheckpoint,
  maxChars: number,
): PendingChunk[] {
  const selected: PendingChunk[] = [];
  let size = 0;
  for (const next of checkpoint.pending) {
    // Budgets are UTF-16 units (the worker estimates prompt.length), while
    // source cursors remain Unicode scalars. Include the joining separators.
    const separator = selected.length > 0 ? 2 : 0;
    const room = maxChars - size - separator;
    if (room <= 0) break;
    if (next.text.length > room) {
      let text = "";
      let scalars = 0;
      for (const scalar of next.text) {
        if (text.length + scalar.length > room) break;
        text += scalar;
        scalars += 1;
      }
      if (scalars === 0) break;
      selected.push({
        ...next,
        text,
        textScalars: scalars,
      });
      break;
    }
    selected.push(next);
    size += separator + next.text.length;
    if (size >= Math.min(LONG_PDF_SECTION_TARGET_CHARS, maxChars)) break;
  }
  return selected;
}

function consumePending(
  checkpoint: LongPdfSummaryCheckpoint,
  consumed: PendingChunk[],
): void {
  for (const part of consumed) {
    const current = checkpoint.pending[0];
    if (!current || current.textStart !== part.textStart || current.textScalars < part.textScalars) {
      throw new LongPdfSummaryError(
        "invalid_evidence",
        "The saved PDF section buffer changed while a synthesis was in flight.",
      );
    }
    if (current.textScalars === part.textScalars) {
      checkpoint.pending.shift();
      continue;
    }
    const rest = Array.from(current.text).slice(part.textScalars).join("");
    current.text = rest;
    current.textStart += part.textScalars;
    current.textScalars -= part.textScalars;
  }
}

function sectionRequest(
  kind: "section" | "reduction",
  level: number,
  parts: Array<{ startPage: number; endPage: number; text: string; chunks: LongPdfSummaryChunkEvidence[] }>,
): LongPdfSynthesisRequest {
  return {
    kind,
    level,
    startPage: Math.min(...parts.map((part) => part.startPage)),
    endPage: Math.max(...parts.map((part) => part.endPage)),
    text: parts.map((part) => part.text).join("\n\n"),
    chunks: parts.flatMap((part) => part.chunks),
  };
}

function reductionGroups(
  sections: LongPdfSummarySection[],
  maxChars: number,
): LongPdfSummarySection[][] {
  const groups: LongPdfSummarySection[][] = [];
  let current: LongPdfSummarySection[] = [];
  let size = 0;
  for (const section of sections) {
    const textSize = section.summary.length;
    if (textSize > maxChars) {
      throw new LongPdfSummaryError(
        "limit",
        "A section summary exceeds the model's bounded reduction context. The completed sections were retained; use a model with a larger context.",
      );
    }
    if (current.length > 0 && size + 2 + textSize > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    size += (current.length > 0 ? 2 : 0) + textSize;
    current.push(section);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function flushSection(
  checkpoint: LongPdfSummaryCheckpoint,
  input: RunLongPdfSummaryInput,
): Promise<void> {
  // Pick without consuming. The raw document text remains durable until the
  // provider result and its replacement section checkpoint commit.
  const maxChars = Math.max(
    1,
    Math.min(input.maxSectionChars ?? LONG_PDF_SECTION_MAX_CHARS, LONG_PDF_SECTION_MAX_CHARS),
  );
  const candidate = {
    ...checkpoint,
    pending: [...checkpoint.pending],
  };
  const chunks = takePendingSection(candidate, maxChars);
  if (chunks.length === 0) {
    throw new LongPdfSummaryError("limit", "The model's available context is too small to fit the next complete Unicode character.");
  }
  if (
    checkpoint.synthesisCount >=
    (input.maxSynthesisCalls ?? LONG_PDF_MAX_SYNTHESIS_CALLS)
  ) {
    throw new LongPdfSummaryError(
      "limit",
      "The long-PDF summary reached its bounded synthesis-call limit.",
      partialOutput(checkpoint, "the bounded synthesis-call limit was reached"),
    );
  }
  const request = sectionRequest(
    "section",
    0,
    chunks.map((chunk) => ({
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      text: chunk.text,
      chunks: [{
        startPage: chunk.startPage,
        endPage: chunk.endPage,
        textStart: chunk.textStart,
        textScalars: chunk.textScalars,
      }],
    })),
  );
  await input.onProgress?.(
    `Synthesizing PDF pages ${request.startPage}-${request.endPage} (${request.chunks.length} extracted chunk(s)).`,
  );
  checkpoint.pendingSynthesis = {
    kind: "section",
    level: 0,
    startPage: request.startPage,
    endPage: request.endPage,
    sectionChunkCount: chunks.length,
  };
  await input.save(checkpoint);
  let summary: string;
  try {
    summary = await input.synthesize(request);
  } catch (error) {
    // Provider adapters often reject on abort rather than returning control to
    // the caller. Convert only an observed abort/deadline into the structured
    // partial outcome; unrelated provider failures retain their own kind.
    stopIfNeeded(checkpoint, input.signal, input.deadlineAt, input.now ?? Date.now);
    throw error;
  }
  stopIfNeeded(checkpoint, input.signal, Math.min(input.deadlineAt, checkpoint.jobDeadlineAt), input.now ?? Date.now);
  checkpoint.synthesisCount += 1;
  consumePending(checkpoint, chunks);
  checkpoint.sections.push({
    startPage: request.startPage,
    endPage: request.endPage,
    textScalars: chunks.reduce((total, chunk) => total + chunk.textScalars, 0),
    chunks: request.chunks,
    summary,
  });
  checkpoint.pendingSynthesis = null;
  // Raw text was removed only after the section synthesis returned. Persist
  // this replacement atomically through the checkpoint store.
  await input.save(checkpoint);
}

async function reduce(
  checkpoint: LongPdfSummaryCheckpoint,
  input: RunLongPdfSummaryInput,
): Promise<void> {
  if (checkpoint.sections.length === 0) {
    checkpoint.finalSummary =
      "The PDF was traversed completely, but no extractable text was available to summarize.";
    checkpoint.stage = "complete";
    await input.save(checkpoint);
    return;
  }
  if (!checkpoint.reduction) {
    checkpoint.reduction = {
      level: 1,
      source: checkpoint.sections,
      completed: [],
    };
    checkpoint.stage = "reducing";
    await input.save(checkpoint);
  }
  while (checkpoint.reduction) {
    stopIfNeeded(checkpoint, input.signal, input.deadlineAt, input.now ?? Date.now);
    const reduction: NonNullable<LongPdfSummaryCheckpoint["reduction"]> =
      checkpoint.reduction;
    const groups = reductionGroups(
      reduction.source,
      Math.max(
        1,
        Math.min(
          input.maxSectionChars ?? LONG_PDF_SECTION_MAX_CHARS,
          LONG_PDF_SECTION_MAX_CHARS,
        ),
      ),
    );
    for (let index = reduction.completed.length; index < groups.length; index += 1) {
      const group = groups[index];
      const request = sectionRequest(
        "reduction",
        reduction.level,
        group.map((section) => ({
          startPage: section.startPage,
          endPage: section.endPage,
          text: section.summary,
          chunks: section.chunks,
        })),
      );
      if (
        checkpoint.synthesisCount >=
        (input.maxSynthesisCalls ?? LONG_PDF_MAX_SYNTHESIS_CALLS)
      ) {
        throw new LongPdfSummaryError(
          "limit",
          "The long-PDF summary reached its bounded synthesis-call limit.",
          partialOutput(checkpoint, "the bounded synthesis-call limit was reached"),
        );
      }
      await input.onProgress?.(
        `Reducing PDF summary level ${reduction.level}, pages ${request.startPage}-${request.endPage}.`,
      );
      checkpoint.pendingSynthesis = {
        kind: "reduction",
        level: reduction.level,
        startPage: request.startPage,
        endPage: request.endPage,
        reductionGroupIndex: index,
      };
      await input.save(checkpoint);
      let summary: string;
      try {
        summary = await input.synthesize(request);
      } catch (error) {
        stopIfNeeded(checkpoint, input.signal, input.deadlineAt, input.now ?? Date.now);
        throw error;
      }
      stopIfNeeded(checkpoint, input.signal, input.deadlineAt, input.now ?? Date.now);
      checkpoint.synthesisCount += 1;
      reduction.completed.push({
        startPage: request.startPage,
        endPage: request.endPage,
        textScalars: scalarLength(request.text),
        chunks: request.chunks,
        summary,
      });
      checkpoint.pendingSynthesis = null;
      await input.save(checkpoint);
    }
    if (reduction.completed.length === 1) {
      checkpoint.finalSummary = reduction.completed[0].summary;
      checkpoint.reduction = null;
      checkpoint.stage = "complete";
      await input.save(checkpoint);
      return;
    }
    if (
      reduction.completed.length >= reduction.source.length &&
      reduction.completed.reduce((total, section) => total + section.summary.length, 0) >=
        reduction.source.reduce((total, section) => total + section.summary.length, 0)
    ) {
      throw new LongPdfSummaryError(
        "limit",
        "The provider did not shorten the section summaries enough to combine them safely.",
        partialOutput(checkpoint, "the provider's reduction made no progress"),
      );
    }
    checkpoint.reduction = {
      level: reduction.level + 1,
      source: reduction.completed,
      completed: [],
    };
    await input.save(checkpoint);
  }
}

/**
 * Drain every typed transport continuation, synthesize all accumulated text
 * in bounded sections, then hierarchically reduce those section summaries.
 * This function has no model-directed cursor and never reads control metadata
 * from document prose.
 */
export async function runLongPdfSummary(
  input: RunLongPdfSummaryInput,
): Promise<LongPdfSummaryRunResult> {
  let checkpoint = input.checkpoint
    ? validateLongPdfSummaryCheckpoint(input.checkpoint)
    : null;
  if (checkpoint && checkpoint.fileId !== input.requestedFileId) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "A different Drive file was requested while a revision-bound PDF summary checkpoint exists.",
    );
  }
  if (checkpoint?.pendingSynthesis) {
    throw new LongPdfSummaryError(
      "invalid_evidence",
      "A previous PDF section synthesis may have reached the provider before the worker stopped. It was not replayed automatically; the retained partial summary can be reviewed before retrying.",
      partialOutput(checkpoint, "a section synthesis has an ambiguous provider outcome"),
    );
  }
  // A resumed reduction has no subsequent text read to naturally prove the
  // revision is still current. Re-check it before trusting old section
  // evidence or returning an already-complete checkpoint.
  if (
    checkpoint &&
    checkpoint.stage !== "traversing" &&
    input.verifyRevision
  ) {
    const revisionEvidence = await input.verifyRevision();
    if (
      revisionEvidence.fileId !== checkpoint.fileId ||
      revisionEvidence.coverage.revisionToken !== checkpoint.revisionToken ||
      revisionEvidence.coverage.totalPages !== checkpoint.totalPages ||
      revisionEvidence.coverage.extractionTruncated
    ) {
      throw new LongPdfSummaryError(
        "revision_changed",
        "The Drive file changed before its saved PDF synthesis could resume; the revision-bound summary was stopped.",
        partialOutput(checkpoint, "the file revision changed"),
      );
    }
  }
  if (!checkpoint) {
    if (!input.initialEvidence) {
      throw new LongPdfSummaryError(
        "invalid_evidence",
        "The initial PDF summary action did not provide native summary evidence.",
      );
    }
    checkpoint = newCheckpoint(input.initialEvidence);
    checkpoint.jobDeadlineAt = input.deadlineAt;
    if (checkpoint.fileId !== input.requestedFileId) {
      throw new LongPdfSummaryError(
        "invalid_evidence",
        "The initial PDF summary evidence belongs to a different file.",
      );
    }
    appendLongPdfEvidence(checkpoint, input.initialEvidence);
    // The triggering page-one action is a bounded Drive read too.
    checkpoint.readCount = 1;
    await input.save(checkpoint);
  }
  // A persisted job deadline is an overall allowance, not a fresh segment
  // grant. An explicit current owner cap may only shorten it.
  const jobDeadlineAt = Math.min(input.deadlineAt, checkpoint.jobDeadlineAt);
  stopIfNeeded(checkpoint, input.signal, jobDeadlineAt, input.now ?? Date.now);
  if (checkpoint.stage === "complete" && checkpoint.finalSummary) {
    return {
      checkpoint,
      output: checkpoint.finalSummary,
      pagesProcessed: checkpoint.totalPages,
      totalPages: checkpoint.totalPages,
    };
  }
  const now = input.now ?? Date.now;
  while (checkpoint.stage === "traversing") {
    stopIfNeeded(checkpoint, input.signal, jobDeadlineAt, now);
    if (
      pendingScalarLength(checkpoint) >=
        Math.min(LONG_PDF_SECTION_MIN_CHARS, input.maxSectionChars ?? LONG_PDF_SECTION_MAX_CHARS) ||
      (checkpoint.nextPage === null && checkpoint.continuation === null &&
        checkpoint.pending.length > 0)
    ) {
      await flushSection(checkpoint, { ...input, deadlineAt: jobDeadlineAt });
      continue;
    }
    if (checkpoint.continuation === null && checkpoint.nextPage === null) {
      checkpoint.stage = "reducing";
      await input.save(checkpoint);
      break;
    }
    if (checkpoint.readCount >= (input.maxReads ?? LONG_PDF_MAX_READS)) {
      throw new LongPdfSummaryError(
        "limit",
        "The long-PDF summary reached its bounded Drive-read limit.",
        partialOutput(checkpoint, "the bounded Drive-read limit was reached"),
      );
    }
    const request: LongPdfReadRequest = checkpoint.continuation
      ? {
          fileId: checkpoint.fileId,
          continuation: checkpoint.continuation,
          revisionToken: checkpoint.revisionToken,
        }
      : {
          fileId: checkpoint.fileId,
          startPage: checkpoint.nextPage!,
          revisionToken: checkpoint.revisionToken,
        };
    await input.onProgress?.(
      "continuation" in request
        ? `Reading the next text continuation for PDF page batch starting at ${checkpoint.nextPage}.`
        : `Reading PDF pages ${request.startPage}-${Math.min(checkpoint.totalPages, request.startPage + 24)} of ${checkpoint.totalPages}.`,
    );
    let evidence: LongPdfSummaryEvidence;
    try {
      evidence = await input.readNext(request);
    } catch (error) {
      stopIfNeeded(checkpoint, input.signal, jobDeadlineAt, now);
      throw error;
    }
    // Do not commit a response received after the finite job expired. The
    // prior cursor remains durable, so a trusted resume can reread it safely.
    stopIfNeeded(checkpoint, input.signal, jobDeadlineAt, now);
    appendLongPdfEvidence(checkpoint, evidence);
    checkpoint.readCount += 1;
    await input.save(checkpoint);
    await input.onProgress?.(
      `Processed PDF coverage through page ${evidence.coverage.endPage} of ${checkpoint.totalPages}.`,
    );
  }
  await reduce(checkpoint, { ...input, deadlineAt: jobDeadlineAt });
  return {
    checkpoint,
    output: checkpoint.finalSummary ?? partialOutput(checkpoint, "final reduction is incomplete"),
    pagesProcessed: pagesProcessed(checkpoint),
    totalPages: checkpoint.totalPages,
  };
}