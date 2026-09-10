import { describe, expect, it } from "vitest";
import { readAttachment } from "./attachments";

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
