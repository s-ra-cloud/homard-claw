/**
 * Owner-whitelisted third-party REST APIs ("custom APIs"). Each workspace
 * row is a closed contract: an exact HTTPS base URL, a bounded catalog of
 * operations (method + path template + typed params + read/draft/write
 * level), and an optional credential that agents never see. Rows are
 * resolved into per-workspace capability packages so the whole existing
 * pipeline — explicit grants, sandbox denial, approval-gated writes, audit
 * — polices them without new trust surfaces.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import {
  customApiConnectionsTable,
  db,
  type CustomApiConnectionRecord,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type {
  CapabilityManifest,
  CapabilityParamSpec,
  CapabilityToolDef,
} from "../capabilities/manifest";

/* ------------------------------------------------------------------ */
/* Bounds. Every limit is a hard cap: definitions outside them are     */
/* rejected with an actionable error, never silently truncated.        */
/* ------------------------------------------------------------------ */

export const CUSTOM_API_MAX_OPERATIONS = 30;
export const CUSTOM_API_MAX_PARAMS = 15;
export const CUSTOM_API_MAX_PATH_LENGTH = 200;
export const CUSTOM_API_MAX_DESCRIPTION = 300;
export const CUSTOM_API_MAX_DISPLAY_NAME = 80;
export const CUSTOM_API_MAX_CREDENTIAL_LENGTH = 4096;
/** Default per-string-param cap; body params may go up to the body cap. */
const DEFAULT_PARAM_MAX_LENGTH = 2000;
const BODY_PARAM_MAX_LENGTH = 20000;

export const CUSTOM_API_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type CustomApiMethod = (typeof CUSTOM_API_METHODS)[number];

export const CUSTOM_API_AUTH_TYPES = ["none", "api_key", "bearer"] as const;
export type CustomApiAuthType = (typeof CUSTOM_API_AUTH_TYPES)[number];

export type CustomApiParam = {
  name: string;
  in: "path" | "query" | "body";
  kind: "string" | "number";
  required: boolean;
  maxLength?: number;
  /** Only body params may carry newlines (header/URL injection gate). */
  multiline?: boolean;
  description?: string;
};

export type CustomApiOperation = {
  /** Stable id; the tool name becomes `custom_<slug>.<id>`. */
  id: string;
  method: CustomApiMethod;
  /** Path template under the base URL; `{param}` renders a path param. */
  path: string;
  description: string;
  /** GET is always read; non-GET is draft or write (write ⇒ approval). */
  level: "read" | "draft" | "write";
  params: CustomApiParam[];
};

export type NormalizedCustomApiDefinition = {
  slug: string;
  displayName: string;
  description: string;
  baseUrl: string;
  authType: CustomApiAuthType;
  authHeaderName: string | null;
  operations: CustomApiOperation[];
};

const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,60}$/;
/** Headers the executor owns; a definition can never claim them. */
const FORBIDDEN_AUTH_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

/* ------------------------------------------------------------------ */
/* Definition validation                                               */
/* ------------------------------------------------------------------ */

export type NormalizeResult =
  | { ok: true; value: NormalizedCustomApiDefinition }
  | { ok: false; errors: string[] };

