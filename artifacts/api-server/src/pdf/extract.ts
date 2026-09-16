import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The public failure vocabulary is deliberately fixed. Do not include parser,
 * operating-system, or document error messages here: PDFs routinely contain
 * private content and malformed files can echo it in an error message.
 */
export type PdfExtractionErrorKind =
  | "cancelled"
  | "timeout"
  | "queue_full"
  | "input_too_large"
  | "resource_limit"
  | "page_limit"
  | "invalid_page_range"
  | "page_out_of_range"
  | "encrypted"
  | "scanned"
  | "invalid_pdf"
  | "extraction_failed";

const PDF_EXTRACTION_ERROR_MESSAGES: Readonly<Record<PdfExtractionErrorKind, string>> = {
  cancelled: "PDF text extraction was cancelled.",
  timeout: "PDF text extraction timed out.",
  queue_full: "PDF text extraction is temporarily busy. Please try again.",
  input_too_large: "The PDF exceeds the 25,000,000-byte extraction limit.",
  resource_limit: "PDF text extraction exceeded its resource limit.",
  page_limit: "The PDF exceeds the 100-page extraction limit.",
  invalid_page_range: "PDF pages must be a page number or inclusive range (for example 7 or 7-9), between 1 and 100, selecting at most 5 pages.",
  page_out_of_range: "The requested PDF page or range does not exist in this document; no pages were returned.",
  encrypted: "The PDF is encrypted and cannot be read without a password.",
  scanned: "The PDF contains no extractable text; visual or image content cannot be read.",
  invalid_pdf: "The file is not a valid PDF.",
  extraction_failed: "PDF text extraction could not be completed.",
};

// JSON can expand one Unicode scalar to six UTF-8 bytes (escaped BMP code
// units), so the private pipe must be larger than the public 1.5M-scalar
// result limit. This remains bounded independently of worker output.
const MAX_PROTOCOL_BYTES = 32 * 1024 * 1024;

export class PdfExtractionError extends Error {
  readonly kind: PdfExtractionErrorKind;

  constructor(kind: PdfExtractionErrorKind) {
    super(PDF_EXTRACTION_ERROR_MESSAGES[kind]);
    this.name = "PdfExtractionError";
    this.kind = kind;
  }
}

export interface ExtractPdfTextOptions {
  pdfPages?: string;
  signal?: AbortSignal;
  /**
   * A caller may make the input limit stricter, but may not raise the service
   * limit. This prevents a call site from accidentally defeating the boundary.
   */
  maxInputBytes?: number;
  /**
   * Unix time in milliseconds. A hard service deadline still applies when
   * this is absent or farther in the future.
   */
  deadlineAt?: number;
}

export function parsePdfPages(value: unknown): { start: number; end: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d{0,2}(?:-[1-9]\d{0,2})?$/.test(value)) {
    throw new PdfExtractionError("invalid_page_range");
  }
  const [start, last] = value.split("-").map(Number);
  const end = last ?? start!;
  if (start! > end || end > 100 || end - start! >= 5) {
    throw new PdfExtractionError("invalid_page_range");
  }
  return { start: start!, end };
}

export const PDF_EXTRACTION_LIMITS = {
  maxInputBytes: 25_000_000,
  maxPages: 100,
  maxOutputChars: 1_500_000,
  maxConcurrent: 2,
  maxQueued: 4,
  maxV8OldSpaceMb: 256,
  // PDF.js loads its optional native canvas compatibility layer in Node 24;
  // its baseline virtual mappings need just under 2 GiB on the supported
  // Linux runtime. This is still an OS-enforced ceiling for all allocations,
  // while the 128 MiB V8 cap and 256 MiB RSS guard keep normal use far below.
  maxAddressSpaceBytes: 2 * 1024 * 1024 * 1024,
  // PDF.js's Node canvas compatibility module has a ~300 MiB peak RSS on
  // this runtime while importing. RLIMIT_AS is the hard 2 GiB ceiling; this
  // lower sampled guard catches sustained growth after startup.
  // Large but valid 1.5M-character documents can briefly retain PDF.js text
  // item/native buffers alongside the ~300 MiB import baseline. Keep the
  // sampled guard below the hard 2 GiB address-space ceiling while allowing
  // the supported output bound to complete.
  maxRssBytes: 768 * 1024 * 1024,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 30_000,
} as const;

