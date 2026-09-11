import { describe, expect, it } from "vitest";
import {
  attachmentsForTalkProposal,
  readAttachment,
  withTalkAttachments,
} from "./attachments";

const MAX_FILE_BYTES = 25_000_000;

function textFile(bytes: number, name = "notes.txt"): File {
  return new File(["a".repeat(bytes)], name, { type: "text/plain" });
}

describe("readAttachment", () => {
  it("accepts a text file right at the 25 MB boundary", async () => {
    const attachment = await readAttachment(textFile(MAX_FILE_BYTES));
    expect(attachment.content).toHaveLength(MAX_FILE_BYTES);
  });

  it("rejects a file one byte over the 25 MB boundary", async () => {
    await expect(readAttachment(textFile(MAX_FILE_BYTES + 1))).rejects.toThrow(
      "notes.txt is larger than 25 MB.",
    );
  });

  it("still accepts small files well under the limit", async () => {
    const attachment = await readAttachment(textFile(10));
    expect(attachment.content).toHaveLength(10);
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
});
