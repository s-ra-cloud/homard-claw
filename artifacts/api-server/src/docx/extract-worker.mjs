import { inflateRawSync } from "node:zlib";
import { writeSync } from "node:fs";

const MAX_INPUT = 25_000_000;
const MAX_ENTRIES = 2_000;
// Only XML parts which this extractor reads consume the inflated-data budget.
// A DOCX may legitimately contain a very large image or video which must never
// be inflated merely to extract document text.
const MAX_XML_BYTES = 12_000_000;
const MAX_CONTENT_TYPES_BYTES = 1_000_000;
const MAX_TOTAL_XML_BYTES = 12_000_000;
const MAX_XML_DEPTH = 512;
const MAX_XML_TOKENS = 400_000;
const MAX_OUTPUT_CHARS = 1_500_000;
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const MARKUP_COMPATIBILITY_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
  "http://purl.oclc.org/ooxml/markup-compatibility/2006",
]);
const CONTENT_TYPE_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/content-types",
  "http://purl.oclc.org/ooxml/package/2006/content-types",
]);
const OMITTED = "text only; drawings, images, headers, footnotes, comments, field instructions, embedded objects, tracked deletions, move-from revisions, and other non-body content omitted";
const ALTERNATE_CONTENT_OMITTED = "AlternateContent branches omitted because they require an Office compatibility choice";
const TRUNCATED = "\n--- DOCX text extraction truncated at the 1500000-character limit; remaining document content was omitted. ---";

function respond(message) {
  try {
    // Pipe writes may be partial for large extracted documents. Loop over a
    // bounded chunk size so the complete JSON response is delivered without
    // ever creating an unbounded protocol buffer.
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    for (let offset = 0; offset < payload.length;) {
      try {
        const written = writeSync(3, payload, offset, Math.min(16 * 1024, payload.length - offset));
        if (!Number.isInteger(written) || written <= 0) throw new Error("protocol write");
        offset += written;
      } catch (cause) {
        if (cause?.code !== "EAGAIN") throw cause;
        Atomics.wait(waitCell, 0, 0, 1);
      }
    }
  } catch { /* parent stopped */ }
  process.exit(0);
}
function error(kind) { respond({ type: "error", kind }); }
function result(text) { respond({ type: "result", text }); }
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0; }
function hasAt(b, o, values) { return values.every((v, i) => b[o + i] === v); }
function utf8(b) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(b);
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      throw new Error("invalid");
    }
  }
  return value;
}
function containsAsciiOrUtf16(bytes, phrase) {
  const ascii = Buffer.from(phrase, "ascii");
  for (let start = 0; start <= bytes.length - ascii.length; start += 1) {
    if (hasAt(bytes, start, ascii)) return true;
    let matches = start + ascii.length * 2 <= bytes.length;
    for (let i = 0; matches && i < ascii.length; i += 1) {
      if (bytes[start + i * 2] !== ascii[i] || bytes[start + i * 2 + 1] !== 0) matches = false;
    }
    if (matches) return true;
  }
  return false;
}

function entriesFromZip(bytes) {
  if (bytes.length < 22 || !hasAt(bytes, 0, [0x50, 0x4b, 3, 4])) throw new Error("invalid");
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minimum; i -= 1) {
    if (hasAt(bytes, i, [0x50, 0x4b, 5, 6])) { eocd = i; break; }
  }
  if (eocd < 0 || u16(bytes, eocd + 4) || u16(bytes, eocd + 6)) throw new Error("invalid");
  const count = u16(bytes, eocd + 10), size = u32(bytes, eocd + 12), offset = u32(bytes, eocd + 16);
  if (!count || count > MAX_ENTRIES || offset + size > eocd) throw new Error("invalid");
  let at = offset;
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > offset + size || !hasAt(bytes, at, [0x50, 0x4b, 1, 2])) throw new Error("invalid");
    const flags = u16(bytes, at + 8), method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20), uncompressed = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42), end = at + 46 + nameLength + extraLength + commentLength;
    if (end > offset + size || compressed > bytes.length) throw new Error("invalid");
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLength));
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") ||
      name.split("/").some((part) => part === "..") || entries.has(name)) throw new Error("invalid");
    // Do not inspect local file data for unneeded media. Its declared inflated
    // size is deliberately not a package-wide budget.
    entries.set(name, { flags, method, compressed, uncompressed, local });
    at = end;
  }
  if (at !== offset + size || !entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) {
    throw new Error("invalid");
  }
  return entries;
}