type WorkerResponse =
  | { type: "result"; text: string }
  | { type: "error"; kind: Exclude<PdfExtractionErrorKind, "cancelled" | "timeout" | "queue_full" | "input_too_large" | "resource_limit"> };

interface QueueEntry {
  readonly start: () => void;
  readonly reject: (reason: PdfExtractionError) => void;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

let activeWorkers = 0;
const waiting: QueueEntry[] = [];

function finiteDeadline(deadlineAt: number | undefined): number {
  const now = Date.now();
  const hardDeadline = now + PDF_EXTRACTION_LIMITS.maxTimeoutMs;
  if (deadlineAt === undefined) {
    return now + PDF_EXTRACTION_LIMITS.defaultTimeoutMs;
  }
  if (!Number.isFinite(deadlineAt)) return hardDeadline;
  return Math.min(deadlineAt, hardDeadline);
}

function clearQueueEntry(entry: QueueEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  entry.timer = undefined;
  entry.onAbort = undefined;
}

function removeWaiting(entry: QueueEntry): void {
  const index = waiting.indexOf(entry);
  if (index !== -1) waiting.splice(index, 1);
}

function releaseSlot(): void {
  activeWorkers -= 1;
  while (waiting.length > 0 && activeWorkers < PDF_EXTRACTION_LIMITS.maxConcurrent) {
    const entry = waiting.shift();
    if (!entry || entry.settled) continue;
    if (entry.signal?.aborted) {
      entry.settled = true;
      clearQueueEntry(entry);
      entry.reject(new PdfExtractionError("cancelled"));
      continue;
    }
    if (Date.now() >= entry.deadlineAt) {
      entry.settled = true;
      clearQueueEntry(entry);
      entry.reject(new PdfExtractionError("timeout"));
      continue;
    }
    entry.settled = true;
    clearQueueEntry(entry);
    activeWorkers += 1;
    entry.start();
  }
}

function claimSlot(signal: AbortSignal | undefined, deadlineAt: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PdfExtractionError("cancelled"));
  if (Date.now() >= deadlineAt) return Promise.reject(new PdfExtractionError("timeout"));
  if (activeWorkers < PDF_EXTRACTION_LIMITS.maxConcurrent) {
    activeWorkers += 1;
    return Promise.resolve();
  }
  if (waiting.length >= PDF_EXTRACTION_LIMITS.maxQueued) {
    return Promise.reject(new PdfExtractionError("queue_full"));
  }

  return new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = {
      start: resolve,
      reject,
      signal,
      deadlineAt,
      timer: undefined,
      onAbort: undefined,
      settled: false,
    };
    entry.onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      removeWaiting(entry);
      clearQueueEntry(entry);
      reject(new PdfExtractionError("cancelled"));
    };
    signal?.addEventListener("abort", entry.onAbort, { once: true });
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      removeWaiting(entry);
      clearQueueEntry(entry);
      reject(new PdfExtractionError("timeout"));
    }, Math.max(0, deadlineAt - Date.now()));
    entry.timer.unref?.();
    waiting.push(entry);
  });
}

function workerPath(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  // Source tests execute src/pdf/extract.ts directly; esbuild folds it into
  // dist/index.mjs, while build.mjs copies the worker to dist/pdf.
  return path.basename(directory) === "pdf"
    ? path.join(directory, "extract-worker.mjs")
    : path.join(directory, "pdf", "extract-worker.mjs");
}

