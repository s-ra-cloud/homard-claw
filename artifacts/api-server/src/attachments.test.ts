import { describe, expect, it, vi } from "vitest";
import { CreateTaskBody, DelegateFromTalkBody } from "@workspace/api-zod";

const { extractPdfText, PdfExtractionError } = vi.hoisted(() => {
  const extractPdfText = vi.fn();
  const messages: Record<string, string> = {
    scanned:
      "The PDF contains no extractable text; visual or image content cannot be read.",
    encrypted: "The PDF is encrypted and cannot be read without a password.",
    invalid_pdf: "The file is not a valid PDF.",
    page_limit: "The PDF exceeds the 100-page extraction limit.",
    timeout: "PDF text extraction timed out.",
  };
  class PdfExtractionError extends Error {
    constructor(readonly kind: string) {
      super(messages[kind] ?? "PDF text extraction could not be completed.");
    }
  }
  return { extractPdfText, PdfExtractionError };
});

vi.mock("./pdf/extract", () => ({
  extractPdfText,
  PdfExtractionError,
}));

const { extractDocxText, DocxExtractionError } = vi.hoisted(() => {
  const extractDocxText = vi.fn();
  class DocxExtractionError extends Error {
    constructor(readonly kind: string) {
      super("The file is not a valid DOCX document.");
    }
  }
  return { extractDocxText, DocxExtractionError };
});

vi.mock("./docx/extract", () => ({ extractDocxText, DocxExtractionError }));

import {
  AttachmentNormalizationError,
  attachmentErrorStatus,
  normalizeAttachments,
} from "./attachments";

const pdf = {
  name: "quarterly.pdf",
  mimeType: "application/pdf",
  encoding: "base64" as const,
  content: Buffer.from("%PDF-1.7").toString("base64"),
};
const docx = {
  name: "brief.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  encoding: "base64" as const,
  content: Buffer.from("PK\u0003\u0004DOCX").toString("base64"),
};

