/**
 * The hardened REST executor for owner-whitelisted custom APIs. It renders
 * ONLY saved endpoint templates: the origin, path shape, method, headers,
 * and parameter set all come from the reviewed definition — never from the
 * model. The credential is decrypted at this final server-side boundary,
 * injected as exactly one header, and scrubbed from every string that can
 * leave this module.
 *
 * Network hardening: HTTPS only, DNS resolution must yield exclusively
 * public addresses, the connection is pinned to a validated address (no
 * rebinding between check and connect), redirects are never followed,
 * request bodies and responses are size-capped, and per-connection
 * concurrency/rate limits bound abuse.
 */

import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  customApiConnectionsTable,
  db,
  type CustomApiConnectionRecord,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { isPublicWebAddress } from "../capabilities/web";
import type { ResolvedCapabilityTool } from "../capabilities/service";
import type { ExecutionOutcome } from "./connections";
import {
  decryptCustomApiCredential,
  parseStoredOperations,
  type CustomApiOperation,
} from "./custom-apis";

const MAX_REQUEST_BODY_BYTES = 100_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RESULT_CHARS = 4_000;
const MAX_CONCURRENT_PER_CONNECTION = 2;
const MAX_REQUESTS_PER_MINUTE = 30;

export type CustomApiRawResponse = {
  status: number;
  contentType: string;
  location: string | null;
  body: Buffer;
};

export type CustomApiRequestPlan = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type CustomApiExecutorDependencies = {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  requestOnce?: (
    plan: CustomApiRequestPlan,
    pinned: LookupAddress,
    options: { timeoutMs: number; maxBytes: number },
  ) => Promise<CustomApiRawResponse>;
};

class RefusedError extends Error {}
class TimeoutError extends Error {}
class BodyLimitError extends Error {}

function stripControlCharacters(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function boundText(value: string, charLimit: number): string {
  const clean = stripControlCharacters(value).trim();
  if (clean.length <= charLimit) return clean;
  return `${clean.slice(0, charLimit)}\n[truncated: the response exceeded ${charLimit} characters]`;
}

/** Remove the credential from anything that could leave this module. */
function redact(value: string, credential: string | null): string {
  if (!credential || credential.length === 0) return value;
  return value.split(credential).join("[redacted]");
}

/* Per-connection limiter: bounded concurrency + a one-minute window. */
const limiterState = new Map<
  string,
  { active: number; windowStart: number; count: number }
>();

function acquireSlot(connectionId: string): string | null {
  const now = Date.now();
  const state = limiterState.get(connectionId) ?? {
    active: 0,
    windowStart: now,
    count: 0,
  };
  if (now - state.windowStart >= 60_000) {
    state.windowStart = now;
    state.count = 0;
  }
  if (state.active >= MAX_CONCURRENT_PER_CONNECTION) {
    return "Too many concurrent requests to this API — try again shortly.";
  }
  if (state.count >= MAX_REQUESTS_PER_MINUTE) {
    return "This API's per-minute request limit was reached — try again shortly.";
  }
  state.active += 1;
  state.count += 1;
  limiterState.set(connectionId, state);
  return null;
}

function releaseSlot(connectionId: string): void {
  const state = limiterState.get(connectionId);
  if (state) state.active = Math.max(0, state.active - 1);
}

/** Test hook: clear limiter state between tests. */
export function resetCustomApiLimiter(): void {
  limiterState.clear();
}

async function defaultResolver(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function defaultRequestOnce(
  plan: CustomApiRequestPlan,
  pinned: LookupAddress,
  options: { timeoutMs: number; maxBytes: number },
): Promise<CustomApiRawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error: Error | null, result?: CustomApiRawResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const request = httpsRequest(
      plan.url,
      {
        method: plan.method,
        headers: plan.headers,
        // Pin the connection to the address that passed the public-address
        // check; TLS still authenticates the hostname via SNI from the URL.
        family: pinned.family,
        lookup: (_hostname, _lookupOptions, callback) => {
          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const contentType = String(response.headers["content-type"] ?? "");
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > options.maxBytes
        ) {
          response.destroy(new BodyLimitError());
          finish(new BodyLimitError());
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > options.maxBytes) {
            response.destroy(new BodyLimitError());
            finish(new BodyLimitError());
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
      request.destroy(new TimeoutError());
      finish(new TimeoutError());
    }, options.timeoutMs);
    request.once("error", (error) => finish(error));
    if (plan.body !== null) request.write(plan.body);
    request.end();
  });
}