function kill(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the state check and kill.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rssBytes(pid: number): Promise<number | "exited"> {
  // Linux reports RSS in kB. An unreadable /proc entry only means that the
  // A missing or unparsable value is deliberately an error. External
  // ArrayBuffers/native memory are outside V8's heap cap, so an alive child
  // which cannot be sampled cannot safely continue.
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  // Linux retains /proc entries for a zombie until its parent reaps it, but
  // removes VmRSS. That process has already stopped executing and must not
  // replace a parser response that is concurrently draining from fd 3.
  if (/^State:\s+Z/m.test(status)) return "exited";
  const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
  if (!value) throw new Error("RSS unavailable");
  return Number(value) * 1024;
}

async function isRunningNonZombie(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // /proc/<pid>/stat is "<pid> (<comm>) <state> ..."; comm can contain
    // spaces, hence find its final closing parenthesis rather than split.
    return /^\d+ \(.*\) ([^Z]) /.test(stat);
  } catch {
    // If procfs itself is unavailable but the process is demonstrably alive,
    // fail closed. A zombie is handled by the stat path above.
    return isAlive(pid);
  }
}

function isPostgresSafeText(text: string): boolean {
  if (text.includes("\0")) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return Array.from(text).length <= PDF_EXTRACTION_LIMITS.maxOutputChars;
}

