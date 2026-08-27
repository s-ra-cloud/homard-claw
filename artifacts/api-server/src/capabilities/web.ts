import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import sanitizeHtml from "sanitize-html";

const WEB_SEARCH_API_KEY_ENV = "WEB_SEARCH_API_KEY";
const WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESULT_CHARS = 4_000;

export type NativeWebOutcome =
  { ok: true; text: string } | { ok: false; message: string };

type ResolvedTarget = {
  url: URL;
  addresses: LookupAddress[];
};

type RawPageResponse = {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
};

export type WebFetchDependencies = {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  requestOnce?: (
    target: ResolvedTarget,
    options: { timeoutMs: number; maxBytes: number },
  ) => Promise<RawPageResponse>;
};

class WebTargetRefusedError extends Error {}
class WebTimeoutError extends Error {}
class WebBodyLimitError extends Error {}
class WebRedirectLimitError extends Error {}

function stripControlCharacters(value: string): string {
  // Keep ordinary whitespace, but remove terminal/control payloads.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return Number.isInteger(point) && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&#([0-9]+);/g, (match, decimal: string) => {
      const point = Number.parseInt(decimal, 10);
      return Number.isInteger(point) && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(
      /&(amp|apos|gt|lt|nbsp|quot);/gi,
      (_match, name: string) => named[name.toLowerCase()] ?? "",
    );
}

function plainText(value: string): string {
  return stripControlCharacters(
    decodeHtmlEntities(
      sanitizeHtml(value, {
        allowedTags: [],
        allowedAttributes: {},
        nonTextTags: [
          "script",
          "style",
          "textarea",
          "option",
          "xmp",
          "template",
          "svg",
          "canvas",
          "noscript",
        ],
      }),
    ),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function readableText(value: string): string {
  // sanitize-html is backed by htmlparser2. Preserve block boundaries during
  // the first pass, then strip every remaining tag/attribute in a second pass.
  const blockTags = [
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
  ];
  const structured = sanitizeHtml(value, {
    allowedTags: blockTags,
    allowedAttributes: {},
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "xmp",
      "template",
      "svg",
      "canvas",
      "noscript",
    ],
  })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?(?:${blockTags.join("|")})[^>]*>`, "gi"), "\n");
  return stripControlCharacters(
    decodeHtmlEntities(
      sanitizeHtml(structured, { allowedTags: [], allowedAttributes: {} }),
    ),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundText(value: string, charLimit: number): string {
  const clean = stripControlCharacters(value).trim();
  if (clean.length <= charLimit) return clean || "(the tool returned no text)";
  return `${clean.slice(0, charLimit)}\n[truncated: the tool returned more than ${charLimit} characters]`;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!
  );
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(baseNumber / size);
}

function blockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) =>
    ipv4InCidr(value, base as string, prefix as number),
  );
}

function parseIpv6(address: string): number[] | null {
  let input = address.toLowerCase();
  if (input.includes("%")) return null;
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const v4 = ipv4Number(input.slice(lastColon + 1));
    if (lastColon < 0 || v4 === null) return null;
    input = `${input.slice(0, lastColon)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (input.includes("::") && missing < 1) ||
    (!input.includes("::") && missing !== 0)
  ) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group, 16));
  if (
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group)) ||
    parsed.some(
      (group) => !Number.isInteger(group) || group < 0 || group > 0xffff,
    )
  ) {
    return null;
  }
  return parsed;
}

function ipv6InPrefix(
  groups: number[],
  first: bigint,
  prefix: number,
): boolean {
  const address = groups.reduce(
    (value, group) => (value << 16n) | BigInt(group),
    0n,
  );
  const shift = 128n - BigInt(prefix);
  return address >> shift === first >> shift;
}

function blockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const allZeroPrefix = groups.slice(0, 6).every((group) => group === 0);
  const mappedPrefix =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (allZeroPrefix || mappedPrefix) {
    const embedded = `${Math.floor(groups[6]! / 256)}.${groups[6]! % 256}.${Math.floor(groups[7]! / 256)}.${groups[7]! % 256}`;
    return blockedIpv4(embedded);
  }
  const value = groups.reduce(
    (result, group) => (result << 16n) | BigInt(group),
    0n,
  );
  return (
    value === 0n ||
    value === 1n ||
    ipv6InPrefix(groups, 0xfc00n << 112n, 7) ||
    ipv6InPrefix(groups, 0xfe80n << 112n, 10) ||
    ipv6InPrefix(groups, 0xff00n << 112n, 8) ||
    ipv6InPrefix(groups, 0x20010db8n << 96n, 32)
  );
}

/** True only for an address suitable for an outbound public-web request. */
export function isPublicWebAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blockedIpv4(address);
  if (version === 6) return !blockedIpv6(address);
  return false;
}

async function resolvePublicTarget(
  rawUrl: string,
  resolver: (hostname: string) => Promise<LookupAddress[]>,
  timeoutMs: number,
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebTargetRefusedError();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.hostname
  ) {
    throw new WebTargetRefusedError();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: LookupAddress[];
  let timer: NodeJS.Timeout | null = null;
  try {
    addresses = await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WebTimeoutError()), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof WebTimeoutError) throw error;
    throw new Error("dns_failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicWebAddress(entry.address))
  ) {
    throw new WebTargetRefusedError();
  }
  url.hash = "";
  return { url, addresses };
}