/** Reject base URLs that could never be a legitimate public API origin. */
export function validateBaseUrl(raw: unknown): string | { error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "A base URL is required." };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 300) {
    return { error: "The base URL must be at most 300 characters." };
  }
  if (hasControlChars(trimmed) || /\s/.test(trimmed)) {
    return { error: "The base URL must not contain whitespace or control characters." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "The base URL is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { error: "Only https:// base URLs are supported." };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "The base URL must not embed credentials." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { error: "The base URL must not include a query string or fragment." };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) return { error: "The base URL needs a hostname." };
  if (isIP(hostname)) {
    return { error: "Use a public DNS hostname, not an IP address." };
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    !hostname.includes(".")
  ) {
    return { error: "The base URL must point at a public hostname." };
  }
  if (url.pathname.includes("..") || url.pathname.includes("//")) {
    return { error: "The base URL path must not contain '..' or '//'." };
  }
  // Normalize: origin + path without a trailing slash (except root).
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function validateParamSpec(
  raw: unknown,
  opId: string,
  errors: string[],
): CustomApiParam | null {
  if (!raw || typeof raw !== "object") {
    errors.push(`Operation "${opId}": each parameter must be an object.`);
    return null;
  }
  const p = raw as Record<string, unknown>;
  const label = typeof p.name === "string" ? p.name : "(unnamed)";
  if (typeof p.name !== "string" || !PARAM_NAME_PATTERN.test(p.name)) {
    errors.push(
      `Operation "${opId}": parameter name "${label}" must match ${PARAM_NAME_PATTERN} (letters, digits, underscore).`,
    );
    return null;
  }
  if (p.in !== "path" && p.in !== "query" && p.in !== "body") {
    errors.push(
      `Operation "${opId}": parameter "${p.name}" must declare in: path, query, or body.`,
    );
    return null;
  }
  if (p.kind !== "string" && p.kind !== "number") {
    errors.push(
      `Operation "${opId}": parameter "${p.name}" must be kind string or number.`,
    );
    return null;
  }
  const required = p.in === "path" ? true : p.required === true;
  const bodyParam = p.in === "body";
  const multiline = bodyParam && p.multiline === true;
  const cap = bodyParam ? BODY_PARAM_MAX_LENGTH : DEFAULT_PARAM_MAX_LENGTH;
  let maxLength: number | undefined;
  if (p.maxLength !== undefined && p.maxLength !== null) {
    const n = Number(p.maxLength);
    if (!Number.isInteger(n) || n < 1 || n > cap) {
      errors.push(
        `Operation "${opId}": parameter "${p.name}" maxLength must be an integer between 1 and ${cap}.`,
      );
      return null;
    }
    maxLength = n;
  }
  if (p.multiline === true && !bodyParam) {
    errors.push(
      `Operation "${opId}": only body parameters may be multiline ("${p.name}" is in ${String(p.in)}).`,
    );
    return null;
  }
  let description: string | undefined;
  if (p.description !== undefined && p.description !== null) {
    if (
      typeof p.description !== "string" ||
      p.description.length > CUSTOM_API_MAX_DESCRIPTION ||
      hasControlChars(p.description)
    ) {
      errors.push(
        `Operation "${opId}": parameter "${p.name}" description must be plain text up to ${CUSTOM_API_MAX_DESCRIPTION} characters.`,
      );
      return null;
    }
    description = p.description;
  }
  return {
    name: p.name,
    in: p.in,
    kind: p.kind,
    required,
    ...(maxLength !== undefined
      ? { maxLength }
      : { maxLength: p.kind === "string" ? cap : undefined }),
    ...(multiline ? { multiline } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function validateOperation(
  raw: unknown,
  errors: string[],
): CustomApiOperation | null {
  if (!raw || typeof raw !== "object") {
    errors.push("Each operation must be an object.");
    return null;
  }
  const op = raw as Record<string, unknown>;
  const label = typeof op.id === "string" ? op.id : "(missing id)";
  if (typeof op.id !== "string" || !OPERATION_ID_PATTERN.test(op.id)) {
    errors.push(
      `Operation id "${label}" must be lowercase letters/digits/underscores, starting with a letter (max 60 chars).`,
    );
    return null;
  }
  if (
    typeof op.method !== "string" ||
    !CUSTOM_API_METHODS.includes(op.method as CustomApiMethod)
  ) {
    errors.push(
      `Operation "${op.id}": method must be one of ${CUSTOM_API_METHODS.join(", ")}.`,
    );
    return null;
  }
  const method = op.method as CustomApiMethod;
  if (
    typeof op.path !== "string" ||
    op.path.length === 0 ||
    op.path.length > CUSTOM_API_MAX_PATH_LENGTH
  ) {
    errors.push(
      `Operation "${op.id}": path is required (max ${CUSTOM_API_MAX_PATH_LENGTH} characters).`,
    );
    return null;
  }
  const path = op.path;
  if (
    !path.startsWith("/") ||
    hasControlChars(path) ||
    /\s/.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    errors.push(
      `Operation "${op.id}": path must start with "/" and contain no whitespace, "..", "//", "?", or "#".`,
    );
    return null;
  }
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/{}]*$/.test(path)) {
    errors.push(
      `Operation "${op.id}": path contains characters that are not allowed in a URL path.`,
    );
    return null;
  }
  if (
    typeof op.description !== "string" ||
    op.description.trim().length === 0 ||
    op.description.length > CUSTOM_API_MAX_DESCRIPTION ||
    hasControlChars(op.description)
  ) {
    errors.push(
      `Operation "${op.id}": a plain-text description is required (max ${CUSTOM_API_MAX_DESCRIPTION} characters).`,
    );
    return null;
  }
  if (op.level !== "read" && op.level !== "draft" && op.level !== "write") {
    errors.push(`Operation "${op.id}": level must be read, draft, or write.`);
    return null;
  }
  // GET can never be classified above read (it must be side-effect free to
  // be retry-safe), and a non-GET is externally visible by construction, so
  // it can never hide below draft.
  if (method === "GET" && op.level !== "read") {
    errors.push(
      `Operation "${op.id}": GET operations are always level "read".`,
    );
    return null;
  }
  if (method !== "GET" && op.level === "read") {
    errors.push(
      `Operation "${op.id}": ${method} operations must be level "draft" or "write" — they can change data on the remote service.`,
    );
    return null;
  }
  const rawParams = Array.isArray(op.params) ? op.params : [];
  if (rawParams.length > CUSTOM_API_MAX_PARAMS) {
    errors.push(
      `Operation "${op.id}": at most ${CUSTOM_API_MAX_PARAMS} parameters are supported.`,
    );
    return null;
  }
  const params: CustomApiParam[] = [];
  const seen = new Set<string>();
  for (const rawParam of rawParams) {
    const param = validateParamSpec(rawParam, op.id, errors);
    if (!param) return null;
    const key = param.name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Operation "${op.id}": duplicate parameter "${param.name}".`);
      return null;
    }
    seen.add(key);
    if (param.in === "body" && (method === "GET" || method === "DELETE")) {
      errors.push(
        `Operation "${op.id}": ${method} operations cannot carry body parameters.`,
      );
      return null;
    }
    params.push(param);
  }
  // Path placeholders and declared path params must match exactly: an
  // undeclared placeholder could never render, and an unused path param is
  // an authoring mistake worth failing loudly on.
  const placeholders = new Set(
    [...path.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? ""),
  );
  if (path.includes("{") || path.includes("}")) {
    for (const raw of path.split(/[{}]/).filter((_, i) => i % 2 === 1)) {
      if (!PARAM_NAME_PATTERN.test(raw)) {
        errors.push(
          `Operation "${op.id}": path placeholder "{${raw}}" is not a valid parameter name.`,
        );
        return null;
      }
    }
    const braces = path.match(/[{}]/g) ?? [];
    let depth = 0;
    for (const brace of braces) {
      depth += brace === "{" ? 1 : -1;
      if (depth < 0 || depth > 1) {
        errors.push(`Operation "${op.id}": path has unbalanced braces.`);
        return null;
      }
    }
    if (depth !== 0) {
      errors.push(`Operation "${op.id}": path has unbalanced braces.`);
      return null;
    }
  }
  const declaredPathParams = new Set(
    params.filter((p) => p.in === "path").map((p) => p.name),
  );
  for (const placeholder of placeholders) {
    if (!declaredPathParams.has(placeholder)) {
      errors.push(
        `Operation "${op.id}": path placeholder "{${placeholder}}" has no matching path parameter.`,
      );
      return null;
    }
  }
  for (const name of declaredPathParams) {
    if (!placeholders.has(name)) {
      errors.push(
        `Operation "${op.id}": path parameter "${name}" does not appear in the path.`,
      );
      return null;
    }
  }
  return {
    id: op.id,
    method,
    path,
    description: op.description.trim(),
    level: op.level,
    params,
  };
}

/**
 * Validate a full owner-supplied definition into the one constrained shape
 * everything downstream trusts. Every rejection carries an actionable
 * message; nothing is silently coerced or dropped.
 */
export function normalizeCustomApiDefinition(input: {
  slug: unknown;
  displayName: unknown;
  description?: unknown;
  baseUrl: unknown;
  authType: unknown;
  authHeaderName?: unknown;
  operations: unknown;
}): NormalizeResult {
  const errors: string[] = [];
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!SLUG_PATTERN.test(slug)) {
    errors.push(
      "The identifier must be 2-40 lowercase letters, digits, or underscores, starting with a letter.",
    );
  }
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (
    displayName.length === 0 ||
    displayName.length > CUSTOM_API_MAX_DISPLAY_NAME ||
    hasControlChars(displayName)
  ) {
    errors.push(
      `A display name is required (max ${CUSTOM_API_MAX_DISPLAY_NAME} characters).`,
    );
  }
  let description = "";
  if (input.description !== undefined && input.description !== null) {
    if (
      typeof input.description !== "string" ||
      input.description.length > CUSTOM_API_MAX_DESCRIPTION ||
      hasControlChars(input.description)
    ) {
      errors.push(
        `The description must be plain text up to ${CUSTOM_API_MAX_DESCRIPTION} characters.`,
      );
    } else {
      description = input.description.trim();
    }
  }
  const baseUrlResult = validateBaseUrl(input.baseUrl);
  if (typeof baseUrlResult !== "string") errors.push(baseUrlResult.error);
  const authType = input.authType as CustomApiAuthType;
  if (!CUSTOM_API_AUTH_TYPES.includes(authType)) {
    errors.push("Authentication must be none, api_key, or bearer.");
  }
  let authHeaderName: string | null = null;
  if (authType === "api_key") {
    const header =
      typeof input.authHeaderName === "string"
        ? input.authHeaderName.trim()
        : "";
    if (!HEADER_NAME_PATTERN.test(header)) {
      errors.push(
        "API-key authentication needs a header name (letters, digits, hyphens).",
      );
    } else if (
      FORBIDDEN_AUTH_HEADERS.has(header.toLowerCase()) ||
      header.toLowerCase() === "authorization"
    ) {
      errors.push(
        `The header "${header}" is reserved; pick the vendor's API-key header (e.g. X-Api-Key). For Authorization: Bearer tokens, choose bearer authentication.`,
      );
    } else {
      authHeaderName = header;
    }
  } else if (
    input.authHeaderName !== undefined &&
    input.authHeaderName !== null &&
    input.authHeaderName !== ""
  ) {
    errors.push("A header name is only used with api_key authentication.");
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    errors.push("At least one operation is required.");
  } else if (input.operations.length > CUSTOM_API_MAX_OPERATIONS) {
    errors.push(
      `At most ${CUSTOM_API_MAX_OPERATIONS} operations are supported per API.`,
    );
  }
  const operations: CustomApiOperation[] = [];
  if (Array.isArray(input.operations)) {
    const seen = new Set<string>();
    for (const raw of input.operations.slice(0, CUSTOM_API_MAX_OPERATIONS)) {
      const op = validateOperation(raw, errors);
      if (!op) continue;
      if (seen.has(op.id)) {
        errors.push(`Duplicate operation id "${op.id}".`);
        continue;
      }
      seen.add(op.id);
      operations.push(op);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      slug,
      displayName,
      description,
      baseUrl: baseUrlResult as string,
      authType,
      authHeaderName,
      operations,
    },
  };
}

/** Validate a single draft operation (used by the OpenAPI import review). */
export function checkOperation(raw: unknown): {
  op: CustomApiOperation | null;
  errors: string[];
} {
  const errors: string[] = [];
  const op = validateOperation(raw, errors);
  return { op, errors };
}

/** Parse the operations jsonb from a stored row; null when malformed. */
export function parseStoredOperations(
  row: Pick<CustomApiConnectionRecord, "operations">,
): CustomApiOperation[] | null {
  if (!Array.isArray(row.operations)) return null;
  const errors: string[] = [];
  const parsed: CustomApiOperation[] = [];
  for (const raw of row.operations) {
    const op = validateOperation(raw, errors);
    if (!op) return null;
    parsed.push(op);
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Credential sealing (AES-256-GCM under SESSION_SECRET, own label)    */
/* ------------------------------------------------------------------ */

const CREDENTIAL_FORMAT = "v1";

function credentialKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error(
      "SESSION_SECRET is not set on this server, so an API credential cannot be stored securely.",
    );
  }
  return createHash("sha256")
    .update(`custom-api-credential:${secret}`)
    .digest();
}

export function validateCredentialInput(raw: unknown): string | { error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: "A credential value is required." };
  }
  const value = raw.trim();
  if (value.length > CUSTOM_API_MAX_CREDENTIAL_LENGTH) {
    return {
      error: `The credential must be at most ${CUSTOM_API_MAX_CREDENTIAL_LENGTH} characters.`,
    };
  }
  if (hasControlChars(value)) {
    return { error: "The credential must not contain control characters." };
  }
  return value;
}