function extractInChild(bytes: Uint8Array, signal: AbortSignal | undefined, deadlineAt: number, pages?: { start: number; end: number }): Promise<string> {
  if (signal?.aborted) return Promise.reject(new PdfExtractionError("cancelled"));
  return new Promise<string>((resolve, reject) => {
    // RLIMIT_AS is an OS-enforced limit over V8 heap, ArrayBuffers, native
    // decoders, mappings, and all other address-space allocations. Node's
    // wasm trap-handler reservation does not fit below this practical 2 GiB
    // cap, so explicitly disable it before PDF.js is loaded.
    const child = spawn("/bin/sh", [
      "-c",
      'ulimit -v "$1" || exit 125; shift; exec "$@"',
      "pdf-extract-limit",
      String(Math.floor(PDF_EXTRACTION_LIMITS.maxAddressSpaceBytes / 1024)),
      process.execPath,
      `--max-old-space-size=${PDF_EXTRACTION_LIMITS.maxV8OldSpaceMb}`,
      "--disable-wasm-trap-handler",
      workerPath(),
      ...(pages ? [String(pages.start), String(pages.end)] : []),
    ], {
      // Do not inherit NODE_OPTIONS (or any application secrets). The child
      // needs no credentials, network configuration, or writable stdio.
      env: { NODE_ENV: "production", TZ: "UTC", LANG: "C.UTF-8" },
      cwd: "/",
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    let settled = false;
    let rssCheckInFlight = false;
    let rssTimer: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let pendingError: PdfExtractionError | undefined;
    let resultText: string | undefined;
    let responseBytes = Buffer.alloc(0);

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (rssTimer) clearInterval(rssTimer);
      signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners();
    };
    const finish = (error?: PdfExtractionError, text?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const stop = (error: PdfExtractionError): void => {
      if (settled || pendingError) return;
      pendingError = error;
      kill(child);
      // A process that had already exited can have its exit event queued
      // behind this callback. It is reaped, so no longer consume a slot.
      if (child.exitCode !== null) finish(pendingError);
    };
    const onAbort = (): void => stop(new PdfExtractionError("cancelled"));

    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => stop(new PdfExtractionError("timeout")),
      Math.max(0, deadlineAt - Date.now()),
    );
    timeout.unref?.();
    rssTimer = setInterval(() => {
      if (rssCheckInFlight || settled || resultText !== undefined || !child.pid) return;
      rssCheckInFlight = true;
      void rssBytes(child.pid).then((rss) => {
        rssCheckInFlight = false;
        if (rss !== "exited" && responseBytes.byteLength === 0
          && rss > PDF_EXTRACTION_LIMITS.maxRssBytes) {
          stop(new PdfExtractionError("resource_limit"));
        }
      }).catch(() => {
        rssCheckInFlight = false;
        // A response may be in the fd-3 pipe just before child exit. Do not
        // turn its safe parser error into a resource error while it drains.
        if (settled || resultText !== undefined || responseBytes.byteLength > 0 || !child.pid) return;
        void isRunningNonZombie(child.pid).then((running) => {
          if (!settled && resultText === undefined && responseBytes.byteLength === 0 && running) {
            stop(new PdfExtractionError("resource_limit"));
          }
        });
      });
    }, 50);
    rssTimer.unref?.();

    child.once("error", () => {
      const error = pendingError ?? new PdfExtractionError("extraction_failed");
      // A spawn failure has no child to reap. Any later error belongs to a
      // real child, which must be killed and observed through "exit" before
      // releasing its shared concurrency slot.
      if (!child.pid || child.exitCode !== null) {
        finish(error);
      } else {
        stop(error);
      }
    });
    // "exit" can precede the final protocol pipe data/end events. "close"
    // observes both a reaped child and fully drained stdio, so large valid
    // Unicode responses cannot be mistaken for a missing response.
    child.once("close", () => {
      if (settled) return;
      if (pendingError) finish(pendingError);
      else if (resultText !== undefined) finish(undefined, resultText);
      else finish(new PdfExtractionError("extraction_failed"));
    });
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      // The protocol is content-bearing only inside this local pipe. Cap it
      // before parsing so a compromised worker cannot make the server buffer
      // arbitrary output.
      if (responseBytes.byteLength + chunk.byteLength > MAX_PROTOCOL_BYTES) {
        stop(new PdfExtractionError("resource_limit"));
        return;
      }
      responseBytes = Buffer.concat([responseBytes, chunk]);
    });
    child.stdio[3]?.once("end", () => {
      if (pendingError || resultText !== undefined) return;
      let message: unknown;
      try {
        message = JSON.parse(responseBytes.toString("utf8"));
        } catch {
        stop(new PdfExtractionError("extraction_failed"));
        return;
      }
      if (!message || typeof message !== "object") {
        stop(new PdfExtractionError("extraction_failed"));
        return;
      }
      const response = message as Partial<WorkerResponse>;
      if (response.type === "result" && typeof response.text === "string"
        && isPostgresSafeText(response.text)) {
        // Wait for the worker's exit event. The caller's concurrency slot is
        // not released until the child is reaped, even after a valid response.
        resultText = response.text;
      } else if (response.type === "error" && typeof response.kind === "string"
        && response.kind in PDF_EXTRACTION_ERROR_MESSAGES) {
        stop(new PdfExtractionError(response.kind as PdfExtractionErrorKind));
      } else {
        stop(new PdfExtractionError("extraction_failed"));
      }
    });
    child.stdin?.once("error", () => stop(new PdfExtractionError("extraction_failed")));
    child.stdin?.end(Buffer.from(bytes));
  });
}

/**
 * Extract text from an untrusted PDF in a short-lived, memory-bounded process.
 * Returned text has PG-safe page separators and explicitly describes text/image
 * omissions; it never contains a PostgreSQL-invalid NUL byte.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: ExtractPdfTextOptions = {},
): Promise<string> {
  const pages = parsePdfPages(options.pdfPages);
  const inputLimit = Math.min(
    PDF_EXTRACTION_LIMITS.maxInputBytes,
    Number.isFinite(options.maxInputBytes) && options.maxInputBytes! >= 0
      ? Math.floor(options.maxInputBytes!)
      : PDF_EXTRACTION_LIMITS.maxInputBytes,
  );
  if (bytes.byteLength > inputLimit) throw new PdfExtractionError("input_too_large");

  const deadlineAt = finiteDeadline(options.deadlineAt);
  await claimSlot(options.signal, deadlineAt);
  try {
    return await extractInChild(bytes, options.signal, deadlineAt, pages);
  } finally {
    releaseSlot();
  }
}