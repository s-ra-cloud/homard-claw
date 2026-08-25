/**
 * Unit coverage for email body construction:
 *  - plain-text-only messages keep the original single-part shape
 *  - a bodyHtml alternative produces multipart/alternative with a readable
 *    plain-text fallback part and a sanitized HTML part
 *  - safe links (http/https/mailto) survive; unsafe schemes are stripped
 *  - scripts, event handlers, and other dangerous markup are removed
 *  - a deterministic Message-ID header is preserved in both shapes
 */
import { describe, expect, it } from "vitest";
import { buildRfc822, sanitizeEmailHtml } from "./email-mime";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** Decode the base64 MIME parts back to text for assertions. */
function decodedParts(message: string): { plain: string; html: string } {
  const boundaryMatch = message.match(/boundary="([^"]+)"/);
  expect(boundaryMatch).not.toBeNull();
  const sections = message.split(`--${boundaryMatch![1]}`);
  const plainSection = sections.find((s) => s.includes("text/plain"));
  const htmlSection = sections.find((s) => s.includes("text/html"));
  expect(plainSection).toBeDefined();
  expect(htmlSection).toBeDefined();
  const partBody = (section: string) =>
    Buffer.from(
      section.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""),
      "base64",
    ).toString("utf8");
  return { plain: partBody(plainSection!), html: partBody(htmlSection!) };
}

describe("buildRfc822", () => {
  it("builds a plain text message when no html is given", () => {
    const msg = decode(
      buildRfc822({
        to: "a@example.com",
        subject: "Hello",
        text: "Just text",
      }),
    );
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).not.toContain("multipart/alternative");
    expect(msg).toContain("Just text");
  });

  it("builds multipart/alternative with plain fallback first and html last", () => {
    const msg = decode(
      buildRfc822({
        to: "a@example.com",
        subject: "Hello",
        text: "Visit https://example.com",
        html: '<p>Visit <a href="https://example.com">our site</a></p>',
        messageId: "marker-123@agents.test",
      }),
    );
    expect(msg).toContain("Message-ID: <marker-123@agents.test>");
    expect(msg).toContain("MIME-Version: 1.0");
    expect(msg).toContain("multipart/alternative");
    // Plain part must precede html part (clients prefer the last one).
    expect(msg.indexOf("text/plain")).toBeLessThan(msg.indexOf("text/html"));
    const { plain, html } = decodedParts(msg);
    expect(plain).toBe("Visit https://example.com");
    expect(html).toContain('<a href="https://example.com">our site</a>');
  });

  it("keeps the Message-ID header on plain text messages", () => {
    const msg = decode(
      buildRfc822({
        to: "a@example.com",
        subject: "S",
        text: "T",
        messageId: "m@x",
      }),
    );
    expect(msg).toContain("Message-ID: <m@x>");
  });

  it("carries non-ASCII content intact through base64 parts", () => {
    const msg = decode(
      buildRfc822({
        to: "a@example.com",
        subject: "S",
        text: "Grüße — 你好",
        html: "<p>Grüße — 你好</p>",
      }),
    );
    const { plain, html } = decodedParts(msg);
    expect(plain).toBe("Grüße — 你好");
    expect(html).toBe("<p>Grüße — 你好</p>");
  });
});

describe("sanitizeEmailHtml", () => {
  it("keeps benign formatting and http/https/mailto links", () => {
    const clean = sanitizeEmailHtml(
      '<p>Hi <strong>there</strong>,<br>see <a href="https://example.com/x?y=1">this</a> ' +
        'or <a href="mailto:me@example.com">email me</a>.</p>' +
        "<hr><div><em>Jane Doe</em><br><span>Acme Corp</span></div>",
    );
    expect(clean).toContain("<strong>there</strong>");
    expect(clean).toContain('<a href="https://example.com/x?y=1">this</a>');
    expect(clean).toContain('<a href="mailto:me@example.com">email me</a>');
    expect(clean).toContain("<em>Jane Doe</em>");
  });

  it("strips unsafe link schemes but keeps the link text", () => {
    const clean = sanitizeEmailHtml(
      '<a href="javascript:alert(1)">click</a> and <a href="data:text/html,x">here</a>',
    );
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("data:");
    expect(clean).toContain("click");
    expect(clean).toContain("here");
  });

  it("removes scripts, styles, iframes, event handlers, and unknown attributes", () => {
    const clean = sanitizeEmailHtml(
      '<p onclick="steal()">ok</p><script>alert(1)</script>' +
        "<style>body{display:none}</style><iframe src=\"https://evil\"></iframe>" +
        '<img src="https://tracker/pixel.gif"><form action="https://evil"><input></form>',
    );
    expect(clean).not.toBeNull();
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("alert(1)");
    expect(clean).not.toContain("display:none");
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("img");
    expect(clean).not.toContain("form");
    expect(clean).toContain("ok");
  });

  it("returns null when nothing renderable remains", () => {
    expect(sanitizeEmailHtml("<script>alert(1)</script>")).toBeNull();
    expect(sanitizeEmailHtml("   ")).toBeNull();
    expect(sanitizeEmailHtml("<style>x{}</style>")).toBeNull();
  });

  it("neutralizes markup that tries to break out of the html part", () => {
    const clean = sanitizeEmailHtml(
      '<p>hi</p><!--boundary injection attempt--\r\n--fake-boundary-->',
    );
    expect(clean).toContain("hi");
    expect(clean).not.toContain("fake-boundary");
  });
});
