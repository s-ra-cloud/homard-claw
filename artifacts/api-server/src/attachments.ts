import type { TaskFile } from "@workspace/db";
import { extractPdfText, PdfExtractionError } from "./pdf/extract";
import { extractDocxText, DocxExtractionError } from "./docx/extract";

/**
 * Attachment limits are enforced again after decoding. Request validators can
 * bound JSON string length, but they cannot know a base64 payload's decoded
 * size. Existing non-document file allowances are retained; PDF and DOCX text
 * are bounded by isolated extraction services and the aggregate below.
 */
export const MAX_ATTACHMENT_BYTES = 25_000_000;
export const MAX_TASK_PDF_ATTACHMENT_BYTES = 40_000_000;
export const MAX_ATTACHMENTS = 4;
const MAX_SOURCE_FILENAME_CHARS = 160;
/** Four PDF/DOCX extractions are each service-bounded to 1.5M Unicode scalars. */
export const MAX_NORMALIZED_PDF_TEXT_CHARS = 6_000_000;
/**
 * A PDF/DOCX extractor result is capped at 1,500,000 Unicode scalars. Its durable
 * source-filename envelope is at most 190 more, so a value beyond this cannot
 * be canonical extracted PDF text. Keep this small independent boundary for
 * provider adapters which decide whether it is safe to inline the text.
 */
export const MAX_CANONICAL_PDF_TEXT_SCALARS = 1_500_256;
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const APPLICATION_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
]);

export type AttachmentNormalizationErrorKind =
  | "invalid"
  | "too_large"
  | "extraction_failed"
  | "unavailable"
  | "cancelled";

/**
 * Deliberately fixed, owner-facing errors. Document parser errors can contain
 * file paths or document content and must never leave this layer.
 */
export class AttachmentNormalizationError extends Error {
  constructor(
    readonly kind: AttachmentNormalizationErrorKind,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "AttachmentNormalizationError";
  }
}

export function attachmentErrorStatus(
  error: AttachmentNormalizationError,
): number {
  if (error.kind === "cancelled") return 499;
  if (error.kind === "unavailable") return 503;
  return 400;
}

export type AttachmentInput = Pick<
  TaskFile,
  "name" | "mimeType" | "encoding" | "content"
>;
export type NormalizedAttachment = {
  name: string;
  mimeType: string;
  encoding: "text" | "base64";
  content: string;
};

