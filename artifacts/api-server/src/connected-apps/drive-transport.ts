/**
 * Bounded transport for google_drive.read_file.
 *
 * A Drive read is a small workflow rather than one request: resolving the
 * credential, reading metadata, choosing an export/download endpoint, and
 * consuming the response body. Keeping that workflow here gives every step
 * the same deadline and abort signal. In particular, an error returned from
 * this module is deliberately safe to persist in an action row: it contains
 * no provider response body, downloaded text, file name, URL, or exception
 * message.
 */

import type { DriveAccessTokenOptions } from "../google/credentials";
import { extractPdfText, parsePdfPages, PdfExtractionError } from "../pdf/extract";

export const DEFAULT_DRIVE_READ_TIMEOUT_MS = 30_000;
/** A read can be large, but never allows an unbounded response body. */
export const MAX_DRIVE_READ_BODY_BYTES = 2 * 1024 * 1024;

const DRIVE_API_BASE_URL = "https://www.googleapis.com";
const DRIVE_EXPORTABLE_PREFIX = "application/vnd.google-apps.";
const DRIVE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

export type DriveTokenOptions = DriveAccessTokenOptions;

export type DriveTokenResolver = (
  workspaceId: string,
  options: DriveTokenOptions,
) => Promise<string>;

export type DriveReadTransportFailure = {
  ok: false;
  kind: "auth" | "failed";
  message: string;
  /** Only credential-resolution refusals are safe to replay before a read. */
  refusedBeforeExecution?: boolean;
};

export type DriveReadFailureClass =
  | "credential_missing"
  | "credential_scope"
  | "credential_revoked"
  | "credential_unavailable"
  | "http_auth"
  | "permission"
  | "rate_limit"
  | "not_found"
  | "server"
  | "http_rejected"
  | "timeout"
  | "cancelled"
  | "metadata"
  | "body_limit"
  | "unsupported_content"
  | "pdf_extraction"
  | "transport";

export type DriveReadFailureDetails = {
  stage: string;
  failureClass: DriveReadFailureClass;
  providerStatus?: number;
};

export type DriveReadTransportResult =
  | {
      ok: true;
      name: string | null;
      mimeType: string;
      text: string;
    }
  | DriveReadTransportFailure;

export type DriveFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DriveReadInput = {
  workspaceId: string | null;
  fileId: string;
  pdfPages?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  /**
   * Correlation is accepted so callers can keep the context explicit. It is
   * intentionally never put in an owner/model-facing error message.
   */
  taskId?: string;
  resolveToken: DriveTokenResolver;
  fetchImpl?: DriveFetch;
  /**
   * Test seam for the shared extractor. Production callers omit this and
   * always use extractPdfText from the isolated PDF service.
   */
  extractPdf?: typeof extractPdfText;
  now?: () => number;
  onStage?: (stage: string) => void;
  onFailure?: (details: DriveReadFailureDetails) => void;
};

type TransportState = {
  controller: AbortController;
  deadlineAt: number;
  now: () => number;
  deadlineExpired: boolean;
  onStage?: (stage: string) => void;
  onFailure?: (details: DriveReadFailureDetails) => void;
  currentStage: string;
  failureReported: boolean;
};

/**
 * Drive error payloads can contain request details and are not safe
 * diagnostics. A bounded body may be inspected only for the closed
 * "insufficient scope" classification; it is never returned.
 */
