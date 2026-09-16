import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractDocxText } from "./extract";

const TRANSITIONAL = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";

type ZipPart = readonly [name: string, content: string | Buffer];

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A standards-valid, deflated OPC package rather than a synthetic XML ZIP. */
function deflatedDocx(documentXml: string, extra: ZipPart[] = []): Uint8Array {
  const files: ZipPart[] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="${CONTENT_TYPES}">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`],
    ["word/document.xml", documentXml],
    ...extra,
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    central.push(record, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function wordDocument(body: string, namespace = TRANSITIONAL): string {
  return `<w:document xmlns:w="${namespace}"><w:body>${body}</w:body></w:document>`;
}

describe("extractDocxText", () => {
  it("extracts transitional Word body paragraphs and tables from a deflated OPC package", async () => {
    const bytes = deflatedDocx(wordDocument(
      "<w:p><w:r><w:t>First &amp; foremost</w:t></w:r></w:p>" +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>left</w:t></w:r></w:p></w:tc>" +
      "<w:tc><w:p><w:r><w:t>right</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
      "<w:p><w:r><w:t>Last</w:t></w:r></w:p>",
    ));
    const text = await extractDocxText(bytes);
    expect(text).toContain("--- DOCX document body (text only;");
    expect(text).toContain("--- DOCX paragraph 1");
    expect(text).toContain("First & foremost");
    expect(text).toContain("--- DOCX table 1");
    expect(text).toContain("left\tright");
    expect(text).toContain("Last");
  });

  it("recognizes strict WordprocessingML namespaces", async () => {
    const text = await extractDocxText(deflatedDocx(wordDocument(
      "<w:p><w:r><w:t>Strict namespace text</w:t></w:r></w:p>",
      STRICT,
    )));
    expect(text).toContain("Strict namespace text");
  });

  it("retains hyperlink display text without reading or dereferencing an external target", async () => {
    const bytes = deflatedDocx(
      `<w:document xmlns:w="${TRANSITIONAL}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <w:body><w:p><w:hyperlink r:id="rId1"><w:r><w:t>Read this link</w:t></w:r></w:hyperlink></w:p></w:body>
      </w:document>`,
      [[
        "word/_rels/document.xml.rels",
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
            Target="https://example.invalid/private" TargetMode="External"/>
        </Relationships>`,
      ]],
    );
    await expect(extractDocxText(bytes)).resolves.toContain("Read this link");
  });

  it("omits drawing, deleted, move-from, and AlternateContent text with a specific compatibility label", async () => {
    const bytes = deflatedDocx(`
      <w:document xmlns:w="${TRANSITIONAL}"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <w:body><w:p>
          <w:r><w:t>Visible</w:t></w:r>
          <w:del><w:r><w:t>Deleted</w:t></w:r></w:del>
          <w:moveFrom><w:r><w:t>Moved away</w:t></w:r></w:moveFrom>
          <w:drawing><a:txBody><w:p><w:r><w:t>Drawing text</w:t></w:r></w:p></a:txBody></w:drawing>
          <mc:AlternateContent>
            <mc:Choice Requires="w14"><w:r><w:t>Choice text</w:t></w:r></mc:Choice>
            <mc:Fallback><w:r><w:t>Fallback text</w:t></w:r></mc:Fallback>
          </mc:AlternateContent>
        </w:p></w:body>
      </w:document>
    `);
    const text = await extractDocxText(bytes);
    expect(text).toContain("Visible");
    expect(text).not.toContain("Deleted");
    expect(text).not.toContain("Moved away");
    expect(text).not.toContain("Drawing text");
    expect(text).not.toContain("Choice text");
    expect(text).not.toContain("Fallback text");
    expect(text).toContain("AlternateContent branches omitted");
  });

  it("does not count uninflated media against the XML extraction budget", async () => {
    const bytes = deflatedDocx(
      wordDocument("<w:p><w:r><w:t>Text beside a large image</w:t></w:r></w:p>"),
      [["word/media/large-image.bin", Buffer.alloc(26_000_000)]],
    );
    await expect(extractDocxText(bytes)).resolves.toContain("Text beside a large image");
  });

  it("rejects malformed XML and DTD/entity expansion attempts with a content-free fixed error", async () => {
    const malformed = deflatedDocx(wordDocument("<w:p><w:r><w:t>PRIVATE DOCX CONTENT</w:t></w:r></w:body>"));
    const entityBomb = deflatedDocx(`<!DOCTYPE w:document [<!ENTITY x "PRIVATE DOCX CONTENT">]>
      <w:document xmlns:w="${TRANSITIONAL}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`);
    for (const bytes of [malformed, entityBomb]) {
      await expect(extractDocxText(bytes)).rejects.toEqual(expect.objectContaining({
        kind: "invalid_docx",
        message: "The file is not a valid DOCX document.",
      }));
    }
  });

  it("rejects XML inflated beyond the hard XML budget", async () => {
    const tooLargeText = "x".repeat(12_100_000);
    const bytes = deflatedDocx(wordDocument(`<w:p><w:r><w:t>${tooLargeText}</w:t></w:r></w:p>`));
    await expect(extractDocxText(bytes)).rejects.toMatchObject({ kind: "invalid_docx" });
  });

  it("classifies encrypted and legacy Word compound files without parsing them", async () => {
    await expect(extractDocxText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])))
      .rejects.toMatchObject({ kind: "legacy" });
    await expect(extractDocxText(Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
      Buffer.from("EncryptionInfo", "ascii"),
    ]))).rejects.toMatchObject({ kind: "encrypted" });
  });

  it("honors a stricter caller input boundary before starting a parser", async () => {
    await expect(extractDocxText(new Uint8Array(2), { maxInputBytes: 1 }))
      .rejects.toMatchObject({ kind: "input_too_large" });
  });
});