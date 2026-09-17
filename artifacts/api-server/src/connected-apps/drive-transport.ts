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
import { createHmac, timingSafeEqual } from "node:crypto";
import { extractPdfText, parsePdfPages, PdfExtractionError } from "../pdf/extract";
import { extractDocxText, DocxExtractionError } from "../docx/extract";

export const DEFAULT_DRIVE_READ_TIMEOUT_MS = 30_000;
/** Non-PDF Drive reads retain the original bounded response allowance. */
export const MAX_DRIVE_READ_BODY_BYTES = 25_000_000;
/** PDFs match the task attachment limit used by local uploads. */
export const MAX_DRIVE_PDF_READ_BODY_BYTES = 40_000_000;
/** Maximum extracted document range exposed through Drive continuation. */
export const MAX_DRIVE_DOCUMENT_CHARS = 1_500_000;
// Scalar count; conservative enough for astral text plus action metadata.
export const DEFAULT_DRIVE_DOCUMENT_CHUNK_CHARS = 1_400;
/** Metadata and refusal payloads do not need the file download allowance. */
const MAX_DRIVE_CONTROL_BODY_BYTES = 2 * 1024 * 1024;

const DRIVE_API_BASE_URL = "https://www.googleapis.com";
const DRIVE_EXPORTABLE_PREFIX = "application/vnd.google-apps.";
const DRIVE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  | "size_mismatch"
  | "unsupported_content"
  | "pdf_extraction"
  | "docx_extraction"
  | "transport";

export type DriveReadFailureDetails = {
  stage: string;
  failureClass: DriveReadFailureClass;
  providerStatus?: number;
  declaredSizeBytes?: number;
  responseSizeBytes?: number;
  downloadedSizeBytes?: number;
  limitBytes?: number;
};

export type DriveReadByteDetails = {
  declaredSizeBytes: number | null;
  responseSizeBytes: number | null;
  downloadedSizeBytes: number | null;
  limitBytes: number;
};

export type DrivePdfCoverage = {
  startPage: number;
  endPage: number;
  totalPages: number;
  batchComplete: boolean;
  extractionTruncated: boolean;
  nextPage: number | null;
  revisionToken: string;
};