export function classifyDriveReadHttpFailure(
  status: number,
  headers?: Headers | null,
  bodyText?: string,
): DriveReadTransportFailure {
  let retryAfter = false;
  try {
    const retryAfterValue = headers?.get("retry-after");
    retryAfter =
      typeof retryAfterValue === "string" && retryAfterValue.trim().length > 0;
  } catch {
    // A malformed test/provider Headers implementation is still a safe
    // provider refusal; it must not turn into an exception with raw details.
  }

  if (status === 401) {
    return {
      ok: false,
      kind: "auth",
      message:
        "Google Drive authorization was refused (HTTP 401). Reconnect Google Drive and try again.",
    };
  }
  if (status === 403) {
    const reason = driveErrorReason(bodyText);
    if (
      retryAfter ||
      reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded"
    ) {
      return {
        ok: false,
        kind: "failed",
        message:
          "Google Drive is rate-limiting this request (HTTP 403). Retry shortly.",
      };
    }
    // Google sometimes reports a grant that was narrowed after the token was
    // issued as a 403 rather than during credential resolution. Inspect only
    // for this closed classification; never echo the body.
    if (reason === "insufficientPermissions") {
      return {
        ok: false,
        kind: "auth",
        message:
          "The connected Google account is missing required Google Drive permissions. Reconnect Google Drive and try again.",
      };
    }
    return {
      ok: false,
      kind: "failed",
      message:
        "Google Drive refused access to this file (HTTP 403). Check the connected account's permission on the file.",
    };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: "failed",
      message:
        "Google Drive is rate-limiting this request (HTTP 429). Retry shortly.",
    };
  }
  if (status === 404) {
    return {
      ok: false,
      kind: "failed",
      message:
        "Google Drive could not find the requested file (HTTP 404). Verify the file id and try again.",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      kind: "failed",
      message:
        "Google Drive reported a temporary server error. Retry the read shortly.",
    };
  }
  return {
    ok: false,
    kind: "failed",
    message: `Google Drive rejected the read request (HTTP ${status}).`,
  };
}

type DriveErrorReason =
  | "rateLimitExceeded"
  | "userRateLimitExceeded"
  | "insufficientPermissions"
  | null;

/**
 * Parse only Google's documented reason codes. Never classify based on free
 * text: a file's name or body can contain words such as "scope".
 */
function driveErrorReason(bodyText?: string): DriveErrorReason {
  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return null;
    const root = parsed as {
      error?: {
        errors?: unknown;
        reason?: unknown;
        details?: unknown;
      };
    };
    const reasons: unknown[] = [];
    if (root.error && typeof root.error === "object") {
      // Google APIs also use google.rpc.ErrorInfo for narrowed scopes.
      // Neither the free-text message nor generic PERMISSION_DENIED proves
      // that reconnecting will fix a file-level access refusal.
      if (Array.isArray(root.error.details)) {
        for (const detail of root.error.details) {
          if (!detail || typeof detail !== "object") continue;
          const info = detail as Record<string, unknown>;
          if (
            info["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
            info.domain === "googleapis.com" &&
            info.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
          ) reasons.push("insufficientPermissions");
        }
      }
      reasons.push(root.error.reason);
      if (Array.isArray(root.error.errors)) {
        for (const entry of root.error.errors) {
          if (entry && typeof entry === "object") {
            reasons.push((entry as { reason?: unknown }).reason);
          }
        }
      }
    }
    for (const reason of reasons) {
      if (
        reason === "rateLimitExceeded" ||
        reason === "userRateLimitExceeded" ||
        reason === "insufficientPermissions"
      ) {
        return reason;
      }
    }
  } catch {
    // Provider refusal bodies are optional and may be malformed.
  }
  return null;
}

function httpFailureClass(
  status: number,
  headers?: Headers | null,
  bodyText?: string,
): DriveReadFailureClass {
  let retryAfter = false;
  try {
    const retryAfterValue = headers?.get("retry-after");
    retryAfter =
      typeof retryAfterValue === "string" && retryAfterValue.trim().length > 0;
  } catch {
    // Status classification remains safe if a test/provider Headers is broken.
  }
  const reason = driveErrorReason(bodyText);
  if (status === 401) return "http_auth";
  if (status === 403 && reason === "insufficientPermissions") {
    return "permission";
  }
  if (
    status === 403 &&
    (retryAfter ||
      reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded")
  ) {
    return "rate_limit";
  }
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "http_rejected";
}

function noWorkspaceFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "auth",
    refusedBeforeExecution: true,
    message:
      "This task has no workspace owner, so no connected account can be used for it.",
  };
}

function cancelledFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: "The Google Drive read was cancelled.",
  };
}

function deadlineFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: "The Google Drive read timed out before it completed.",
  };
}

function transportFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: "The Google Drive read could not be completed.",
  };
}

class BoundedStop extends Error {
  constructor(readonly failure: DriveReadTransportFailure) {
    super(failure.message);
    this.name = "BoundedDriveReadStop";
  }
}

function bodyTooLargeFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: "Google Drive returned a file larger than the read limit.",
  };
}

function metadataFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: "Google Drive returned invalid file metadata.",
  };
}

function unsupportedContentFailure(): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message:
      "Google Drive could not read this file as text. PDFs use separate text extraction; Word, image, and other unsupported binary files cannot be read.",
  };
}

function pdfExtractionFailure(message?: string): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    // PdfExtractionError's message is an intentionally closed, safe message.
    // Do not use messages from any other error: parser implementations can
    // include document contents, paths, or diagnostic data in those.
    message:
      message ??
      "Google Drive could not extract readable text from this PDF.",
  };
}

function isPdfDownload(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

function isTextDownload(mimeType: string): boolean {
  return mimeType.startsWith("text/") || [
    "application/json", "application/xml", "application/javascript",
    "application/x-javascript", "application/yaml", "application/x-yaml",
    "application/sql", "application/rtf",
  ].includes(mimeType) || mimeType.endsWith("+json") || mimeType.endsWith("+xml");
}

function validateTextContent(text: string): string | DriveReadTransportFailure {
  // PostgreSQL text cannot store NUL; binary signatures must never become
  // apparently successful text merely because the metadata says text/plain.
  if (text.includes("\0") || text.startsWith("%PDF-") || text.startsWith("PK\u0003\u0004")) {
    return unsupportedContentFailure();
  }
  return text;
}

function failureForStop(state: TransportState): DriveReadTransportFailure {
  if (state.deadlineExpired || state.now() >= state.deadlineAt) {
    return deadlineFailure();
  }
  return cancelledFailure();
}

function safeStage(state: TransportState, stage: string): void {
  state.currentStage = stage;
  try {
    state.onStage?.(stage);
  } catch {
    // Stage reporting is observability only and must never skip finalization.
  }
}

function reportFailure(
  state: TransportState,
  details: Omit<DriveReadFailureDetails, "stage"> & { stage?: string },
): void {
  if (state.failureReported) return;
  state.failureReported = true;
  try {
    state.onFailure?.({
      ...details,
      stage: details.stage ?? state.currentStage,
    });
  } catch {
    // Failure reporting is observability only and must never affect the result.
  }
}

function failureDetailsForStop(
  failure: DriveReadTransportFailure,
): Omit<DriveReadFailureDetails, "stage"> {
  return {
    failureClass:
      failure.message.includes("timed out") ? "timeout" : "cancelled",
  };
}

function failureDetailsForCredential(
  error: unknown,
): Omit<DriveReadFailureDetails, "stage"> {
  if (isGoogleAuthFailure(error)) {
    if (error.classification === "missing_scope") {
      return { failureClass: "credential_scope" };
    }
    if (error.kind === "not_connected") {
      return { failureClass: "credential_missing" };
    }
    if (error.kind === "reconnect_required") {
      return {
        failureClass: "credential_revoked",
        ...(typeof error.status === "number"
          ? { providerStatus: error.status }
          : {}),
      };
    }
    return { failureClass: "credential_unavailable" };
  }
  return { failureClass: "credential_unavailable" };
}

function fallbackFailureDetails(
  failure: DriveReadTransportFailure,
): Omit<DriveReadFailureDetails, "stage"> {
  if (failure.message.includes("timed out")) {
    return { failureClass: "timeout" };
  }
  if (failure.message.includes("cancelled")) {
    return { failureClass: "cancelled" };
  }
  if (failure.message.includes("metadata")) {
    return { failureClass: "metadata" };
  }
  if (failure.message.includes("larger than")) {
    return { failureClass: "body_limit" };
  }
  if (failure.kind === "auth") {
    return { failureClass: "credential_unavailable" };
  }
  return { failureClass: "transport" };
}

/**
 * Await an operation while retaining a hard upper bound even if a mocked
 * transport (or an unexpected library implementation) ignores AbortSignal.
 * The real fetch and credential refresh both receive the same signal, so this
 * race is a last line of defence rather than a substitute for cancellation.
 */
function runBounded<T>(
  start: () => PromiseLike<T>,
  state: TransportState,
): Promise<T> {
  if (state.controller.signal.aborted) {
    return Promise.reject(new BoundedStop(failureForStop(state)));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      state.controller.signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(new BoundedStop(failureForStop(state))));
    };

    state.controller.signal.addEventListener("abort", onAbort, { once: true });
    let work: PromiseLike<T>;
    try {
      work = start();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(work).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function responseBodySize(response: Response): number | null {
  try {
    const value = response.headers.get("content-length");
    if (!value) return null;
    const length = Number(value);
    return Number.isFinite(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

function discardResponseBody(response: Response): void {
  try {
    const cancelled = response.body?.cancel();
    if (cancelled) void cancelled.catch(() => undefined);
  } catch {
    // The response is already being discarded; a broken cancel implementation
    // must not replace the original safe transport classification.
  }
}

/**
 * Consume a response as bytes under the same body limit and abort boundary as
 * text reads. PDFs must reach the shared extractor as bytes: decoding them as
 * UTF-8 first corrupts valid files and can accidentally leak raw binary into
 * an action result.
 */
async function boundedResponseBytes(
  response: Response,
  state: TransportState,
  reportBodyFailure = true,
): Promise<Uint8Array | DriveReadTransportFailure> {
  const contentLength = responseBodySize(response);
  if (contentLength !== null && contentLength > MAX_DRIVE_READ_BODY_BYTES) {
    state.controller.abort();
    discardResponseBody(response);
    if (reportBodyFailure) {
      reportFailure(state, { failureClass: "body_limit", stage: "body" });
    }
    return bodyTooLargeFailure();
  }

  if (!response.body) {
    const buffer = await runBounded(() => response.arrayBuffer(), state);
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > MAX_DRIVE_READ_BODY_BYTES) {
      state.controller.abort();
      if (reportBodyFailure) {
        reportFailure(state, { failureClass: "body_limit", stage: "body" });
      }
      return bodyTooLargeFailure();
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await runBounded(() => reader.read(), state);
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > MAX_DRIVE_READ_BODY_BYTES) {
        state.controller.abort();
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // The body is already over the cap; preserve that safe outcome.
        }
        if (reportBodyFailure) {
          reportFailure(state, { failureClass: "body_limit", stage: "body" });
        }
        return bodyTooLargeFailure();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Preserve the stop or generic body failure below.
    }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Consume a response without ever retaining more than the configured body
 * cap. Error response text is used only for closed status classification and
 * is never included in an outcome.
 */
async function boundedResponseText(
  response: Response,
  state: TransportState,
  reportBodyFailure = true,
): Promise<string | DriveReadTransportFailure> {
  const bytes = await boundedResponseBytes(response, state, reportBodyFailure);
  if (!(bytes instanceof Uint8Array)) return bytes;
  try {
    return validateTextContent(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return unsupportedContentFailure();
  }
}

async function requestDrivePdf(
  path: string,
  token: string,
  state: TransportState,
  fetchImpl: DriveFetch,
): Promise<Uint8Array | DriveReadTransportFailure> {
  safeStage(state, "download");
  let response: Response;
  try {
    response = await runBounded(
      () =>
        fetchImpl(`${DRIVE_API_BASE_URL}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: state.controller.signal,
        }),
      state,
    );
  } catch (error) {
    if (error instanceof BoundedStop) {
      reportFailure(state, {
        ...failureDetailsForStop(error.failure),
        stage: "download",
      });
      return error.failure;
    }
    if (state.controller.signal.aborted) {
      const failure = failureForStop(state);
      reportFailure(state, {
        ...failureDetailsForStop(failure),
        stage: "download",
      });
      return failure;
    }
    reportFailure(state, { failureClass: "transport", stage: "download" });
    return transportFailure();
  }

  if (!response.ok) {
    let bodyText: string | undefined;
    try {
      const body = await boundedResponseText(response, state, false);
      if (typeof body === "string") bodyText = body;
    } catch {
      if (state.controller.signal.aborted) {
        const failure = failureForStop(state);
        reportFailure(state, {
          ...failureDetailsForStop(failure),
          stage: "download",
        });
        return failure;
      }
    }
    const failure = classifyDriveReadHttpFailure(
      response.status,
      response.headers,
      bodyText,
    );
    reportFailure(state, {
      failureClass: httpFailureClass(response.status, response.headers, bodyText),
      providerStatus: response.status,
      stage: "download",
    });
    return failure;
  }

  safeStage(state, "body");
  try {
    const body = await boundedResponseBytes(response, state);
    if (!(body instanceof Uint8Array) && !state.failureReported) {
      reportFailure(state, { failureClass: "transport", stage: "body" });
    }
    return body;
  } catch {
    if (state.controller.signal.aborted) {
      const failure = failureForStop(state);
      reportFailure(state, {
        ...failureDetailsForStop(failure),
        stage: "body",
      });
      return failure;
    }
    reportFailure(state, { failureClass: "transport", stage: "body" });
    return transportFailure();
  }
}

async function requestDriveRead(
  path: string,
  token: string,
  state: TransportState,
  fetchImpl: DriveFetch,
  stage: "metadata" | "export" | "download",
): Promise<string | DriveReadTransportFailure> {
  safeStage(state, stage);
  let response: Response;
  try {
    response = await runBounded(
      () =>
        fetchImpl(`${DRIVE_API_BASE_URL}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: state.controller.signal,
        }),
      state,
    );
  } catch (error) {
    if (error instanceof BoundedStop) {
      reportFailure(state, {
        ...failureDetailsForStop(error.failure),
        stage,
      });
      return error.failure;
    }
    if (state.controller.signal.aborted) {
      const failure = failureForStop(state);
      reportFailure(state, { ...failureDetailsForStop(failure), stage });
      return failure;
    }
    // Do not expose fetch's message: it can contain a URL, proxy details, or
    // another provider response body.
    reportFailure(state, { failureClass: "transport", stage });
    return transportFailure();
  }

  if (!response.ok) {
    let bodyText: string | undefined;
    try {
      // A status code is sufficient for the safe refusal classification; do
      // not let a huge refusal body replace it with a body-limit diagnostic.
      const body = await boundedResponseText(response, state, false);
      if (typeof body === "string") bodyText = body;
    } catch {
      if (state.controller.signal.aborted) {
        const failure = failureForStop(state);
        reportFailure(state, { ...failureDetailsForStop(failure), stage });
        return failure;
      }
      // A refusal still has a safe status-only classification when its error
      // body is malformed or cannot be consumed.
    }
    const failure = classifyDriveReadHttpFailure(
      response.status,
      response.headers,
      bodyText,
    );
    reportFailure(state, {
      failureClass: httpFailureClass(
        response.status,
        response.headers,
        bodyText,
      ),
      providerStatus: response.status,
      stage,
    });
    return failure;
  }

  safeStage(state, "body");
  try {
    const body = await boundedResponseText(response, state);
    if (typeof body !== "string") {
      // boundedResponseText reports a body limit before returning it.
      if (!state.failureReported) {
        reportFailure(state, {
          failureClass: "transport",
          stage: "body",
        });
      }
    }
    return body;
  } catch {
    if (state.controller.signal.aborted) {
      const failure = failureForStop(state);
      reportFailure(state, {
        ...failureDetailsForStop(failure),
        stage: "body",
      });
      return failure;
    }
    reportFailure(state, { failureClass: "transport", stage: "body" });
    return transportFailure();
  }
}

function isGoogleAuthFailure(
  error: unknown,
): error is {
  kind: "not_connected" | "reconnect_required" | "unavailable";
  message: string;
  classification?: string;
  status?: number;
} {
  return (
    error !== null &&
    typeof error === "object" &&
    "kind" in error &&
    (error as { kind?: unknown }).kind !== undefined &&
    ["not_connected", "reconnect_required", "unavailable"].includes(
      String((error as { kind: unknown }).kind),
    ) &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function credentialFailure(error: unknown): DriveReadTransportFailure {
  if (isGoogleAuthFailure(error)) {
    if (error.kind === "unavailable") {
      return {
        ok: false,
        kind: "failed",
        message: "Google Drive credentials were temporarily unavailable.",
      };
    }
    if (error.classification === "missing_scope") {
      return {
        ok: false,
        kind: "auth",
        refusedBeforeExecution: true,
        message:
          "The connected Google account is missing required Google Drive permissions. Reconnect Google Drive and try again.",
      };
    }
    if (error.kind === "reconnect_required") {
      return {
        ok: false,
        kind: "auth",
        refusedBeforeExecution: true,
        message:
          "The connected Google account is no longer authorized. Reconnect Google Drive and try again.",
      };
    }
    return {
      ok: false,
      kind: "auth",
      refusedBeforeExecution: true,
      message:
        "No Google Drive account is connected to this workspace. Connect Google Drive and try again.",
    };
  }
  return {
    ok: false,
    kind: "failed",
    message: "Google Drive credentials could not be resolved.",
  };
}

function mimeExport(mimeType: string): string {
  return mimeType === DRIVE_SPREADSHEET_MIME ? "text/csv" : "text/plain";
}

/**
 * Read one Drive file through metadata + export/download, under one total
 * deadline. All failures are returned as safe outcomes; this function never
 * throws a provider/body/parser error to action finalization.
 */
export async function readDriveFileTransport(
  input: DriveReadInput,
): Promise<DriveReadTransportResult> {
  try {
    parsePdfPages(input.pdfPages);
  } catch {
    return pdfExtractionFailure(new PdfExtractionError("invalid_page_range").message);
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const defaultDeadlineAt = startedAt + DEFAULT_DRIVE_READ_TIMEOUT_MS;
  const requestedDeadline =
    input.deadlineAt !== undefined && Number.isFinite(input.deadlineAt)
      ? input.deadlineAt
      : defaultDeadlineAt;
  const deadlineAt = Math.min(defaultDeadlineAt, requestedDeadline);
  const controller = new AbortController();
  const state: TransportState = {
    controller,
    deadlineAt,
    now,
    deadlineExpired: false,
    onStage: input.onStage,
    onFailure: input.onFailure,
    currentStage: "starting",
    failureReported: false,
  };
  const finish = (result: DriveReadTransportResult): DriveReadTransportResult => {
    if (!result.ok && !state.failureReported) {
      reportFailure(state, fallbackFailureDetails(result));
    }
    return result;
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = (): void => {
    controller.abort();
  };

  try {
    if (!input.workspaceId) return finish(noWorkspaceFailure());
    if (input.signal?.aborted) return finish(cancelledFailure());
    if (now() >= deadlineAt) return finish(deadlineFailure());

    if (input.signal) {
      input.signal.addEventListener("abort", onCallerAbort, { once: true });
      if (input.signal.aborted) {
        controller.abort();
        return finish(cancelledFailure());
      }
    }
    const remaining = Math.max(0, deadlineAt - now());
    deadlineTimer = setTimeout(() => {
      state.deadlineExpired = true;
      controller.abort();
    }, remaining);

    safeStage(state, "credentials");
    let token: string;
    try {
      token = await runBounded(
        () =>
          input.resolveToken(input.workspaceId!, {
            signal: controller.signal,
            deadlineAt,
            onStage: (stage) => safeStage(state, stage),
          }),
        state,
      );
    } catch (error) {
      if (error instanceof BoundedStop) {
        reportFailure(state, {
          ...failureDetailsForStop(error.failure),
          stage: "credentials",
        });
        return error.failure;
      }
      if (controller.signal.aborted) {
        const failure = failureForStop(state);
        reportFailure(state, {
          ...failureDetailsForStop(failure),
          stage: "credentials",
        });
        return failure;
      }
      const failure = credentialFailure(error);
      reportFailure(state, {
        ...failureDetailsForCredential(error),
        stage: "credentials",
      });
      return failure;
    }
    if (typeof token !== "string" || token.length === 0) {
      const failure = credentialFailure(new Error("missing token"));
      reportFailure(state, {
        failureClass: "credential_unavailable",
        stage: "credentials",
      });
      return failure;
    }

    const fileId = encodeURIComponent(input.fileId);
    const metadata = await requestDriveRead(
      `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType")}&supportsAllDrives=true`,
      token,
      state,
      input.fetchImpl ?? fetch,
      "metadata",
    );
    if (typeof metadata !== "string") return finish(metadata);

    let file: { name?: unknown; mimeType?: unknown };
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (!parsed || typeof parsed !== "object") {
        const failure = metadataFailure();
        reportFailure(state, { failureClass: "metadata", stage: "metadata" });
        return failure;
      }
      file = parsed as { name?: unknown; mimeType?: unknown };
    } catch {
      const failure = metadataFailure();
      reportFailure(state, { failureClass: "metadata", stage: "metadata" });
      return failure;
    }

    const mimeType = typeof file.mimeType === "string" ? file.mimeType.toLowerCase().split(";")[0].trim() : "";
    if (!mimeType || (typeof file.name === "string" && file.name.includes("\0"))) {
      reportFailure(state, { failureClass: "metadata", stage: "metadata" });
      return metadataFailure();
    }
    if (
      !mimeType.startsWith(DRIVE_EXPORTABLE_PREFIX) &&
      !isTextDownload(mimeType) &&
      !isPdfDownload(mimeType)
    ) {
      reportFailure(state, { failureClass: "unsupported_content", stage: "metadata" });
      return unsupportedContentFailure();
    }
    if (input.pdfPages !== undefined && !isPdfDownload(mimeType)) {
      return finish(pdfExtractionFailure("pdfPages is only supported for PDF files; no content was read."));
    }
    if (isPdfDownload(mimeType)) {
      const pdf = await requestDrivePdf(
        `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        token,
        state,
        input.fetchImpl ?? fetch,
      );
      if (!(pdf instanceof Uint8Array)) return finish(pdf);

      safeStage(state, "extract");
      try {
        const text = await runBounded(
          () =>
            (input.extractPdf ?? extractPdfText)(pdf, {
              signal: state.controller.signal,
              maxInputBytes: MAX_DRIVE_READ_BODY_BYTES,
              deadlineAt,
              pdfPages: input.pdfPages,
            }),
          state,
        );
        if (typeof text !== "string" || text.includes("\0")) {
          const failure = pdfExtractionFailure();
          reportFailure(state, { failureClass: "pdf_extraction", stage: "extract" });
          return finish(failure);
        }
        return {
          ok: true,
          name: typeof file.name === "string" ? file.name : null,
          mimeType,
          text,
        };
      } catch (error) {
        if (error instanceof BoundedStop) {
          reportFailure(state, {
            ...failureDetailsForStop(error.failure),
            stage: "extract",
          });
          return finish(error.failure);
        }
        if (state.controller.signal.aborted) {
          const failure = failureForStop(state);
          reportFailure(state, {
            ...failureDetailsForStop(failure),
            stage: "extract",
          });
          return finish(failure);
        }
        const failure = error instanceof PdfExtractionError
          ? pdfExtractionFailure(error.message)
          : pdfExtractionFailure();
        reportFailure(state, { failureClass: "pdf_extraction", stage: "extract" });
        return finish(failure);
      }
    }
    const path = mimeType.startsWith(DRIVE_EXPORTABLE_PREFIX)
      ? `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeExport(mimeType))}`
      : `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    const body = await requestDriveRead(
      path,
      token,
      state,
      input.fetchImpl ?? fetch,
      mimeType.startsWith(DRIVE_EXPORTABLE_PREFIX) ? "export" : "download",
    );
    if (typeof body !== "string") {
      if (body.message === unsupportedContentFailure().message) {
        reportFailure(state, { failureClass: "unsupported_content", stage: "body" });
      }
      return finish(body);
    }
    return {
      ok: true,
      name: typeof file.name === "string" ? file.name : null,
      mimeType,
      text: body,
    };
  } catch (error) {
    if (error instanceof BoundedStop) {
      reportFailure(state, failureDetailsForStop(error.failure));
      return error.failure;
    }
    if (controller.signal.aborted) {
      const failure = failureForStop(state);
      reportFailure(state, failureDetailsForStop(failure));
      return failure;
    }
    // This includes parser failures, malformed Response implementations, and
    // unexpected body/transport exceptions. Never return error.message.
    const failure = transportFailure();
    reportFailure(state, { failureClass: "transport" });
    return failure;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}