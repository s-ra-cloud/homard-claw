import type { InputAttachment } from "@workspace/api-client-react";

export const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.js,.ts,.py,.sql,.toml,text/*";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
]);
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/x-python",
  sql: "application/sql",
  toml: "application/toml",
  ts: "text/typescript",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
};
export const MAX_FILE_BYTES = 25_000_000;
export const MAX_ATTACHMENTS = 4;

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > -1 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : null;
}

function isSupportedMimeType(mimeType: string): boolean {
  return (
    IMAGE_TYPES.has(mimeType) ||
    mimeType === "application/pdf" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType.startsWith("text/") ||
    TEXT_APPLICATION_TYPES.has(mimeType)
  );
}

/**
 * Browser uploads frequently leave File.type blank (notably Safari and files
 * dragged from desktop apps). Infer only our explicit accepted extensions;
 * never turn arbitrary binary into text/plain just because the browser had no
 * MIME hint.
 */
export function inferAttachmentMimeType(file: Pick<File, "name" | "type">): string {
  const browserType = file.type.split(";", 1)[0].trim().toLowerCase();
  if (isSupportedMimeType(browserType)) return browserType;
  const inferred = MIME_BY_EXTENSION[extensionOf(file.name) ?? ""];
  if (inferred) return inferred;
  // Preserve legacy behavior for desktop/browser uploads without useful MIME
  // metadata: readAttachment treats this as text and still rejects empty/NUL
  // content. Explicit extensions above continue to take precedence.
  return "text/plain";
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file."));
    reader.onload = () =>
      resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export async function readAttachment(file: File): Promise<InputAttachment> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error(`${file.name} is larger than 25 MB.`);
  const mimeType = inferAttachmentMimeType(file);
  if (IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return {
      name: file.name,
      mimeType,
      encoding: "base64",
      content: await base64(file),
    };
  }
  const text = await file.text();
  if (!text.trim() || text.includes("\u0000")) {
    throw new Error(
      `${file.name} is empty or is not a supported text document.`,
    );
  }
  return { name: file.name, mimeType, encoding: "text", content: text };
}

export function attachmentLabel(attachment: InputAttachment): string {
  return attachment.mimeType.startsWith("image/")
    ? `Image · ${attachment.name}`
    : attachment.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ? `DOCX · ${attachment.name}`
    : attachment.name;
}

export function attachmentsForTalkProposal(
  hasProposal: boolean,
  turnAttachments: readonly InputAttachment[],
): InputAttachment[] {
  return hasProposal ? [...turnAttachments] : [];
}

/**
 * Retained canonical documents and files attached to the proposing turn both
 * become task files. Never silently trim either set: the task API accepts four
 * attachments, so callers can show clear guidance before a proposal is shown.
 */
export function combineTalkProposalAttachments(
  retained: readonly InputAttachment[],
  current: readonly InputAttachment[],
): { attachments: InputAttachment[]; exceedsLimit: boolean } {
  const attachments = [...retained, ...current];
  return { attachments, exceedsLimit: attachments.length > MAX_ATTACHMENTS };
}

/** Build the conditional cleanup body shared by every Talk dismissal path. */
export function talkDocumentContextCleanupInput(
  version: string | null,
): { version: string } | null {
  return version ? { version } : null;
}

export function withTalkAttachments<T extends object>(
  input: T,
  attachments: readonly InputAttachment[],
): T & { attachments?: InputAttachment[] } {
  return attachments.length > 0
    ? { ...input, attachments: [...attachments] }
    : input;
}
