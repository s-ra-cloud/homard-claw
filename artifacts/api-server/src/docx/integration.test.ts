import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { normalizeAttachments } from "../attachments";
import { readDriveFileTransport } from "../connected-apps/drive-transport";

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small deflated OPC package, deliberately exercised through the real worker. */
function docxFixture(text: string): Uint8Array {
  const files: Array<[string, string]> = [
    ["[Content_Types].xml", `<?xml version="1.0"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`],
    ["word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const nameBytes = Buffer.from(name), content = Buffer.from(value), compressed = deflateRawSync(content);
    const crc = crc32(content);
    const header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("DOCX real parser ingress integrations", () => {
  const marker = "DOCX-REAL-INGRESS-MARKER";
  const bytes = docxFixture(marker);

  it("normalizes an actual DOCX upload to durable canonical text", async () => {
    const normalized = await normalizeAttachments([{
      name: "evidence.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
    }]);
    expect(normalized).toEqual([expect.objectContaining({
      name: "evidence.docx.txt",
      mimeType: "text/plain",
      encoding: "text",
      content: expect.stringContaining(marker),
    })]);
    expect(normalized[0]?.content).not.toContain(Buffer.from(bytes).toString("base64"));
  });

  it("uses the real isolated parser for bounded Google Drive DOCX bytes", async () => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "docx-real-drive", fileId: "docx-file", resolveToken: async () => "token",
      fetchImpl: async () => ++calls === 1
        ? new Response(JSON.stringify({
          name: "evidence.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }), { headers: { "content-type": "application/json" } })
        : new Response(bytes),
    });
    expect(result).toMatchObject({
      ok: true,
      name: "evidence.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: expect.stringContaining(marker),
    });
    expect(calls).toBe(2);
  });
});