function readXmlEntry(bytes, entry, maximum, budget) {
  if (!entry || entry.flags & 1 || (entry.method !== 0 && entry.method !== 8) ||
    entry.uncompressed > maximum || entry.uncompressed > budget.remaining ||
    // Highly repetitive Unicode text (including astral characters) can
    // legitimately compress by well over 200:1. The inflated XML and total
    // package budgets remain the hard zip-bomb boundaries.
    (entry.compressed && entry.uncompressed > entry.compressed * 2_000) ||
    (!entry.compressed && entry.uncompressed)) {
    throw new Error(entry?.flags & 1 ? "encrypted" : "invalid");
  }
  if (entry.local + 30 > bytes.length || !hasAt(bytes, entry.local, [0x50, 0x4b, 3, 4])) throw new Error("invalid");
  const localFlags = u16(bytes, entry.local + 6), localMethod = u16(bytes, entry.local + 8);
  const nameLength = u16(bytes, entry.local + 26), extraLength = u16(bytes, entry.local + 28);
  const start = entry.local + 30 + nameLength + extraLength;
  if (localFlags !== entry.flags || localMethod !== entry.method || start + entry.compressed > bytes.length) {
    throw new Error("invalid");
  }
  const source = bytes.subarray(start, start + entry.compressed);
  const output = entry.method === 0 ? source : inflateRawSync(source, { maxOutputLength: maximum });
  if (output.length !== entry.uncompressed || output.length > maximum || output.length > budget.remaining) {
    throw new Error("invalid");
  }
  budget.remaining -= output.length;
  return utf8(output);
}

function isName(value) {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value) && value.split(":").length <= 2;
}
function qname(value) {
  if (!isName(value)) throw new Error("invalid");
  const split = value.indexOf(":");
  if (split < 0) return { qname: value, prefix: "", local: value };
  if (split === 0 || split === value.length - 1) throw new Error("invalid");
  return { qname: value, prefix: value.slice(0, split), local: value.slice(split + 1) };
}
function decodeXml(value) {
  if (/&(?!#x[0-9a-fA-F]+;|#[0-9]+;|amp;|lt;|gt;|quot;|apos;)/.test(value)) throw new Error("invalid");
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_whole, token) => {
    if (token === "amp") return "&";
    if (token === "lt") return "<";
    if (token === "gt") return ">";
    if (token === "quot") return "\"";
    if (token === "apos") return "'";
    const code = token.startsWith("#x") ? Number.parseInt(token.slice(2), 16) : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(code) || code === 0 || code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) throw new Error("invalid");
    return String.fromCodePoint(code);
  });
}
function parseTag(source) {
  let at = 0;
  while (/\s/.test(source[at] ?? "")) at += 1;
  const closing = source[at] === "/";
  if (closing) {
    at += 1;
    while (/\s/.test(source[at] ?? "")) at += 1;
    const name = source.slice(at).trim();
    return { closing: true, ...qname(name) };
  }
  let selfClosing = false;
  let end = source.length;
  while (end && /\s/.test(source[end - 1])) end -= 1;
  if (source[end - 1] === "/") { selfClosing = true; end -= 1; }
  const nameStart = at;
  while (at < end && !/\s|=/.test(source[at])) at += 1;
  const element = qname(source.slice(nameStart, at));
  const attributes = [];
  const seen = new Set();
  while (at < end) {
    while (at < end && /\s/.test(source[at])) at += 1;
    if (at === end) break;
    const attrStart = at;
    while (at < end && !/\s|=/.test(source[at])) at += 1;
    const attribute = qname(source.slice(attrStart, at));
    while (at < end && /\s/.test(source[at])) at += 1;
    if (source[at] !== "=") throw new Error("invalid");
    at += 1;
    while (at < end && /\s/.test(source[at])) at += 1;
    const quote = source[at];
    if (quote !== "\"" && quote !== "'") throw new Error("invalid");
    at += 1;
    const valueStart = at;
    while (at < end && source[at] !== quote) at += 1;
    if (at === end) throw new Error("invalid");
    const rawValue = source.slice(valueStart, at);
    if (rawValue.includes("<")) throw new Error("invalid");
    const value = decodeXml(rawValue);
    at += 1;
    if (seen.has(attribute.qname)) throw new Error("invalid");
    seen.add(attribute.qname);
    attributes.push({ ...attribute, value });
  }
  return { closing: false, selfClosing, ...element, attributes };
}

