/**
 * Email body construction for Gmail draft/send operations.
 *
 * Agents may supply an optional HTML alternative (`bodyHtml`) alongside the
 * required plain-text `body`. The HTML is sanitized through a strict
 * allowlist before it ever reaches an RFC-822 message: only benign
 * formatting tags survive, `href` is the only link attribute and only
 * http/https/mailto schemes are kept. Scripts, event handlers, styles,
 * frames, forms, and every other vector are removed — not escaped, removed.
 *
 * The resulting message is multipart/alternative: a readable plain-text
 * fallback first, then the sanitized HTML part, both base64-encoded so
 * arbitrary UTF-8 content never interferes with MIME structure.
 */
import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";

/** Link schemes that may survive sanitization. Everything else is dropped. */
const ALLOWED_SCHEMES = ["http", "https", "mailto"];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a",
    "p",
    "br",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "hr",
    "pre",
    "code",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
  ],
  allowedAttributes: {
    a: ["href"],
  },
  allowedSchemes: ALLOWED_SCHEMES,
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  // Contents of these are dangerous even as text; drop entirely.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe"],
  disallowedTagsMode: "discard",
};

/**
 * Sanitize agent-supplied HTML for use as an email alternative part.
 * Returns null when nothing renderable remains after sanitization (e.g. the
 * input was only a script tag) so callers can fall back to plain text.
 */
export function sanitizeEmailHtml(html: string): string | null {
  const clean = sanitizeHtml(html, SANITIZE_OPTIONS).trim();
  if (clean === "") return null;
  // If sanitization stripped every tag AND left no text, treat as empty.
  const textOnly = clean.replace(/<[^>]*>/g, "").trim();
  const hasStructure = /<[a-z]/i.test(clean);
  if (!hasStructure && textOnly === "") return null;
  return clean;
}

/** RFC 2045 base64 with 76-char lines, suitable for a MIME body part. */
function mimeBase64(content: string): string {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  return b64.replace(/(.{76})/g, "$1\r\n").trim();
}

/**
 * Build a raw (base64url) RFC-822 message. When `html` is provided the
 * message is multipart/alternative with the plain-text part first (the
 * fallback) and the HTML part last (preferred by capable clients);
 * otherwise it is a simple text/plain message.
 */
export function buildRfc822(options: {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  messageId?: string;
}): string {
  const { to, subject, text, html, messageId } = options;
  const baseHeaders = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    "MIME-Version: 1.0",
  ];

  let message: string;
  if (html) {
    // Deterministic boundary; collision with body content is impossible in
    // practice because parts are base64-encoded (alphabet excludes "=_").
    const boundary = `=_hc_${createHash("sha256")
      .update(text)
      .update("\u0000")
      .update(html)
      .digest("hex")
      .slice(0, 24)}`;
    const headers = [
      ...baseHeaders,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];
    const parts = [
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      mimeBase64(text),
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      mimeBase64(html),
      `--${boundary}--`,
    ];
    message = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  } else {
    const headers = [...baseHeaders, `Content-Type: text/plain; charset="UTF-8"`];
    message = `${headers.join("\r\n")}\r\n\r\n${text}`;
  }
  return Buffer.from(message, "utf8").toString("base64url");
}
