import { describe, expect, it } from "vitest";
import {
  attachmentLabel,
  attachmentsForTalkProposal,
  combineTalkProposalAttachments,
  inferAttachmentMimeType,
  readAttachment,
  talkDocumentContextCleanupInput,
  withTalkAttachments,
} from "./attachments";

const MAX_FILE_BYTES = 25_000_000;

function textFile(bytes: number, name = "notes.txt"): File {
  return new File(["a".repeat(bytes)], name, { type: "text/plain" });
}

describe("readAttachment", () => {
  it("accepts a text file right at the 25 MB boundary", async () => {
  const attachment = {
    name: "brief.txt",
    mimeType: "text/plain",
    encoding: "text" as const,
    content: "Keep this exact content.",
  };
    expect(attachment).toMatchObject({ encoding: "base64", mimeType: expect.stringContaining("wordprocessingml") });
    expect(attachmentLabel(attachment)).toBe("DOCX · brief.docx");
  });

  it("prefers a supported browser MIME and preserves unknown legacy files as text", () => {
    expect(
      inferAttachmentMimeType({ name: "notes.unknown", type: "text/plain" }),
    ).toBe("text/plain");
    expect(
      inferAttachmentMimeType({
        name: "legacy.notes",
        type: "application/x-legacy-note",
      }),
    ).toBe("text/plain");
  });

});

describe("Talk proposal attachments", () => {
  const attachment = {
    name: "brief.txt",
    mimeType: "text/plain",
    encoding: "text" as const,
    content: "Keep this exact content.",
  };
    expect(attachment).toMatchObject({ encoding: "base64", mimeType: expect.stringContaining("wordprocessingml") });
    expect(attachmentLabel(attachment)).toBe("DOCX · brief.docx");
  });

  it("prefers a supported browser MIME and preserves unknown legacy files as text", () => {
    expect(
      inferAttachmentMimeType({ name: "notes.unknown", type: "text/plain" }),
    ).toBe("text/plain");
    expect(
      inferAttachmentMimeType({
        name: "legacy.notes",
        type: "application/x-legacy-note",
      }),
    ).toBe("text/plain");
  });

});

describe("Talk proposal attachments", () => {
  const attachment = {
    name: "brief.txt",
    mimeType: "text/plain",
    encoding: "text" as const,
    content: "Keep this exact content.",
  };
    expect(attachment).toMatchObject({ encoding: "base64", mimeType: expect.stringContaining("wordprocessingml") });
    expect(attachmentLabel(attachment)).toBe("DOCX · brief.docx");
  });

  it("prefers a supported browser MIME and preserves unknown legacy files as text", () => {
    expect(
      inferAttachmentMimeType({ name: "notes.unknown", type: "text/plain" }),
    ).toBe("text/plain");
    expect(
      inferAttachmentMimeType({
        name: "legacy.notes",
        type: "application/x-legacy-note",
      }),
    ).toBe("text/plain");
  });

});

describe("Talk proposal attachments", () => {
  const attachment = {
    name: "brief.txt",
    mimeType: "text/plain",
    encoding: "text" as const,
    content: "Keep this exact content.",
  };

  it("retains only the files from a turn that produced a proposal", () => {
    expect(attachmentsForTalkProposal(true, [attachment])).toEqual([
      attachment,
    ]);
    expect(attachmentsForTalkProposal(false, [attachment])).toEqual([]);
  });

  it("forwards retained files in both direct and delegation confirmation payloads", () => {
    expect(
      withTalkAttachments(
        { agentId: "agent-1", objective: "Review it", talkMode: true },
        [attachment],
      ),
    ).toMatchObject({ attachments: [attachment] });
    expect(
      withTalkAttachments(
        { targetAgentId: "agent-2", objective: "Review it" },
        [attachment],
      ),
    ).toMatchObject({ attachments: [attachment] });
  });

  it("omits attachments after a proposal is cleared or replaced", () => {
    expect(withTalkAttachments({ objective: "New task" }, [])).toEqual({
      objective: "New task",
    });
  });

  it("accepts exactly four proposal files and surfaces retained/current overflow", () => {
    const retained = Array.from({ length: 4 }, (_, index) => ({
      ...attachment,
      name: `retained-${index}.txt`,
    }));
    expect(combineTalkProposalAttachments(retained, [])).toEqual({
      attachments: retained,
      exceedsLimit: false,
    });
    expect(combineTalkProposalAttachments(retained, [attachment])).toEqual(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({ name: "retained-0.txt" }),
          attachment,
        ]),
        exceedsLimit: true,
      }),
    );
  });

  it("builds conditional cleanup only for a known proposal context", () => {
    expect(talkDocumentContextCleanupInput(null)).toBeNull();
    expect(talkDocumentContextCleanupInput("opaque-generation-A/B?")).toEqual({
      version: "opaque-generation-A/B?",
    });
  });
});