/**
 * A bounded, namespace-aware XML event reader. It does not build a DOM, so
 * document XML remains bounded by the worker's XML budget rather than by a
 * general purpose object graph.
 */
function scanXml(xml, handlers) {
  const stack = [];
  let at = 0, tokens = 0, rootSeen = false, rootClosed = false;
  const emitText = (text, cdata = false) => {
    if (!text) return;
    if (!cdata && text.includes("]]>")) throw new Error("invalid");
    const value = cdata ? text : decodeXml(text);
    if (!stack.length && value.trim()) throw new Error("invalid");
    handlers.text?.(value);
  };
  while (at < xml.length) {
    if (++tokens > MAX_XML_TOKENS) throw new Error("invalid");
    const opening = xml.indexOf("<", at);
    if (opening < 0) { emitText(xml.slice(at)); break; }
    emitText(xml.slice(at, opening));
    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4);
      if (end < 0 || xml.slice(opening + 4, end).includes("--")) throw new Error("invalid");
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", opening)) {
      const end = xml.indexOf("]]>", opening + 9);
      if (end < 0) throw new Error("invalid");
      emitText(xml.slice(opening + 9, end), true);
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      if (end < 0) throw new Error("invalid");
      at = end + 2;
      continue;
    }
    if (xml.startsWith("<!", opening)) throw new Error("invalid");
    let end = opening + 1, quote = "";
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= xml.length || quote) throw new Error("invalid");
    const tag = parseTag(xml.slice(opening + 1, end));
    if (tag.closing) {
      const frame = stack.pop();
      if (!frame || frame.qname !== tag.qname) throw new Error("invalid");
      handlers.end?.(frame);
      if (!stack.length) rootClosed = true;
    } else {
      if (stack.length >= MAX_XML_DEPTH) throw new Error("invalid");
      if (!stack.length) {
        if (rootSeen || rootClosed) throw new Error("invalid");
        rootSeen = true;
      }
      // The xml prefix is implicitly declared by the XML Namespaces
      // specification; real Word text frequently uses xml:space="preserve".
      const namespaces = new Map(stack.at(-1)?.namespaces ?? [["xml", "http://www.w3.org/XML/1998/namespace"]]);
      for (const attribute of tag.attributes) {
        if (attribute.qname === "xmlns") namespaces.set("", attribute.value);
        else if (attribute.prefix === "xmlns") namespaces.set(attribute.local, attribute.value);
      }
      if (namespaces.get("xml") && namespaces.get("xml") !== "http://www.w3.org/XML/1998/namespace") {
        throw new Error("invalid");
      }
      const namespace = tag.prefix ? namespaces.get(tag.prefix) : namespaces.get("");
      if (tag.prefix && !namespace) throw new Error("invalid");
      for (const attribute of tag.attributes) {
        if (attribute.qname !== "xmlns" && attribute.prefix !== "xmlns" && attribute.prefix && !namespaces.get(attribute.prefix)) {
          throw new Error("invalid");
        }
      }
      const frame = { ...tag, namespace: namespace ?? "", namespaces };
      stack.push(frame);
      handlers.start?.(frame, stack.at(-2));
      if (tag.selfClosing) {
        stack.pop();
        handlers.end?.(frame);
        if (!stack.length) rootClosed = true;
      }
    }
    at = end + 1;
  }
  if (stack.length || !rootSeen || !rootClosed) throw new Error("invalid");
}