describe("normalizeAttachments", () => {
  it("persists extracted PDF text rather than the original PDF", async () => {
    extractPdfText.mockResolvedValueOnce("--- page 1 ---\nRevenue rose.");

    const normalized = await normalizeAttachments([pdf]);
    expect(normalized).toEqual([
      {
        name: "quarterly.pdf.txt",
        mimeType: "text/plain",
        encoding: "text",
        content:
          "--- SOURCE PDF FILENAME: quarterly.pdf ---\n--- page 1 ---\nRevenue rose.",
      },
    ]);
    // The final provider boundary runs this normalizer too. Durable PDF text
    // must not be mistaken for its original raw source on that second pass.
    await expect(normalizeAttachments(normalized)).resolves.toEqual(normalized);
    expect(extractPdfText).toHaveBeenCalledWith(
      Buffer.from("%PDF-1.7"),
      expect.objectContaining({ maxInputBytes: 25_000_000 }),
    );
  });

  it("accepts four documents at the 1.5M Unicode-scalar extraction boundary", async () => {
    extractPdfText.mockClear();
    const extracted = `--- Page 1 ---\n${"😀".repeat(1_499_980)}`;
    extractPdfText.mockResolvedValue(extracted);
    const attachments = Array.from({ length: 4 }, (_, index) => ({
      ...pdf,
      name: `document-${index}.pdf`,
    }));

    await expect(normalizeAttachments(attachments)).resolves.toHaveLength(4);
    expect(extractPdfText).toHaveBeenCalledTimes(4);
  });

  it("counts extracted document limits in Unicode scalars rather than UTF-16 units", async () => {
    extractPdfText.mockResolvedValue(`--- Page 1 ---\n${"😀".repeat(1_499_980)}`);
    await expect(normalizeAttachments([pdf])).resolves.toHaveLength(1);
  });

  it("persists extracted DOCX text as the provider-neutral durable attachment", async () => {
    extractDocxText.mockResolvedValueOnce(
      "--- DOCX document body (text only; drawings omitted) ---\n--- DOCX paragraph 1 ---\nRevenue rose.",
    );
    const normalized = await normalizeAttachments([docx]);
    expect(normalized).toEqual([{
      name: "brief.docx.txt",
      mimeType: "text/plain",
      encoding: "text",
      content: expect.stringContaining("--- SOURCE DOCX FILENAME: brief.docx ---"),
    }]);
    await expect(normalizeAttachments(normalized)).resolves.toEqual(normalized);
    expect(extractDocxText).toHaveBeenCalledWith(
      Buffer.from("PK\u0003\u0004DOCX"),
      expect.objectContaining({ maxInputBytes: 25_000_000 }),
    );
  });

  it("keeps a 160-character PDF source name across both canonical passes", async () => {
    const sourceName = `${"a".repeat(156)}.pdf`;
    extractPdfText.mockResolvedValueOnce("--- Page 1 ---\nReadable.");
    const normalized = await normalizeAttachments([{ ...pdf, name: sourceName }]);
    expect(normalized).toMatchObject([
      {
        name: `${"a".repeat(156)}.txt`,
        mimeType: "text/plain",
        content: `--- SOURCE PDF FILENAME: ${sourceName} ---\n--- Page 1 ---\nReadable.`,
      },
    ]);
    await expect(normalizeAttachments(normalized)).resolves.toEqual(normalized);
    expect(
      CreateTaskBody.safeParse({
        agentId: "agent-id",
        objective: "Read the attachment",
        attachments: normalized,
      }).success,
    ).toBe(true);
    expect(
      DelegateFromTalkBody.safeParse({
        targetAgentId: "agent-id",
        objective: "Read the attachment",
        attachments: normalized,
      }).success,
    ).toBe(true);
  });

  it("keeps existing non-PDF multi-file uploads available", async () => {
    const image = {
      name: "image.png",
      mimeType: "image/png",
      encoding: "base64" as const,
      content: Buffer.alloc(13_000_000, 7).toString("base64"),
    };
    await expect(normalizeAttachments([image, image])).resolves.toHaveLength(2);
  });

  it("accepts a 40 MB PDF for task ingestion and passes that bound to extraction", async () => {
    extractPdfText.mockResolvedValueOnce("--- Page 1 ---\nReadable.");
    const bytes = Buffer.alloc(40_000_000);
    bytes.write("%PDF-1.7");
    await expect(
      normalizeAttachments(
        [{ ...pdf, content: bytes.toString("base64") }],
        { maxPdfBytes: 40_000_000 },
      ),
    ).resolves.toHaveLength(1);
    expect(extractPdfText).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ maxInputBytes: 40_000_000 }),
    );
  });

  it("rejects PDFs over 40 MB while retaining the 25 MB non-PDF limit", async () => {
    const oversizedPdf = Buffer.alloc(40_000_001);
    oversizedPdf.write("%PDF-1.7");
    await expect(
      normalizeAttachments(
        [{ ...pdf, content: oversizedPdf.toString("base64") }],
        { maxPdfBytes: 40_000_000 },
      ),
    ).rejects.toMatchObject({
      kind: "too_large",
      userMessage: "The PDF is larger than 40 MB.",
    });

    await expect(
      normalizeAttachments([{
        name: "large.png",
        mimeType: "image/png",
        encoding: "base64",
        content: Buffer.alloc(25_000_001).toString("base64"),
      }]),
    ).rejects.toMatchObject({
      kind: "too_large",
      userMessage: "An attachment is larger than 25 MB.",
    });
  });

  it("applies the task PDF limit when only extension or signature identifies the PDF", async () => {
    extractPdfText.mockResolvedValue("--- Page 1 ---\nReadable.");
    const bytes = Buffer.alloc(25_000_001);
    bytes.write("%PDF-1.7");
    await expect(normalizeAttachments([{
      ...pdf,
      name: "report.pdf",
      mimeType: "application/octet-stream",
      content: bytes.toString("base64"),
    }], { maxPdfBytes: 40_000_000 })).resolves.toHaveLength(1);
    await expect(normalizeAttachments([{
      ...pdf,
      name: "upload.bin",
      mimeType: "image/png",
      content: bytes.toString("base64"),
    }], { maxPdfBytes: 40_000_000 })).resolves.toHaveLength(1);
  });

  it("rejects malformed base64 instead of silently decoding it", async () => {
    await expect(
      normalizeAttachments([{ ...pdf, content: "not / base64" }]),
    ).rejects.toMatchObject({
      kind: "invalid",
      userMessage: "An attachment contains invalid base64 file data.",
    });
  });

  it.each([
    ["scanned", "The PDF contains no extractable text; visual or image content cannot be read."],
    ["encrypted", "The PDF is encrypted and cannot be read without a password."],
    ["invalid_pdf", "The file is not a valid PDF."],
    ["page_limit", "The PDF exceeds the 100-page extraction limit."],
  ])("keeps the vetted %s PDF error clear and safe", async (kind, userMessage) => {
    extractPdfText.mockRejectedValueOnce(new PdfExtractionError(kind));
    await expect(normalizeAttachments([pdf])).rejects.toMatchObject({
      kind: "extraction_failed",
      userMessage,
    });
  });

  it("infers a PDF from generic base64 MIME metadata", async () => {
    extractPdfText.mockResolvedValueOnce("--- Page 1 ---\nReadable.");
    await expect(
      normalizeAttachments([{ ...pdf, mimeType: "application/octet-stream" }]),
    ).resolves.toMatchObject([
      { name: "quarterly.pdf.txt", mimeType: "text/plain", encoding: "text" },
    ]);
  });

  it("recognizes PDF magic bytes after leading junk in a generic upload", async () => {
    extractPdfText.mockResolvedValueOnce("--- Page 1 ---\nReadable.");
    await expect(
      normalizeAttachments([
        {
          ...pdf,
          name: "upload.bin",
          mimeType: "",
          content: Buffer.concat([
            Buffer.alloc(40, 0),
            Buffer.from("%PDF-1.7"),
          ]).toString("base64"),
        },
      ]),
    ).resolves.toEqual([
      {
        name: "upload.bin.txt",
        mimeType: "text/plain",
        encoding: "text",
        content:
          "--- SOURCE PDF FILENAME: upload.bin ---\n--- Page 1 ---\nReadable.",
      },
    ]);
  });

  it("does not trust a spoofed image MIME ahead of PDF bytes", async () => {
    extractPdfText.mockResolvedValueOnce("--- Page 1 ---\nReadable.");
    await expect(
      normalizeAttachments([{ ...pdf, name: "picture.png", mimeType: "image/png" }]),
    ).resolves.toMatchObject([
      { name: "picture.png.txt", mimeType: "text/plain", encoding: "text" },
    ]);
  });

  it("does not let text that looks like a raw PDF reach a provider", async () => {
    await expect(
      normalizeAttachments([
        {
          name: "mislabeled.txt",
          mimeType: "text/plain",
          encoding: "text",
          content: "%PDF-1.7",
        },
      ]),
    ).rejects.toMatchObject({
      kind: "invalid",
      userMessage: "A PDF attachment must be uploaded as base64 file data.",
    });
  });

  it("surfaces a busy PDF service as a retryable safe response", () => {
    expect(
      attachmentErrorStatus(
        new AttachmentNormalizationError(
          "unavailable",
          "PDF processing is temporarily unavailable. Please try again.",
        ),
      ),
    ).toBe(503);
  });

  it("honors a caller cancellation before PDF work begins", async () => {
    extractPdfText.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      normalizeAttachments([pdf], { signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: "cancelled",
      userMessage: "Attachment processing was cancelled.",
    });
    expect(extractPdfText).not.toHaveBeenCalled();
  });
});