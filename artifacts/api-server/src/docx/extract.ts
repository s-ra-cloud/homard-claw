import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DOCX extraction has a deliberately closed error vocabulary. ZIP and XML
 * diagnostics can contain document names and text, so neither is surfaced.
 */
export type DocxExtractionErrorKind =
  | "cancelled"
  | "timeout"
  | "queue_full"
  | "input_too_large"
  | "resource_limit"
  | "encrypted"
  | "legacy"
  | "invalid_docx"
  | "extraction_failed";

const MESSAGES: Readonly<Record<DocxExtractionErrorKind, string>> = {
  cancelled: "DOCX text extraction was cancelled.",
  timeout: "DOCX text extraction timed out.",
  queue_full: "DOCX text extraction is temporarily busy. Please try again.",
  input_too_large: "The DOCX exceeds the 25,000,000-byte extraction limit.",
  resource_limit: "DOCX text extraction exceeded its resource limit.",
  encrypted: "The DOCX is encrypted and cannot be read without a password.",
  legacy: "Legacy Word documents cannot be read. Save the document as DOCX and try again.",
  invalid_docx: "The file is not a valid DOCX document.",
  extraction_failed: "DOCX text extraction could not be completed.",
};

export class DocxExtractionError extends Error {
  constructor(readonly kind: DocxExtractionErrorKind) {
    super(MESSAGES[kind]);
    this.name = "DocxExtractionError";
  }
}

export const DOCX_EXTRACTION_LIMITS = {
  maxInputBytes: 25_000_000,
  maxOutputChars: 1_500_000,
  maxConcurrent: 2,
  maxQueued: 4,
  maxV8OldSpaceMb: 128,
  // Node 24 reserves a large V8 code range before user code starts. Match the
  // proven PDF worker startup-compatible ceiling; the 64 MiB heap and ZIP/XML
  // limits still tightly bound actual parser work.
  maxAddressSpaceBytes: 2 * 1024 * 1024 * 1024,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
} as const;

export type ExtractDocxTextOptions = {
  signal?: AbortSignal;
  maxInputBytes?: number;
  deadlineAt?: number;
};

type WorkerResponse =
  | { type: "result"; text: string }
  | { type: "error"; kind: Exclude<DocxExtractionErrorKind, "cancelled" | "timeout" | "queue_full" | "input_too_large" | "resource_limit"> };

type Waiting = {
  start: () => void;
  reject: (error: DocxExtractionError) => void;
  signal?: AbortSignal;
  deadlineAt: number;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
};

let active = 0;
const waiting: Waiting[] = [];
const MAX_PROTOCOL_BYTES = 32 * 1024 * 1024;

function deadline(value?: number): number {
  const now = Date.now();
  const hard = now + DOCX_EXTRACTION_LIMITS.maxTimeoutMs;
  if (value === undefined) return now + DOCX_EXTRACTION_LIMITS.defaultTimeoutMs;
  return Number.isFinite(value) ? Math.min(value, hard) : hard;
}

function clearWaiting(entry: Waiting): void {
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
}

function release(): void {
  active -= 1;
  while (active < DOCX_EXTRACTION_LIMITS.maxConcurrent && waiting.length) {
    const entry = waiting.shift()!;
    if (entry.settled) continue;
    entry.settled = true;
    clearWaiting(entry);
    if (entry.signal?.aborted) entry.reject(new DocxExtractionError("cancelled"));
    else if (Date.now() >= entry.deadlineAt) entry.reject(new DocxExtractionError("timeout"));
    else {
      active += 1;
      entry.start();
    }
  }
}

function claim(signal: AbortSignal | undefined, deadlineAt: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DocxExtractionError("cancelled"));
  if (Date.now() >= deadlineAt) return Promise.reject(new DocxExtractionError("timeout"));
  if (active < DOCX_EXTRACTION_LIMITS.maxConcurrent) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= DOCX_EXTRACTION_LIMITS.maxQueued) {
    return Promise.reject(new DocxExtractionError("queue_full"));
  }
  return new Promise((resolve, reject) => {
    const entry: Waiting = { start: resolve, reject, signal, deadlineAt, settled: false };
    entry.onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      waiting.splice(waiting.indexOf(entry), 1);
      clearWaiting(entry);
      reject(new DocxExtractionError("cancelled"));
    };
    signal?.addEventListener("abort", entry.onAbort, { once: true });
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      waiting.splice(waiting.indexOf(entry), 1);
      clearWaiting(entry);
      reject(new DocxExtractionError("timeout"));
    }, Math.max(0, deadlineAt - Date.now()));
    entry.timer.unref?.();
    waiting.push(entry);
  });
}