function hasContentTypesRoot(xml) {
  let root;
  scanXml(xml, {
    start(frame, parent) {
      if (!parent) {
        if (root) throw new Error("invalid");
        root = frame;
      }
    },
  });
  return Boolean(root && root.local === "Types" && CONTENT_TYPE_NAMESPACES.has(root.namespace));
}
function isWord(frame, local) {
  return frame.local === local && WORD_NAMESPACES.has(frame.namespace);
}
function isAlternateContent(frame) {
  return frame.local === "AlternateContent" && MARKUP_COMPATIBILITY_NAMESPACES.has(frame.namespace);
}

function bodyText(xml) {
  const stack = [];
  const blocks = [];
  let root;
  let rootClosed = false;
  let bodyDepth = 0;
  let bodySeen = false;
  let textDepth = 0;
  let paragraph = null;
  let tableDepth = 0;
  let table = null;
  let row = null;
  let cell = null;
  let alternateContentOmitted = false;
  function finishParagraph() {
    if (!paragraph) return;
    const value = paragraph.value.replace(/[ \t]+\n/g, "\n").trim();
    if (cell) cell.push(value);
    else if (value) blocks.push({ type: "paragraph", value });
    paragraph = null;
  }
  scanXml(xml, {
    start(frame, parent) {
      if (!parent) {
        if (root || rootClosed || !isWord(frame, "document")) throw new Error("invalid");
        root = frame;
      } else if (rootClosed) {
        throw new Error("invalid");
      }
      const parentSkipped = Boolean(parent?.skipped);
      const unsupported = isAlternateContent(frame);
      if (unsupported) alternateContentOmitted = true;
      frame.skipped = parentSkipped || unsupported ||
        isWord(frame, "drawing") || isWord(frame, "pict") || isWord(frame, "object") ||
        isWord(frame, "del") || isWord(frame, "moveFrom");
      const insideBody = bodyDepth > 0;
      if (isWord(frame, "body")) {
        if (bodySeen || parent !== root || frame.skipped) throw new Error("invalid");
        bodySeen = true;
        bodyDepth += 1;
        frame.body = true;
      } else if (insideBody && !frame.skipped && isWord(frame, "tbl")) {
        frame.table = true;
        if (tableDepth === 0) table = [];
        tableDepth += 1;
      } else if (insideBody && !frame.skipped && isWord(frame, "tr") && tableDepth === 1) {
        if (row) throw new Error("invalid");
        row = [];
        frame.row = true;
      } else if (insideBody && !frame.skipped && isWord(frame, "tc") && tableDepth === 1) {
        if (!row || cell) throw new Error("invalid");
        cell = [];
        frame.cell = true;
      } else if (insideBody && !frame.skipped && isWord(frame, "p")) {
        if (paragraph) throw new Error("invalid");
        paragraph = { frame, value: "" };
      }
      if (insideBody && !frame.skipped && paragraph && isWord(frame, "t")) {
        textDepth += 1;
        frame.collectText = true;
      } else if (insideBody && !frame.skipped && paragraph && (isWord(frame, "tab") || isWord(frame, "br") || isWord(frame, "cr"))) {
        paragraph.value += isWord(frame, "tab") ? "\t" : "\n";
      }
      stack.push(frame);
    },
    text(value) {
      if (!stack.length) {
        if (value.trim()) throw new Error("invalid");
      } else if (textDepth && paragraph) {
        paragraph.value += value;
      }
    },
    end(frame) {
      if (stack.pop() !== frame) throw new Error("invalid");
      if (frame.collectText) textDepth -= 1;
      if (isWord(frame, "p") && paragraph?.frame === frame) finishParagraph();
      if (frame.cell) {
        row.push(cell.join("\n"));
        cell = null;
      }
      if (frame.row) {
        table.push(row);
        row = null;
      }
      if (frame.table) {
        tableDepth -= 1;
        if (tableDepth === 0) {
          blocks.push({ type: "table", value: table });
          table = null;
        }
      }
      if (frame.body) bodyDepth -= 1;
      if (frame === root) rootClosed = true;
    },
  });
  if (!root || !rootClosed || !bodySeen || bodyDepth || textDepth || paragraph || table || row || cell || stack.length) {
    throw new Error("invalid");
  }
  return { blocks, alternateContentOmitted };
}

