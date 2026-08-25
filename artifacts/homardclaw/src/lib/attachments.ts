import type { InputAttachment } from "@workspace/api-client-react";

export const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.js,.ts,.py,.sql,.toml,text/*";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_FILE_BYTES = 2_000_000;
export const MAX_ATTACHMENTS = 4;

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.onload = () => resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export async function readAttachment(file: File): Promise<InputAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 2 MB.`);
  const mimeType = file.type || "text/plain";
  if (IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf") {
    return { name: file.name, mimeType, encoding: "base64", content: await base64(file) };
  }
  const text = await file.text();
  if (!text.trim() || text.includes("\u0000")) {
    throw new Error(`${file.name} is empty or is not a supported text document.`);
  }
  return { name: file.name, mimeType, encoding: "text", content: text };
}

export function attachmentLabel(attachment: InputAttachment): string {
  return attachment.mimeType.startsWith("image/") ? `Image · ${attachment.name}` : attachment.name;
}