/**
 * Render the saved operation template + validated params into a concrete
 * request plan. Exported for direct security testing. Throws RefusedError
 * with a safe message on any constraint violation.
 */
export function buildRequestPlan(
  row: Pick<
    CustomApiConnectionRecord,
    "baseUrl" | "authType" | "authHeaderName"
  >,
  op: CustomApiOperation,
  params: Record<string, unknown>,
  credential: string | null,
): CustomApiRequestPlan {
  const base = new URL(row.baseUrl);
  if (base.protocol !== "https:") {
    throw new RefusedError("Only https:// APIs can be called.");
  }
  // Render the path template. Path params are single URL segments: their
  // encoded value can never introduce "/", "..", "?", or "#".
  let rendered = op.path;
  for (const param of op.params) {
    if (param.in !== "path") continue;
    const raw = params[param.name];
    const value = raw === undefined || raw === null ? "" : String(raw);
    if (value === "" || value === "." || value === "..") {
      throw new RefusedError(
        `Path parameter "${param.name}" must be a non-empty path segment.`,
      );
    }
    rendered = rendered
      .split(`{${param.name}}`)
      .join(encodeURIComponent(value));
  }
  if (rendered.includes("{") || rendered.includes("}")) {
    throw new RefusedError(
      "The operation's path template has an unrendered placeholder.",
    );
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${base.origin}${basePath}${rendered}`);
  // The rendered URL must stay inside the approved origin and base path.
  if (
    url.origin !== base.origin ||
    !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) ||
    url.pathname.includes("..")
  ) {
    throw new RefusedError(
      "The rendered request escaped the approved base URL.",
    );
  }
  // Query params: encoded via URLSearchParams — never string-spliced.
  for (const param of op.params) {
    if (param.in !== "query") continue;
    const raw = params[param.name];
    if (raw === undefined || raw === null || raw === "") continue;
    url.searchParams.set(param.name, String(raw));
  }
  // Body: JSON object of body params only, size-capped.
  let body: string | null = null;
  const bodyParams = op.params.filter((param) => param.in === "body");
  if (bodyParams.length > 0) {
    const payload: Record<string, unknown> = {};
    for (const param of bodyParams) {
      const raw = params[param.name];
      if (raw === undefined || raw === null || raw === "") continue;
      payload[param.name] = param.kind === "number" ? Number(raw) : String(raw);
    }
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new RefusedError(
        `The request body exceeds the ${Math.floor(MAX_REQUEST_BODY_BYTES / 1000)} KB limit.`,
      );
    }
  }
  // The header set is closed: exactly these, plus at most ONE auth header.
  // Model-supplied values can never become header names or values.
  const headers: Record<string, string> = {
    accept: "application/json, text/plain;q=0.8, */*;q=0.1",
    "accept-encoding": "identity",
    "user-agent": "Crustabox-CustomAPI/1.0",
  };
  if (body !== null) headers["content-type"] = "application/json";
  if (row.authType === "bearer") {
    if (!credential) {
      throw new RefusedError(
        "This API needs a bearer token, but none is saved. Ask the owner to set the credential.",
      );
    }
    headers.authorization = `Bearer ${credential}`;
  } else if (row.authType === "api_key") {
    if (!credential || !row.authHeaderName) {
      throw new RefusedError(
        "This API needs an API key, but none is saved. Ask the owner to set the credential.",
      );
    }
    headers[row.authHeaderName.toLowerCase()] = credential;
  }
  return { url, method: op.method, headers, body };
}

async function resolvePublicHost(
  hostname: string,
  resolver: (hostname: string) => Promise<LookupAddress[]>,
  timeoutMs: number,
): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  let timer: NodeJS.Timeout | null = null;
  try {
    addresses = await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    throw new RefusedError("The API's hostname could not be resolved.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicWebAddress(entry.address))
  ) {
    // Any private/metadata/link-local answer poisons the whole set — a
    // split-horizon or rebinding DNS name never gets a connection.
    throw new RefusedError(
      "The API's hostname does not resolve exclusively to public internet addresses.",
    );
  }
  return addresses;
}

/**
 * Owner-triggered connectivity probe: one hardened GET against the base
 * URL. Any HTTP answer other than 401/403 counts as reachable — a 404 from
 * the base path still proves DNS, TLS, and the origin are sound, while
 * 401/403 specifically points at the credential. The detail string is
 * credential-redacted like every other output of this module.
 */
export async function validateCustomApiConnection(
  row: CustomApiConnectionRecord,
  dependencies: CustomApiExecutorDependencies = {},
): Promise<{ ok: boolean; detail: string | null }> {
  let credential: string | null = null;
  if (row.authType !== "none") {
    if (!row.credentialEnc) {
      return { ok: false, detail: "No credential is saved yet." };
    }
    try {
      credential = decryptCustomApiCredential(row.credentialEnc);
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : "The stored credential could not be used.",
      };
    }
  }
  const probeOp: CustomApiOperation = {
    id: "probe",
    method: "GET",
    path: "/",
    description: "Connectivity probe",
    level: "read",
    params: [],
  };
  try {
    const plan = buildRequestPlan(row, probeOp, {}, credential);
    const resolver = dependencies.resolve ?? defaultResolver;
    const requestOnce = dependencies.requestOnce ?? defaultRequestOnce;
    const hostname = plan.url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolvePublicHost(
      hostname,
      resolver,
      DEFAULT_TIMEOUT_MS,
    );
    const response = await requestOnce(plan, addresses[0]!, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        detail: `The API rejected the saved credential (HTTP ${response.status}).`,
      };
    }
    return {
      ok: true,
      detail: `The API answered with HTTP ${response.status}.`,
    };
  } catch (error) {
    let detail: string;
    if (error instanceof RefusedError) detail = error.message;
    else if (error instanceof TimeoutError) {
      detail = "The API did not answer within the timeout.";
    } else if (error instanceof BodyLimitError) {
      detail = "The API's response exceeded the size limit.";
    } else detail = "The API could not be reached.";
    return { ok: false, detail: redact(detail, credential) };
  }
}

/**
 * Execute one custom-API tool. `expectedRevision` is the definition
 * revision recorded when the request was authorized (and, for writes,
 * approved); if the owner changed the definition since, execution refuses
 * rather than running a request nobody reviewed.
 */
export async function executeCustomApiTool(
  tool: ResolvedCapabilityTool,
  params: Record<string, unknown>,
  context: { workspaceId: string | null; expectedRevision?: string | null },
  dependencies: CustomApiExecutorDependencies = {},
): Promise<ExecutionOutcome> {
  const executor = tool.def.executor;
  if (executor.kind !== "custom_api") {
    return { ok: false, kind: "failed", message: "Wrong executor kind." };
  }
  if (!context.workspaceId) {
    return {
      ok: false,
      kind: "failed",
      message: "Custom APIs require a workspace context.",
    };
  }
  // Fresh row read at the final boundary: enablement, revision, and the
  // credential are all judged NOW, not when the task started.
  const [row] = await db
    .select()
    .from(customApiConnectionsTable)
    .where(
      and(
        eq(customApiConnectionsTable.id, executor.connectionId),
        eq(customApiConnectionsTable.workspaceId, context.workspaceId),
      ),
    )
    .limit(1);
  if (!row) {
    return {
      ok: false,
      kind: "failed",
      message: "This custom API is no longer configured in this workspace.",
    };
  }
  if (!row.enabled) {
    return {
      ok: false,
      kind: "failed",
      message: "This custom API is currently disabled by the owner.",
    };
  }
  if (row.revision !== tool.manifest.version) {
    return {
      ok: false,
      kind: "failed",
      message:
        "This custom API's definition changed since the catalog was loaded. Request the action again.",
    };
  }
  if (
    context.expectedRevision !== undefined &&
    context.expectedRevision !== null &&
    context.expectedRevision !== row.revision
  ) {
    return {
      ok: false,
      kind: "failed",
      message:
        "This custom API's definition changed after the request was recorded, so it was not executed. Request it again under the current definition.",
    };
  }
  const operations = parseStoredOperations(row);
  const op = operations?.find(
    (candidate) => candidate.id === executor.operationId,
  );
  if (!op) {
    return {
      ok: false,
      kind: "failed",
      message: "This operation no longer exists on the custom API.",
    };
  }
  let credential: string | null = null;
  if (row.authType !== "none") {
    if (!row.credentialEnc) {
      return {
        ok: false,
        kind: "auth",
        message:
          "This API requires a credential, but none is saved. The owner must set one on the Connected Apps page.",
      };
    }
    try {
      credential = decryptCustomApiCredential(row.credentialEnc);
    } catch (error) {
      return {
        ok: false,
        kind: "auth",
        message:
          error instanceof Error
            ? error.message
            : "The stored credential could not be used.",
      };
    }
  }
  let plan: CustomApiRequestPlan;
  try {
    plan = buildRequestPlan(row, op, params, credential);
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      message: redact(
        error instanceof RefusedError
          ? error.message
          : "The request could not be constructed.",
        credential,
      ),
    };
  }
  const limited = acquireSlot(row.id);
  if (limited) return { ok: false, kind: "failed", message: limited };
  const timeoutMs = tool.def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const charLimit = tool.def.resultCharLimit ?? DEFAULT_RESULT_CHARS;
  try {
    const resolver = dependencies.resolve ?? defaultResolver;
    const requestOnce = dependencies.requestOnce ?? defaultRequestOnce;
    const hostname = plan.url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolvePublicHost(hostname, resolver, timeoutMs);
    const response = await requestOnce(plan, addresses[0]!, {
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    // Redirects are never followed for API calls: a 3xx from the approved
    // origin must not be able to steer the request (or the credential)
    // anywhere else. The status is reported; the Location target is not.
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        kind: "failed",
        message: `The API answered with a redirect (HTTP ${response.status}), which is not followed for API calls. Point the operation at the final URL.`,
      };
    }
    const contentType = response.contentType.toLowerCase();
    const textual =
      contentType === "" ||
      /^(?:text\/|application\/(?:json|[a-z0-9.+-]*\+json|xml|[a-z0-9.+-]*\+xml|x-www-form-urlencoded))/.test(
        contentType,
      );
    const bodyText = textual
      ? redact(response.body.toString("utf8"), credential)
      : `(binary ${contentType || "response"} of ${response.body.length} bytes; not shown)`;
    if (response.status < 200 || response.status >= 300) {
      const snippet = boundText(bodyText, 300);
      const authFailure = response.status === 401 || response.status === 403;
      return {
        ok: false,
        kind: authFailure ? "auth" : "failed",
        message: authFailure
          ? `The API rejected the saved credential (HTTP ${response.status}). The owner may need to rotate it.`
          : `The API returned HTTP ${response.status}.${snippet ? ` Response: ${snippet}` : ""}`,
      };
    }
    const summary = `HTTP ${response.status} from ${op.method} ${plan.url.pathname}\n${boundText(bodyText, charLimit) || "(empty response body)"}`;
    return { ok: true, summary: redact(summary, credential) };
  } catch (error) {
    let message: string;
    if (error instanceof RefusedError) message = error.message;
    else if (error instanceof TimeoutError) {
      message = `The API did not answer within ${Math.round(timeoutMs / 1000)} seconds.`;
    } else if (error instanceof BodyLimitError) {
      message = "The API's response exceeded the 1 MB limit and was refused.";
    } else {
      // Never surface raw error internals: transport errors can echo
      // headers (and therefore credentials) on some code paths.
      message = "The API could not be reached.";
    }
    return { ok: false, kind: "failed", message: redact(message, credential) };
  } finally {
    releaseSlot(row.id);
  }
}