function workerPath(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(directory) === "docx"
    ? path.join(directory, "extract-worker.mjs")
    : path.join(directory, "docx", "extract-worker.mjs");
}

function kill(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
  }
}

function isSafeText(text: string): boolean {
  if (text.includes("\0")) return false;
  let count = 0;
  for (const character of text) {
    count += 1;
    if (count > DOCX_EXTRACTION_LIMITS.maxOutputChars) return false;
    if (character === "\0") return false;
  }
  return true;
}

function extractInChild(bytes: Uint8Array, signal: AbortSignal | undefined, deadlineAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [
      "-c", 'ulimit -v "$1" || exit 125; shift; exec "$@"', "docx-extract-limit",
      String(Math.floor(DOCX_EXTRACTION_LIMITS.maxAddressSpaceBytes / 1024)),
      process.execPath, `--max-old-space-size=${DOCX_EXTRACTION_LIMITS.maxV8OldSpaceMb}`,
      "--disable-wasm-trap-handler",
      workerPath(),
    ], {
      // The parser needs no application state, credentials, network settings,
      // writable filesystem, stdout, or stderr.
      env: { NODE_ENV: "production", TZ: "UTC", LANG: "C.UTF-8" },
      cwd: "/", stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    let settled = false;
    let pending: DocxExtractionError | undefined;
    let response = Buffer.alloc(0);
    let received: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: DocxExtractionError, text?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(text ?? "");
    };
    const stop = (error: DocxExtractionError) => {
      if (settled || pending) return;
      pending = error;
      kill(child);
      if (child.exitCode !== null) finish(error);
    };
    const onAbort = () => stop(new DocxExtractionError("cancelled"));
    if (signal?.aborted) { stop(new DocxExtractionError("cancelled")); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => stop(new DocxExtractionError("timeout")), Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
    child.once("error", () => finish(pending ?? new DocxExtractionError("extraction_failed")));
    child.once("close", () => finish(pending ?? (received === undefined
      ? new DocxExtractionError("extraction_failed") : undefined), received));
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (response.byteLength + chunk.byteLength > MAX_PROTOCOL_BYTES) {
        stop(new DocxExtractionError("resource_limit"));
      } else response = Buffer.concat([response, chunk]);
    });
    child.stdio[3]?.once("end", () => {
      if (pending) return;
      try {
        const message = JSON.parse(response.toString("utf8")) as Partial<WorkerResponse>;
        if (message.type === "result" && typeof message.text === "string" && isSafeText(message.text)) {
          received = message.text;
        } else if (message.type === "error" && typeof message.kind === "string" && message.kind in MESSAGES) {
          stop(new DocxExtractionError(message.kind as DocxExtractionErrorKind));
        } else stop(new DocxExtractionError("extraction_failed"));
      } catch {
        stop(new DocxExtractionError("extraction_failed"));
      }
    });
    child.stdin?.once("error", () => stop(new DocxExtractionError("extraction_failed")));
    child.stdin?.end(Buffer.from(bytes));
  });
}

/** Extract bounded body paragraphs and tables from an untrusted DOCX package. */
export async function extractDocxText(bytes: Uint8Array, options: ExtractDocxTextOptions = {}): Promise<string> {
  const maxInput = Math.min(DOCX_EXTRACTION_LIMITS.maxInputBytes,
    Number.isFinite(options.maxInputBytes) && options.maxInputBytes! >= 0
      ? Math.floor(options.maxInputBytes!) : DOCX_EXTRACTION_LIMITS.maxInputBytes);
  if (bytes.byteLength > maxInput) throw new DocxExtractionError("input_too_large");
  const deadlineAt = deadline(options.deadlineAt);
  await claim(options.signal, deadlineAt);
  try {
    return await extractInChild(bytes, options.signal, deadlineAt);
  } finally {
    release();
  }
}