async function defaultResolver(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function requestPageOnce(
  target: ResolvedTarget,
  options: { timeoutMs: number; maxBytes: number },
): Promise<RawPageResponse> {
  return new Promise((resolve, reject) => {
    const pinned = target.addresses[0]!;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error: Error | null, result?: RawPageResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const request = httpsRequest(
      target.url,
      {
        method: "GET",
        headers: {
          accept:
            "text/html, text/plain, application/xhtml+xml, application/json;q=0.7, */*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "HomardClaw-WebResearch/2.0",
        },
        // Pin the connection to an address that passed validation. TLS still
        // authenticates target.url.hostname through the original URL/SNI.
        family: pinned.family,
        lookup: (_hostname, _lookupOptions, callback) => {
          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const contentType = String(response.headers["content-type"] ?? "");
        if (status >= 300 && status < 400 && location) {
          response.resume();
          finish(null, {
            status,
            location,
            contentType,
            body: Buffer.alloc(0),
          });
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > options.maxBytes
        ) {
          response.destroy(new WebBodyLimitError());
          finish(new WebBodyLimitError());
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > options.maxBytes) {
            response.destroy(new WebBodyLimitError());
            finish(new WebBodyLimitError());
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          finish(null, {
            status,
            location,
            contentType,
            body: Buffer.concat(chunks),
          });
        });
        response.once("error", (error) => finish(error));
      },
    );
    timer = setTimeout(() => {
      request.destroy(new WebTimeoutError());
      finish(new WebTimeoutError());
    }, options.timeoutMs);
    request.once("error", (error) => finish(error));
    request.end();
  });
}

/** Fetch a public HTTPS page, revalidating and pinning DNS on every hop. */
export async function fetchReadablePage(
  rawUrl: string,
  options: { timeoutMs: number },
  dependencies: WebFetchDependencies = {},
): Promise<string> {
  const resolver = dependencies.resolve ?? defaultResolver;
  const requestOnce = dependencies.requestOnce ?? requestPageOnce;
  const deadline = Date.now() + options.timeoutMs;
  let current = rawUrl;
  for (let redirects = 0; ; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WebTimeoutError();
    const target = await resolvePublicTarget(current, resolver, remaining);
    const response = await requestOnce(target, {
      timeoutMs: remaining,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects >= MAX_REDIRECTS) throw new WebRedirectLimitError();
      current = new URL(response.location, target.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`http_${response.status}`);
    }
    if (
      response.contentType &&
      !/^(?:text\/|application\/(?:json|xhtml\+xml|xml))/i.test(
        response.contentType,
      )
    ) {
      throw new Error("unsupported_content_type");
    }
    return readableText(response.body.toString("utf8"));
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new WebBodyLimitError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function searchWeb(query: string, timeoutMs: number): Promise<string> {
  const key = process.env[WEB_SEARCH_API_KEY_ENV]?.trim();
  if (!key) throw new Error("not_configured");
  const url = new URL(WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("safesearch", "moderate");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": key,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`search_http_${response.status}`);
    const payload = JSON.parse(await readBoundedResponse(response)) as {
      web?: { results?: unknown };
    };
    const rawResults = payload.web?.results;
    if (!Array.isArray(rawResults)) return "No web results were returned.";
    const lines: string[] = [];
    for (const item of rawResults.slice(0, 8)) {
      if (!item || typeof item !== "object") continue;
      const result = item as {
        title?: unknown;
        url?: unknown;
        description?: unknown;
      };
      if (typeof result.url !== "string") continue;
      let resultUrl: URL;
      try {
        resultUrl = new URL(result.url);
      } catch {
        continue;
      }
      if (resultUrl.protocol !== "https:") continue;
      const title = plainText(
        typeof result.title === "string" ? result.title : "Untitled result",
      );
      const snippet = plainText(
        typeof result.description === "string" ? result.description : "",
      );
      lines.push(
        `${lines.length + 1}. ${title || "Untitled result"}\n${resultUrl.toString()}${snippet ? `\n${snippet}` : ""}`,
      );
    }
    return lines.join("\n\n") || "No public HTTPS web results were returned.";
  } finally {
    clearTimeout(timer);
  }
}

function webFailureMessage(error: unknown): string {
  if (error instanceof WebTargetRefusedError) {
    return "The requested page was refused because it is not a public https:// address.";
  }
  if (
    error instanceof WebTimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "The web tool did not answer within the configured time limit.";
  }
  if (error instanceof WebBodyLimitError) {
    return "The web response was refused because it exceeded the 2 MB limit.";
  }
  if (error instanceof WebRedirectLimitError) {
    return "The requested page was refused because it redirected too many times.";
  }
  if (error instanceof Error && error.message === "not_configured") {
    return `Web Research is not configured: ${WEB_SEARCH_API_KEY_ENV} is missing.`;
  }
  if (error instanceof Error && error.message === "unsupported_content_type") {
    return "The requested page is not a readable text or HTML document.";
  }
  if (error instanceof Error && error.message.startsWith("http_")) {
    return `The requested page returned HTTP ${error.message.slice(5)}.`;
  }
  if (error instanceof Error && error.message.startsWith("search_http_")) {
    return `The web search service returned HTTP ${error.message.slice(12)}.`;
  }
  return "The web tool could not reach or read the requested resource.";
}

/** Resolve a data-only native handler name to vetted server implementation. */
export async function executeNativeWebHandler(
  handler: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; charLimit?: number },
): Promise<NativeWebOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const charLimit = options.charLimit ?? DEFAULT_RESULT_CHARS;
  // Treat the package as one configured feature. Fetch never silently works
  // around a missing search credential while the catalog says disconnected.
  if (!process.env[WEB_SEARCH_API_KEY_ENV]?.trim()) {
    return {
      ok: false,
      message: `Web Research is not configured: ${WEB_SEARCH_API_KEY_ENV} is missing.`,
    };
  }
  try {
    if (handler === "web.search") {
      const query = typeof params.query === "string" ? params.query : "";
      return {
        ok: true,
        text: boundText(await searchWeb(query, timeoutMs), charLimit),
      };
    }
    if (handler === "web.fetch") {
      const url = typeof params.url === "string" ? params.url : "";
      return {
        ok: true,
        text: boundText(await fetchReadablePage(url, { timeoutMs }), charLimit),
      };
    }
    return {
      ok: false,
      message: "This native capability handler is unavailable.",
    };
  } catch (error) {
    return { ok: false, message: webFailureMessage(error) };
  }
}

export function nativeWebConfigured(): boolean {
  return Boolean(process.env[WEB_SEARCH_API_KEY_ENV]?.trim());
}