export type DriveReadTransportResult =
  | {
      ok: true;
      name: string | null;
      mimeType: string;
      text: string;
      /** Scalar offset of the served range within the extracted document. */
      textStart: number;
      /** Opaque cursor for the next bounded range, when content remains. */
      continuation?: string;
      pdfCoverage?: DrivePdfCoverage;
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
  /** Internal complete-summary traversal; direct pdfPages reads never set it. */
  clampPdfPageRangeEnd?: boolean;
  /** Signed token binding a summary traversal to the first batch's revision. */
  pdfRevisionToken?: string;
  /** Opaque cursor returned by a prior read; binds continuation to this file revision. */
  continuation?: string;
  /** Unicode-scalar offset and maximum range for the initial read. */
  textOffset?: number;
  textLimit?: number;
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
  /** Test seam for DOCX's isolated package parser. */
  extractDocx?: typeof extractDocxText;
  now?: () => number;
  onStage?: (stage: string) => void;
  onFailure?: (details: DriveReadFailureDetails) => void;
  onBytes?: (details: DriveReadByteDetails) => void;
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

function bodyTooLargeFailure(
  maxBytes = MAX_DRIVE_READ_BODY_BYTES,
  declaredSizeBytes: number | null = null,
): DriveReadTransportFailure {
  if (
    declaredSizeBytes !== null &&
    declaredSizeBytes <= maxBytes
  ) {
    return {
      ok: false,
      kind: "failed",
      message:
        `Google Drive reports this file as ${declaredSizeBytes} bytes, but its download exceeded the ${maxBytes / 1_000_000} MB read limit. Download it locally and attach it directly, or replace the Drive copy and retry.`,
    };
  }
  return {
    ok: false,
    kind: "failed",
    message: `Google Drive returned a file larger than the ${maxBytes / 1_000_000} MB read limit.`,
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
      "Google Drive could not read this file as text. PDFs and DOCX documents use separate text extraction; image and other unsupported binary files cannot be read.",
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

function docxExtractionFailure(message?: string): DriveReadTransportFailure {
  return {
    ok: false,
    kind: "failed",
    message: message ?? "Google Drive could not extract readable text from this DOCX document.",
  };
}

function isPdfDownload(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

function isDocxDownload(mimeType: string): boolean {
  return mimeType === DOCX_MIME_TYPE;
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
  maxBytes = MAX_DRIVE_READ_BODY_BYTES,
  declaredSizeBytes: number | null = null,
  onBytes?: (details: DriveReadByteDetails) => void,
): Promise<Uint8Array | DriveReadTransportFailure> {
  const contentLength = responseBodySize(response);
  const metadataSaysWithinLimit =
    declaredSizeBytes !== null && declaredSizeBytes <= maxBytes;
  // Drive metadata is the file's canonical stored size. When it says the file
  // fits, do not reject solely on a contradictory HTTP content-length: proxies
  // and content codings can make that header describe a different transfer
  // representation. Stream the body under the hard cap and trust bytes read.
  if (
    contentLength !== null &&
    contentLength > maxBytes &&
    !metadataSaysWithinLimit
  ) {
    state.controller.abort();
    discardResponseBody(response);
    if (reportBodyFailure) {
      reportFailure(state, {
        failureClass:
          declaredSizeBytes !== null && declaredSizeBytes <= maxBytes
            ? "size_mismatch"
            : "body_limit",
        stage: "body",
        ...(declaredSizeBytes === null ? {} : { declaredSizeBytes }),
        responseSizeBytes: contentLength,
        limitBytes: maxBytes,
      });
    }
    onBytes?.({
      declaredSizeBytes,
      responseSizeBytes: contentLength,
      downloadedSizeBytes: null,
      limitBytes: maxBytes,
    });
    return bodyTooLargeFailure(maxBytes, declaredSizeBytes);
  }

  if (!response.body) {
    const buffer = await runBounded(() => response.arrayBuffer(), state);
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maxBytes) {
      state.controller.abort();
      if (reportBodyFailure) {
        reportFailure(state, {
          failureClass:
            declaredSizeBytes !== null && declaredSizeBytes <= maxBytes
              ? "size_mismatch"
              : "body_limit",
          stage: "body",
          ...(declaredSizeBytes === null ? {} : { declaredSizeBytes }),
          ...(contentLength === null
            ? {}
            : { responseSizeBytes: contentLength }),
          downloadedSizeBytes: bytes.byteLength,
          limitBytes: maxBytes,
        });
      }
      onBytes?.({
        declaredSizeBytes,
        responseSizeBytes: contentLength,
        downloadedSizeBytes: bytes.byteLength,
        limitBytes: maxBytes,
      });
      return bodyTooLargeFailure(maxBytes, declaredSizeBytes);
    }
    onBytes?.({
      declaredSizeBytes,
      responseSizeBytes: contentLength,
      downloadedSizeBytes: bytes.byteLength,
      limitBytes: maxBytes,
    });
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
      if (total > maxBytes) {
        state.controller.abort();
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // The body is already over the cap; preserve that safe outcome.
        }
        if (reportBodyFailure) {
          reportFailure(state, {
            failureClass:
              declaredSizeBytes !== null && declaredSizeBytes <= maxBytes
                ? "size_mismatch"
                : "body_limit",
            stage: "body",
            ...(declaredSizeBytes === null ? {} : { declaredSizeBytes }),
            ...(contentLength === null
              ? {}
              : { responseSizeBytes: contentLength }),
            downloadedSizeBytes: total,
            limitBytes: maxBytes,
          });
        }
        onBytes?.({
          declaredSizeBytes,
          responseSizeBytes: contentLength,
          downloadedSizeBytes: total,
          limitBytes: maxBytes,
        });
        return bodyTooLargeFailure(maxBytes, declaredSizeBytes);
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
  onBytes?.({
    declaredSizeBytes,
    responseSizeBytes: contentLength,
    downloadedSizeBytes: bytes.byteLength,
    limitBytes: maxBytes,
  });
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
  maxBytes = MAX_DRIVE_CONTROL_BODY_BYTES,
): Promise<string | DriveReadTransportFailure> {
  const bytes = await boundedResponseBytes(response, state, reportBodyFailure, maxBytes);
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
  maxBytes: number,
  declaredSizeBytes: number | null,
  onBytes?: (details: DriveReadByteDetails) => void,
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
    const body = await boundedResponseBytes(
      response,
      state,
      true,
      maxBytes,
      declaredSizeBytes,
      onBytes,
    );
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
    const body = await boundedResponseText(response, state, true,
      stage === "metadata" ? MAX_DRIVE_CONTROL_BODY_BYTES : MAX_DRIVE_READ_BODY_BYTES);
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

type DriveContinuation = {
  v: 1;
  id: string;
  mimeType: string;
  modifiedTime: string | null;
  offset: number;
  pdfPages: string | null;
};

const DRIVE_CONTINUATION_CONTEXT = "homardclaw-google-drive-continuation-v1";
const DRIVE_PDF_REVISION_CONTEXT = "homardclaw-google-drive-pdf-summary-revision-v1";

function continuationSecret(): string | null {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret ? secret : null;
}

function encodeContinuation(value: DriveContinuation): string | null {
  const secret = continuationSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${DRIVE_CONTINUATION_CONTEXT}|${payload}`)
    .digest("hex");
  return `${payload}.${signature}`;
}

function decodeContinuation(value: unknown): DriveContinuation | null {
  if (typeof value !== "string" || value.length < 8 || value.length > 2114) return null;
  try {
    const separator = value.lastIndexOf(".");
    const payload = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    const secret = continuationSecret();
    if (!secret || separator < 8 || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[0-9a-f]{64}$/.test(signature)) return null;
    const expected = createHmac("sha256", secret)
      .update(`${DRIVE_CONTINUATION_CONTEXT}|${payload}`)
      .digest("hex");
    const expectedBytes = Buffer.from(expected, "utf8");
    const signatureBytes = Buffer.from(signature, "utf8");
    if (expectedBytes.length !== signatureBytes.length ||
      !timingSafeEqual(expectedBytes, signatureBytes)) return null;
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<DriveContinuation>;
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !parsed.id ||
      typeof parsed.mimeType !== "string" || typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
      (typeof parsed.modifiedTime !== "string" && parsed.modifiedTime !== null) ||
      (typeof parsed.pdfPages !== "string" && parsed.pdfPages !== null)) return null;
    return parsed as DriveContinuation;
  } catch {
    return null;
  }
}

type DrivePdfRevision = {
  v: 1;
  workspaceId: string;
  id: string;
  modifiedTime: string | null;
};

function encodePdfRevision(value: DrivePdfRevision): string | null {
  const secret = continuationSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${DRIVE_PDF_REVISION_CONTEXT}|${payload}`)
    .digest("hex");
  return `${payload}.${signature}`;
}

function decodePdfRevision(value: unknown): DrivePdfRevision | null {
  if (typeof value !== "string" || value.length < 8 || value.length > 2114) return null;
  try {
    const separator = value.lastIndexOf(".");
    const payload = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    const secret = continuationSecret();
    if (!secret || separator < 8 || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[0-9a-f]{64}$/.test(signature)) return null;
    const expected = createHmac("sha256", secret)
      .update(`${DRIVE_PDF_REVISION_CONTEXT}|${payload}`)
      .digest("hex");
    const expectedBytes = Buffer.from(expected);
    const signatureBytes = Buffer.from(signature);
    if (expectedBytes.length !== signatureBytes.length ||
      !timingSafeEqual(expectedBytes, signatureBytes)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<DrivePdfRevision>;
    if (parsed.v !== 1 || typeof parsed.workspaceId !== "string" ||
      typeof parsed.id !== "string" ||
      (typeof parsed.modifiedTime !== "string" && parsed.modifiedTime !== null)) return null;
    return parsed as DrivePdfRevision;
  } catch {
    return null;
  }
}

function documentRange(
  text: string,
  offset: number,
  requestedLimit: number | undefined,
): { text: string; nextOffset: number | null; valid: boolean; start: number } {
  const limit = requestedLimit === undefined
    ? DEFAULT_DRIVE_DOCUMENT_CHUNK_CHARS
    : Math.min(requestedLimit, DEFAULT_DRIVE_DOCUMENT_CHUNK_CHARS);
  let scalar = 0;
  let start = -1;
  let end = -1;
  for (let index = 0; index < text.length;) {
    if (scalar === offset) start = index;
    if (start >= 0 && scalar === offset + limit) {
      end = index;
      break;
    }
    const codePoint = text.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    scalar += 1;
  }
  if (start < 0 && scalar === offset) start = text.length;
  if (start < 0) return { text: "", nextOffset: null, valid: false, start: offset };
  if (end < 0) end = text.length;
  const displayedScalars = Math.min(limit, scalar - offset);
  const nextOffset = end < text.length ? offset + displayedScalars : null;
  return {
    text: text.slice(start, end),
    nextOffset,
    valid: true,
    start: offset,
  };
}

function metadataRevision(
  raw: string,
): { name: string | null; mimeType: string; modifiedTime: string | null } | null {
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      mimeType?: unknown;
      modifiedTime?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || typeof parsed.mimeType !== "string") {
      return null;
    }
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      mimeType: parsed.mimeType.toLowerCase().split(";")[0].trim(),
      modifiedTime: typeof parsed.modifiedTime === "string" ? parsed.modifiedTime : null,
    };
  } catch {
    return null;
  }
}

/**
 * Read one Drive file through metadata + export/download, under one total
 * deadline. All failures are returned as safe outcomes; this function never
 * throws a provider/body/parser error to action finalization.
 */
export async function readDriveFileTransport(
  input: DriveReadInput,
): Promise<DriveReadTransportResult> {
  const cursor = decodeContinuation(input.continuation);
  const requestedPdfRevision = decodePdfRevision(input.pdfRevisionToken);
  if (input.pdfRevisionToken !== undefined && !requestedPdfRevision) {
    return {
      ok: false,
      kind: "failed",
      message: "The PDF summary revision token is invalid or stale; restart the summary from page 1.",
    };
  }
  if (cursor && input.pdfPages !== undefined &&
    cursor.pdfPages !== input.pdfPages) {
    return {
      ok: false,
      kind: "failed",
      message: "The Google Drive continuation is invalid or stale; start a new read.",
    };
  }
  const effectivePdfPages = input.pdfPages ?? cursor?.pdfPages ?? undefined;
  try {
    parsePdfPages(effectivePdfPages);
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
      `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType,modifiedTime,size")}&supportsAllDrives=true`,
      token,
      state,
      input.fetchImpl ?? fetch,
      "metadata",
    );
    if (typeof metadata !== "string") return finish(metadata);

    let file: {
      id?: unknown;
      name?: unknown;
      mimeType?: unknown;
      modifiedTime?: unknown;
      size?: unknown;
    };
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
    const fileName = typeof file.name === "string" ? file.name : null;
    const modifiedTime = typeof file.modifiedTime === "string" ? file.modifiedTime : null;
    if (input.clampPdfPageRangeEnd && modifiedTime === null) {
      return finish({
        ok: false,
        kind: "failed",
        message: "Google Drive did not provide a stable PDF revision, so complete summary traversal was not started.",
      });
    }
    if (requestedPdfRevision &&
      (requestedPdfRevision.workspaceId !== input.workspaceId ||
        requestedPdfRevision.id !== input.fileId ||
        requestedPdfRevision.modifiedTime !== modifiedTime)) {
      return finish({
        ok: false,
        kind: "failed",
        message: "The Google Drive PDF changed between summary batches; restart the summary from page 1.",
      });
    }
    const declaredSizeBytes =
      typeof file.size === "string" && /^\d+$/.test(file.size)
        ? Number(file.size)
        : null;
    const safeDeclaredSizeBytes =
      declaredSizeBytes !== null &&
      Number.isSafeInteger(declaredSizeBytes) &&
      declaredSizeBytes >= 0
        ? declaredSizeBytes
        : null;
    if (!mimeType || (typeof file.name === "string" && file.name.includes("\0"))) {
      reportFailure(state, { failureClass: "metadata", stage: "metadata" });
      return metadataFailure();
    }
    if (
      !mimeType.startsWith(DRIVE_EXPORTABLE_PREFIX) &&
      !isTextDownload(mimeType) &&
      !isPdfDownload(mimeType) &&
      !isDocxDownload(mimeType)
    ) {
      reportFailure(state, { failureClass: "unsupported_content", stage: "metadata" });
      return unsupportedContentFailure();
    }
    if (effectivePdfPages !== undefined && !isPdfDownload(mimeType)) {
      return finish(pdfExtractionFailure("pdfPages is only supported for PDF files; no content was read."));
    }
    if (input.continuation !== undefined && (!cursor ||
      cursor.id !== input.fileId ||
      cursor.mimeType !== mimeType ||
      cursor.modifiedTime !== modifiedTime ||
      cursor.pdfPages !== (effectivePdfPages ?? null))) {
      return finish({
        ok: false,
        kind: "failed",
        message: "The Google Drive continuation is invalid or stale; start a new read.",
      });
    }
    const offset = cursor?.offset ?? input.textOffset ?? 0;
    const requestedLimit = input.textLimit;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DRIVE_DOCUMENT_CHARS ||
      (requestedLimit !== undefined &&
        (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_DRIVE_DOCUMENT_CHARS))) {
      return finish({
        ok: false,
        kind: "failed",
        message: "The Google Drive document range is invalid; use a bounded non-negative offset and chunk size.",
      });
    }
    if (cursor && input.textOffset !== undefined) {
      return finish({
        ok: false,
        kind: "failed",
        message: "The Google Drive continuation cannot be combined with a new offset.",
      });
    }
    if ((cursor || input.textOffset !== undefined || input.textLimit !== undefined) &&
      !isPdfDownload(mimeType) && !isDocxDownload(mimeType)) {
      return finish({
        ok: false,
        kind: "failed",
        message: "Document ranges and continuations are only supported for PDF and DOCX files.",
      });
    }
    if (isPdfDownload(mimeType) || isDocxDownload(mimeType)) {
      const maxDocumentBytes = isPdfDownload(mimeType)
        ? MAX_DRIVE_PDF_READ_BODY_BYTES
        : MAX_DRIVE_READ_BODY_BYTES;
      const pdf = await requestDrivePdf(
        `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        token,
        state,
        input.fetchImpl ?? fetch,
        maxDocumentBytes,
        safeDeclaredSizeBytes,
        input.onBytes,
      );
      if (!(pdf instanceof Uint8Array)) return finish(pdf);

      safeStage(state, "extract");
      try {
        const text = await runBounded(
          () => isPdfDownload(mimeType)
            ? (input.extractPdf ?? extractPdfText)(pdf, {
              signal: state.controller.signal,
              maxInputBytes: maxDocumentBytes,
              deadlineAt,
              pdfPages: effectivePdfPages,
              clampPageRangeEnd: input.clampPdfPageRangeEnd === true,
            })
            : (input.extractDocx ?? extractDocxText)(pdf, {
              signal: state.controller.signal,
              maxInputBytes: maxDocumentBytes,
              deadlineAt,
            }),
          state,
        );
        if (typeof text !== "string" || text.includes("\0")) {
          const failure = isPdfDownload(mimeType) ? pdfExtractionFailure() : docxExtractionFailure();
          reportFailure(state, { failureClass: isPdfDownload(mimeType) ? "pdf_extraction" : "docx_extraction", stage: "extract" });
          return finish(failure);
        }
        const finalMetadata = modifiedTime === null ? null : await requestDriveRead(
          `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType,modifiedTime,size")}&supportsAllDrives=true`,
          token,
          state,
          input.fetchImpl ?? fetch,
          "metadata",
        );
        const finalRevision = typeof finalMetadata === "string"
          ? metadataRevision(finalMetadata)
          : null;
        if (modifiedTime !== null && (!finalRevision || finalRevision.name !== fileName ||
          finalRevision.mimeType !== mimeType ||
          finalRevision.modifiedTime !== modifiedTime)) {
          return finish({
            ok: false,
            kind: "failed",
            message: "The Google Drive file changed while it was being read; retry the read.",
          });
        }
        const range = documentRange(text, offset, requestedLimit);
        if (!range.valid) {
          return finish({
            ok: false,
            kind: "failed",
            message: "The Google Drive document range is outside the extracted document.",
          });
        }
        const nextOffset = range.nextOffset;
        const continuation = nextOffset === null ? null : encodeContinuation({
          v: 1,
          id: input.fileId,
          mimeType,
          modifiedTime,
          offset: nextOffset,
          pdfPages: effectivePdfPages ?? null,
        });
        if (nextOffset !== null && continuation === null) {
          return finish({
            ok: false,
            kind: "failed",
            message: "Google Drive continuation is unavailable on this server.",
          });
        }
        let pdfCoverage: DrivePdfCoverage | undefined;
        if (input.clampPdfPageRangeEnd && effectivePdfPages) {
          const match = /^\[PDF selection: pages (\d+)-(\d+) of (\d+)\./.exec(text);
          if (!match) {
            return finish(pdfExtractionFailure());
          }
          const startPage = Number(match[1]);
          const endPage = Number(match[2]);
          const totalPages = Number(match[3]);
          const revisionToken = encodePdfRevision({
            v: 1,
            workspaceId: input.workspaceId!,
            id: input.fileId,
            modifiedTime,
          });
          if (!revisionToken) {
            return finish({
              ok: false,
              kind: "failed",
              message: "Google Drive PDF summary traversal is unavailable on this server.",
            });
          }
          pdfCoverage = {
            startPage,
            endPage,
            totalPages,
            batchComplete:
              nextOffset === null &&
              !text.includes("--- Text extraction truncated at the "),
            extractionTruncated:
              text.includes("--- Text extraction truncated at the "),
            nextPage:
              nextOffset === null &&
              !text.includes("--- Text extraction truncated at the ") &&
              endPage < totalPages
                ? endPage + 1
                : null,
            revisionToken,
          };
        }
        return {
          ok: true,
          name: fileName,
          mimeType,
          text: range.text,
          textStart: range.start,
          ...(continuation === null ? {} : { continuation }),
          ...(pdfCoverage ? { pdfCoverage } : {}),
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
          : error instanceof DocxExtractionError
            ? docxExtractionFailure(error.message)
            : isPdfDownload(mimeType) ? pdfExtractionFailure() : docxExtractionFailure();
        reportFailure(state, { failureClass: isPdfDownload(mimeType) ? "pdf_extraction" : "docx_extraction", stage: "extract" });
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
    const finalMetadata = modifiedTime === null ? null : await requestDriveRead(
      `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType,modifiedTime")}&supportsAllDrives=true`,
      token,
      state,
      input.fetchImpl ?? fetch,
      "metadata",
    );
    const finalRevision = typeof finalMetadata === "string"
      ? metadataRevision(finalMetadata)
      : null;
    if (modifiedTime !== null && (!finalRevision || finalRevision.name !== fileName ||
      finalRevision.mimeType !== mimeType ||
      finalRevision.modifiedTime !== modifiedTime)) {
      return finish({
        ok: false,
        kind: "failed",
        message: "The Google Drive file changed while it was being read; retry the read.",
      });
    }
    // Continuation is deliberately limited to locally extracted PDF/DOCX
    // documents. Existing text/CSV reads retain their historical full-body
    // behavior (the action-result formatter still bounds what the model sees).
    return {
      ok: true,
      name: fileName,
      mimeType,
      text: body,
      textStart: 0,
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