export function encryptCustomApiCredential(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    CREDENTIAL_FORMAT,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64"),
  ].join(".");
}

export function decryptCustomApiCredential(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== CREDENTIAL_FORMAT || !iv || !tag || !sealed) {
    throw new Error(
      "The stored credential is not in a format this server understands. Rotate the credential.",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      credentialKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "The stored credential could not be decrypted (usually because SESSION_SECRET changed). Rotate the credential.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Capability-package synthesis                                        */
/* ------------------------------------------------------------------ */

export const CUSTOM_API_PACKAGE_PREFIX = "custom_";

export function customApiPackageId(slug: string): string {
  return `${CUSTOM_API_PACKAGE_PREFIX}${slug}`;
}

export function isCustomApiPackageId(packageId: string): boolean {
  return packageId.startsWith(CUSTOM_API_PACKAGE_PREFIX);
}

function paramSpecForTool(param: CustomApiParam): CapabilityParamSpec {
  return {
    name: param.name,
    required: param.required,
    kind: param.kind,
    ...(param.kind === "string"
      ? {
          maxLength:
            param.maxLength ??
            (param.in === "body"
              ? BODY_PARAM_MAX_LENGTH
              : DEFAULT_PARAM_MAX_LENGTH),
        }
      : {}),
    ...(param.multiline ? { multiline: true } : {}),
  };
}

function describeParamsForModel(params: CustomApiParam[]): string {
  if (params.length === 0) return "";
  const parts = params.map(
    (p) =>
      `${p.name} (${p.kind}${p.required ? ", required" : ""}${p.in === "path" ? ", in path" : p.in === "query" ? ", in query" : ", in body"})${p.description ? `: ${p.description}` : ""}`,
  );
  return ` Params: ${parts.join("; ")}.`;
}

/**
 * Resolve one stored row into an in-memory capability manifest. The
 * manifest's version IS the definition revision, so every resolved tool is
 * pinned to the exact definition the owner last reviewed. Returns null
 * (fail closed) when the stored operations no longer validate.
 */
export function manifestForCustomApi(
  row: CustomApiConnectionRecord,
): CapabilityManifest | null {
  const operations = parseStoredOperations(row);
  if (!operations || operations.length === 0) return null;
  if (!SLUG_PATTERN.test(row.slug)) return null;
  const packageId = customApiPackageId(row.slug);
  const tools: CapabilityToolDef[] = operations.map((op) => ({
    name: `${packageId}.${op.id}`,
    description: `${op.description} [${op.method} ${op.path} at ${row.baseUrl}]${describeParamsForModel(op.params)}`,
    level: op.level,
    params: op.params.map(paramSpecForTool),
    targetTemplate: `${row.displayName}: ${op.method} ${op.path}`,
    // Reads are idempotent by contract (GET only); everything else is an
    // external write with no provider-specific verifier, so an ambiguous
    // interruption settles as unknown and is never replayed.
    recovery: op.level === "read" ? "retry_safe" : "non_retryable",
    resultCharLimit: 4000,
    timeoutMs: 20_000,
    executor: {
      kind: "custom_api",
      connectionId: row.id,
      operationId: op.id,
    },
  }));
  return {
    id: packageId,
    displayName: row.displayName,
    version: row.revision,
    description: row.description || `Owner-whitelisted API at ${row.baseUrl}`,
    publisher: "workspace",
    connection: "none",
    skills: [],
    tools,
    builtin: false,
  };
}

/* ------------------------------------------------------------------ */
/* Workspace loaders                                                   */
/* ------------------------------------------------------------------ */

export async function listCustomApiConnections(
  workspaceId: string,
): Promise<CustomApiConnectionRecord[]> {
  return db
    .select()
    .from(customApiConnectionsTable)
    .where(eq(customApiConnectionsTable.workspaceId, workspaceId))
    .orderBy(customApiConnectionsTable.createdAt);
}

export async function getCustomApiConnection(
  workspaceId: string,
  id: string,
): Promise<CustomApiConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(customApiConnectionsTable)
    .where(
      and(
        eq(customApiConnectionsTable.id, id),
        eq(customApiConnectionsTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Enabled custom APIs of one workspace as capability manifests. Disabled
 * or malformed rows resolve to nothing at all: their tools disappear from
 * prompts, grants to them stop counting, and authorization denies them —
 * disabling an API blocks new calls immediately, everywhere.
 */
export async function listActiveCustomApiManifests(
  workspaceId: string,
): Promise<CapabilityManifest[]> {
  const rows = await db
    .select()
    .from(customApiConnectionsTable)
    .where(
      and(
        eq(customApiConnectionsTable.workspaceId, workspaceId),
        eq(customApiConnectionsTable.enabled, true),
      ),
    );
  const manifests: CapabilityManifest[] = [];
  for (const row of rows) {
    const manifest = manifestForCustomApi(row);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

/** Package ids of ALL custom APIs in a workspace (enabled or not). */
export async function listCustomApiPackageIds(
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ slug: customApiConnectionsTable.slug })
    .from(customApiConnectionsTable)
    .where(eq(customApiConnectionsTable.workspaceId, workspaceId));
  return new Set(rows.map((row) => customApiPackageId(row.slug)));
}