function appendBounded(current, currentChars, addition) {
  const noticeChars = [...TRUNCATED].length;
  const available = MAX_OUTPUT_CHARS - noticeChars - currentChars;
  if (available <= 0) {
    return {
      text: current + TRUNCATED,
      chars: currentChars + noticeChars,
      clipped: true,
    };
  }
  const chars = [...addition];
  return chars.length <= available
    ? {
        text: current + addition,
        chars: currentChars + chars.length,
        clipped: false,
      }
    : {
        text: current + chars.slice(0, available).join("") + TRUNCATED,
        chars: MAX_OUTPUT_CHARS,
        clipped: true,
      };
}

function extract(bytes) {
  if (!bytes.length) return error("invalid_docx");
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const probe = bytes.subarray(0, Math.min(bytes.length, 4096));
    return error(
      containsAsciiOrUtf16(probe, "EncryptedPackage") ||
      containsAsciiOrUtf16(probe, "EncryptionInfo") ? "encrypted" : "legacy",
    );
  }
  try {
    const entries = entriesFromZip(bytes);
    const budget = { remaining: MAX_TOTAL_XML_BYTES };
    const contentTypes = readXmlEntry(bytes, entries.get("[Content_Types].xml"), MAX_CONTENT_TYPES_BYTES, budget);
    if (!hasContentTypesRoot(contentTypes)) return error("invalid_docx");
    // Relationships are intentionally not read: hyperlink targets (including
    // TargetMode=External) are metadata, not document text, and are never
    // dereferenced by this isolated extractor.
    const parsed = bodyText(readXmlEntry(bytes, entries.get("word/document.xml"), MAX_XML_BYTES, budget));
    const omission = parsed.alternateContentOmitted ? `${OMITTED}; ${ALTERNATE_CONTENT_OMITTED}` : OMITTED;
    let output = `--- DOCX document body (${omission}) ---\n`;
    let outputChars = [...output].length;
    let paragraphNumber = 0, tableNumber = 0;
    for (const block of parsed.blocks) {
      let next;
      if (block.type === "paragraph") {
        paragraphNumber += 1;
        next = `--- DOCX paragraph ${paragraphNumber} (${omission}) ---\n${block.value}\n`;
      } else {
        tableNumber += 1;
        next = `--- DOCX table ${tableNumber} (table text only; ${omission}) ---\n${block.value.map((tableRow) => tableRow.join("\t")).join("\n")}\n`;
      }
      const appended = appendBounded(output, outputChars, next);
      output = appended.text;
      outputChars = appended.chars;
      if (appended.clipped) return result(output);
    }
    return result(output);
  } catch (cause) {
    return error(cause instanceof Error && cause.message === "encrypted" ? "encrypted" : "invalid_docx");
  }
}
async function readInput() {
  const chunks = []; let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > MAX_INPUT) return error("input_too_large");
    chunks.push(chunk);
  }
  extract(Buffer.concat(chunks, total));
}
void readInput().catch(() => error("extraction_failed"));