function normalizedMimeType(mimeType: string | undefined): string {
  return (mimeType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || APPLICATION_TEXT_MIME_TYPES.has(mimeType);
}

function isGenericBinaryMimeType(mimeType: string): boolean {
  return (
    mimeType === "" ||
    mimeType === "application/octet-stream" ||
    mimeType === "application/binary" ||
    mimeType === "binary/octet-stream"
  );
}

function isPdfFilename(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function isDocxFilename(name: string): boolean {
  return /\.docx$/i.test(name);
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  // The complete five-byte marker must fall inside the first 1,024 bytes.
  const lastOffset = Math.min(bytes.length - 5, 1_024 - 5);
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if (
      bytes[offset] === 0x25 &&
      bytes[offset + 1] === 0x50 &&
      bytes[offset + 2] === 0x44 &&
      bytes[offset + 3] === 0x46 &&
      bytes[offset + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function hasPdfTextSignature(text: string): boolean {
  const offset = text.indexOf("%PDF-");
  return offset >= 0 && offset <= 1_024 - 5;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04;
}

function normalizedPdfTextName(name: string): string {
  // Keep the canonical attachment inside every generated API contract's
  // 160-character filename limit. A max-length `*.pdf` source loses only its
  // redundant extension before gaining `.txt`; its exact source identity is
  // included in the durable text below.
  return name.length + ".txt".length <= MAX_SOURCE_FILENAME_CHARS
    ? `${name}.txt`
    : `${name.slice(0, -".pdf".length)}.txt`;
}

function normalizedDocxTextName(name: string): string {
  return name.length + ".txt".length <= MAX_SOURCE_FILENAME_CHARS
    ? `${name}.txt`
    : `${name.slice(0, -".docx".length)}.txt`;
}

function normalizedPdfTextContent(name: string, text: string): string {
  // The envelope is present even when the durable .txt name still retains a
  // .pdf suffix. This lets downstream consumers distinguish generic-name
  // sources such as upload.bin.txt from ordinary user-authored text without
  // retaining the raw PDF.
  return `--- SOURCE PDF FILENAME: ${name} ---\n${text}`;
}

function normalizedDocxTextContent(name: string, text: string): string {
  return `--- SOURCE DOCX FILENAME: ${name} ---\n${text}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AttachmentNormalizationError(
    "cancelled",
    "Attachment processing was cancelled.",
  );
}

function decodedBase64(content: string): Uint8Array {
  // Buffer.from accepts malformed base64 by silently discarding invalid
  // characters, which is unsuitable for a durable input boundary.
  if (
    content.length === 0 ||
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
  ) {
    throw new AttachmentNormalizationError(
      "invalid",
      "An attachment contains invalid base64 file data.",
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0) {
    throw new AttachmentNormalizationError(
      "invalid",
      "An attachment is empty.",
    );
  }
  // Canonical round-trip catches bad padding that Node otherwise accepts.
  if (bytes.toString("base64") !== content) {
    throw new AttachmentNormalizationError(
      "invalid",
      "An attachment contains invalid base64 file data.",
    );
  }
  return bytes;
}

function safeName(name: string | undefined): string {
  const normalized = (name ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!normalized || normalized.length > MAX_SOURCE_FILENAME_CHARS) {
    throw new AttachmentNormalizationError(
      "invalid",
      "An attachment needs a valid file name.",
    );
  }
  return normalized;
}

export type NormalizeAttachmentsOptions = {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Task ingestion may opt in; all other callers retain the 25 MB boundary. */
  maxPdfBytes?: number;
};

/**
 * Convert every accepted document to the durable form used by every provider.
 *
 * PDFs and DOCX files are extracted exactly once at ingress and saved as
 * bounded plain text; retries, action rounds, history replay, and Codex
 * materialization therefore never retain or repeatedly parse a raw document.
 * There is intentionally no
 * process-wide cache: documents are tenant-owned inputs and a cache would
 * create a cross-workspace disclosure boundary.
 */
export async function normalizeAttachments(
  input: readonly AttachmentInput[] | undefined,
  options: NormalizeAttachmentsOptions = {},
): Promise<NormalizedAttachment[]> {
  assertNotAborted(options.signal);
  if (!input?.length) return [];
  if (input.length > MAX_ATTACHMENTS) {
    throw new AttachmentNormalizationError(
      "too_large",
      `You can attach up to ${MAX_ATTACHMENTS} files.`,
    );
  }

  let documentTextChars = 0;
  const normalized: NormalizedAttachment[] = [];
  for (const attachment of input) {
    assertNotAborted(options.signal);
    const name = safeName(attachment.name);
    const mimeType = normalizedMimeType(attachment.mimeType);
    const encoding = attachment.encoding;
    if (encoding !== "text" && encoding !== "base64") {
      throw new AttachmentNormalizationError(
        "invalid",
        "An attachment has an unsupported encoding.",
      );
    }

    if (
      encoding === "text" &&
      (mimeType === "application/pdf" ||
        isPdfFilename(name) ||
        hasPdfTextSignature(attachment.content))
    ) {
      throw new AttachmentNormalizationError(
        "invalid",
        "A PDF attachment must be uploaded as base64 file data.",
      );
    }
    if (
      encoding === "text" &&
      (mimeType === DOCX_MIME_TYPE || isDocxFilename(name))
    ) {
      throw new AttachmentNormalizationError(
        "invalid",
        "A DOCX attachment must be uploaded as base64 file data.",
      );
    }

    // Desktop uploads can lose their MIME metadata. Inspect base64 bytes before
    // trusting a claimed image MIME: PDFs often arrive as image/png from
    // clipboard/legacy upload paths. A .pdf source name also routes through
    // extraction conservatively, even when its MIME is spoofed.
    if (
      encoding === "base64" &&
      mimeType !== "application/pdf" &&
      mimeType !== DOCX_MIME_TYPE &&
      !IMAGE_MIME_TYPES.has(mimeType) &&
      !isGenericBinaryMimeType(mimeType)
    ) {
      throw new AttachmentNormalizationError(
        "invalid",
        "An attachment is not a supported image, PDF, DOCX, or text document.",
      );
    }
    const base64Bytes =
      encoding === "base64" ? decodedBase64(attachment.content) : undefined;
    const isPdf =
      encoding === "base64" &&
      (mimeType === "application/pdf" ||
        isPdfFilename(name) ||
        hasPdfSignature(base64Bytes!));
    const isDocx =
      encoding === "base64" &&
      !isPdf &&
      (mimeType === DOCX_MIME_TYPE ||
        isDocxFilename(name) ||
        hasZipSignature(base64Bytes!));
    if (isPdf) {
      if (!base64Bytes) {
        throw new AttachmentNormalizationError(
          "invalid",
          "A PDF attachment must be uploaded as base64 file data.",
        );
      }
      const bytes = base64Bytes;
      const maxPdfBytes = Math.min(
        MAX_TASK_PDF_ATTACHMENT_BYTES,
        options.maxPdfBytes ?? MAX_ATTACHMENT_BYTES,
      );
      if (bytes.byteLength > maxPdfBytes) {
        throw new AttachmentNormalizationError(
          "too_large",
          `The PDF is larger than ${maxPdfBytes / 1_000_000} MB.`,
        );
      }
      let text: string;
      try {
        text = await extractPdfText(bytes, {
          signal: options.signal,
          maxInputBytes: maxPdfBytes,
          deadlineAt: options.deadlineAt,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new AttachmentNormalizationError(
            "cancelled",
            "Attachment processing was cancelled.",
          );
        }
        if (error instanceof PdfExtractionError) {
          if (error.kind === "cancelled") {
            throw new AttachmentNormalizationError(
              "cancelled",
              error.message,
            );
          }
          if (
            error.kind === "timeout" ||
            error.kind === "queue_full" ||
            error.kind === "resource_limit"
          ) {
            throw new AttachmentNormalizationError(
              "unavailable",
              error.message,
            );
          }
          throw new AttachmentNormalizationError(
            "extraction_failed",
            error.message,
          );
        }
        throw new AttachmentNormalizationError(
          "extraction_failed",
          "This PDF could not be read. Try a different PDF or attach its text instead.",
        );
      }
      if (!text.trim()) {
        throw new AttachmentNormalizationError(
          "extraction_failed",
          "This PDF has no readable text. Try a text-based PDF or attach its text instead.",
        );
      }
      documentTextChars += Array.from(text).length;
      normalized.push({
        // The .txt suffix keeps the second provider-boundary normalization
        // from mistaking durable extracted text for a raw PDF. Every source,
        // including generic upload.bin names, carries its explicit original
        // filename envelope in the durable extracted text.
        name: normalizedPdfTextName(name),
        mimeType: "text/plain",
        encoding: "text",
        content: normalizedPdfTextContent(name, text),
      });
      continue;
    }
    if (isDocx) {
      const bytes = base64Bytes!;
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentNormalizationError(
          "too_large",
          "An attachment is larger than 25 MB.",
        );
      }
      let text: string;
      try {
        text = await extractDocxText(bytes, {
          signal: options.signal,
          maxInputBytes: MAX_ATTACHMENT_BYTES,
          deadlineAt: options.deadlineAt,
        });
      } catch (error) {
        if (
          options.signal?.aborted ||
          (error instanceof DocxExtractionError && error.kind === "cancelled")
        ) {
          throw new AttachmentNormalizationError(
            "cancelled",
            "Attachment processing was cancelled.",
          );
        }
        if (error instanceof DocxExtractionError) {
          if (
            error.kind === "timeout" ||
            error.kind === "queue_full" ||
            error.kind === "resource_limit"
          ) {
            throw new AttachmentNormalizationError("unavailable", error.message);
          }
          throw new AttachmentNormalizationError("extraction_failed", error.message);
        }
        throw new AttachmentNormalizationError(
          "extraction_failed",
          "This DOCX could not be read. Try a different DOCX or attach its text instead.",
        );
      }
      if (!text.trim()) {
        throw new AttachmentNormalizationError(
          "extraction_failed",
          "This DOCX has no readable text. Try a document with text or attach its text instead.",
        );
      }
      documentTextChars += Array.from(text).length;
      normalized.push({
        name: normalizedDocxTextName(name),
        mimeType: "text/plain",
        encoding: "text",
        content: normalizedDocxTextContent(name, text),
      });
      continue;
    }

    if (IMAGE_MIME_TYPES.has(mimeType)) {
      if (encoding !== "base64") {
        throw new AttachmentNormalizationError(
          "invalid",
          "An image attachment must be uploaded as base64 file data.",
        );
      }
      const bytes = base64Bytes!;
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentNormalizationError(
          "too_large",
          "An attachment is larger than 25 MB.",
        );
      }
      normalized.push({ name, mimeType, encoding, content: attachment.content });
      continue;
    }

    if (!isTextMimeType(mimeType) || encoding !== "text") {
      throw new AttachmentNormalizationError(
        "invalid",
        "An attachment is not a supported image, PDF, DOCX, or text document.",
      );
    }
    if (!attachment.content.trim() || attachment.content.includes("\u0000")) {
      throw new AttachmentNormalizationError(
        "invalid",
        "An attachment is empty or is not a supported text document.",
      );
    }
    const bytes = Buffer.byteLength(attachment.content, "utf8");
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentNormalizationError(
        "too_large",
        "An attachment is larger than 25 MB.",
      );
    }
    normalized.push({ name, mimeType, encoding, content: attachment.content });
  }

  if (documentTextChars > MAX_NORMALIZED_PDF_TEXT_CHARS) {
    throw new AttachmentNormalizationError(
      "too_large",
      "The extracted text from attached documents is too large. Attach fewer documents or shorter documents.",
    );
  }
  return normalized;
}