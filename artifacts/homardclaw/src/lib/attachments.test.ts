import { describe, expect, it, vi } from "vitest";
import {
  attachmentLabel,
  attachmentsForTalkProposal,
  combineTalkProposalAttachments,
  inferAttachmentMimeType,
  readAttachment,
  talkDocumentContextCleanupInput,
  withTalkAttachments,
} from "./attachments";

const textAttachment = {
  name: "brief.txt",
  mimeType: "text/plain",
  encoding: "text" as const,
  content: "Keep this exact content.",
};

class TestFileReader {
  error: Error | null = null;
  result: string | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;

  readAsDataURL(): void {
    this.result = "data:application/octet-stream;base64,AA==";
    this.onload?.();
  }
}

vi.stubGlobal("FileReader", TestFileReader);

describe("readAttachment", () => {
  it("accepts a 40 MB PDF only for task uploads", async () => {
    const pdf = new File([new Uint8Array(40_000_000)], "report.pdf", {
      type: "application/pdf",
    });
    await expect(
      readAttachment(pdf, { taskUpload: true }),
    ).resolves.toMatchObject({
      encoding: "base64",
      mimeType: "application/pdf",
    });
    await expect(readAttachment(pdf)).rejects.toThrow("larger than 25 MB");
  });

  it("rejects a PDF over 40 MB and keeps non-PDF task files at 25 MB", async () => {
    await expect(
      readAttachment(
        new File([new Uint8Array(40_000_001)], "report.pdf", {
          type: "image/png",
        }),
        { taskUpload: true },
      ),
    ).rejects.toThrow("40 MB PDF limit");
    await expect(
      readAttachment(
        new File([new Uint8Array(25_000_001)], "image.png", {
          type: "image/png",
        }),
        { taskUpload: true },
      ),
    ).rejects.toThrow("larger than 25 MB");
  });

  it("infers supported extensions when browser MIME metadata is missing", () => {
    expect(inferAttachmentMimeType({ name: "report.pdf", type: "" })).toBe(
      "application/pdf",
    );
    expect(inferAttachmentMimeType({ name: "brief.docx", type: "" })).toContain(
      "wordprocessingml",
    );
    expect(
      inferAttachmentMimeType({
        name: "legacy.notes",
        type: "application/x-legacy-note",
      }),
    ).toBe("text/plain");
  });

  it("uses a PDF extension over inaccurate task-upload MIME metadata", async () => {
    await expect(
      readAttachment(
        new File(["%PDF-1.7"], "report.pdf", { type: "image/png" }),
        { taskUpload: true },
      ),
    ).resolves.toMatchObject({ mimeType: "application/pdf", encoding: "base64" });
  });

  it("labels DOCX attachments clearly", () => {
    expect(
      attachmentLabel({
        ...textAttachment,
        name: "brief.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        encoding: "base64",
      }),
    ).toBe("DOCX · brief.docx");
  });
});

describe("Talk proposal attachments", () => {
  it("retains only files from a turn that produced a proposal", () => {
    expect(attachmentsForTalkProposal(true, [textAttachment])).toEqual([
      textAttachment,
    ]);
    expect(attachmentsForTalkProposal(false, [textAttachment])).toEqual([]);
  });

  it("forwards retained files in direct and delegation confirmation payloads", () => {
    expect(
      withTalkAttachments(
        { agentId: "agent-1", objective: "Review it", talkMode: true },
        [textAttachment],
      ),
    ).toMatchObject({ attachments: [textAttachment] });
    expect(
      withTalkAttachments(
        { targetAgentId: "agent-2", objective: "Review it" },
        [textAttachment],
      ),
    ).toMatchObject({ attachments: [textAttachment] });
  });

  it("reports overflow beyond the unchanged four-file cap", () => {
    const retained = Array.from({ length: 4 }, (_, index) => ({
      ...textAttachment,
      name: `retained-${index}.txt`,
    }));
    expect(combineTalkProposalAttachments(retained, [])).toEqual({
      attachments: retained,
      exceedsLimit: false,
    });
    expect(
      combineTalkProposalAttachments(retained, [textAttachment]).exceedsLimit,
    ).toBe(true);
  });

  it("builds cleanup input only for a known proposal context", () => {
    expect(talkDocumentContextCleanupInput(null)).toBeNull();
    expect(talkDocumentContextCleanupInput("opaque-generation-A/B?")).toEqual({
      version: "opaque-generation-A/B?",
    });
  });
});