/**
 * Bounded OpenAPI import for custom APIs. Turns a pasted OpenAPI 3.x JSON
 * document into DRAFT operations in the same constrained format manual
 * entry produces. Nothing here is persisted: the owner reviews (and can
 * edit) every proposed operation before saving. Unsupported constructs are
 * skipped with a warning, never guessed at.
 */

import {
  CUSTOM_API_MAX_DESCRIPTION,
  CUSTOM_API_MAX_OPERATIONS,
  validateBaseUrl,
  type CustomApiMethod,
  type CustomApiOperation,
  type CustomApiParam,
} from "./custom-apis";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const IMPORT_METHODS: CustomApiMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

export type ParsedSpec = {
  operations: CustomApiOperation[];
  warnings: string[];
  suggestedBaseUrl: string | null;
  suggestedName: string | null;
};

export type ParseSpecResult =
  | { ok: true; value: ParsedSpec }
  | { ok: false; error: string };

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

function toOperationId(raw: string): string {
  const cleaned = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 60);
  if (/^[a-z][a-z0-9_]*$/.test(cleaned)) return cleaned;
  return `op_${cleaned}`.slice(0, 60).replace(/_+$/g, "");
}

function paramKind(schema: unknown): "string" | "number" {
  if (schema && typeof schema === "object") {
    const type = (schema as Record<string, unknown>).type;
    if (type === "number" || type === "integer") return "number";
  }
  return "string";
}

/**
 * Parse a pasted OpenAPI 3.x JSON document into draft operations. YAML is
 * deliberately not parsed server-side; the error tells the owner to paste
 * the JSON form instead of silently mis-reading the document.
 */
export function parseOpenApiDocument(documentText: string): ParseSpecResult {
  if (typeof documentText !== "string" || documentText.trim().length === 0) {
    return { ok: false, error: "Paste an OpenAPI document to import." };
  }
  if (Buffer.byteLength(documentText, "utf8") > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: "The document is larger than 512 KB. Trim it to the endpoints you need.",
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(documentText);
  } catch {
    return {
      ok: false,
      error:
        "The document is not valid JSON. If you have a YAML OpenAPI file, convert it to JSON first (most tools export both), then paste the JSON.",
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "The document is not an OpenAPI object." };
  }
  const spec = doc as Record<string, unknown>;
  const version = typeof spec.openapi === "string" ? spec.openapi : null;
  if (!version || !version.startsWith("3.")) {
    return {
      ok: false,
      error:
        spec.swagger !== undefined
          ? "Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3 JSON and try again."
          : "Only OpenAPI 3.x JSON documents are supported (missing \"openapi\": \"3.x\").",
    };
  }
  const warnings: string[] = [];
  let suggestedBaseUrl: string | null = null;
  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    const first = spec.servers[0] as Record<string, unknown> | null;
    const url = first && typeof first.url === "string" ? first.url : null;
    if (url) {
      const validated = validateBaseUrl(url);
      if (typeof validated === "string") suggestedBaseUrl = validated;
      else {
        warnings.push(
          `The document's server URL (${cleanText(url, 100)}) was not usable: ${validated.error}`,
        );
      }
    }
  }
  const info = spec.info as Record<string, unknown> | undefined;
  const suggestedName =
    info && typeof info.title === "string"
      ? cleanText(info.title, 80) || null
      : null;
  const paths = spec.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return { ok: false, error: "The document has no paths to import." };
  }
  const operations: CustomApiOperation[] = [];
  const seenIds = new Set<string>();
  let skippedOverCap = 0;
  for (const [rawPath, rawItem] of Object.entries(
    paths as Record<string, unknown>,
  )) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const pathItem = rawItem as Record<string, unknown>;
    const sharedParams = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];
    for (const method of IMPORT_METHODS) {
      const rawOp = pathItem[method.toLowerCase()];
      if (!rawOp || typeof rawOp !== "object") continue;
      if (operations.length >= CUSTOM_API_MAX_OPERATIONS) {
        skippedOverCap += 1;
        continue;
      }
      const op = rawOp as Record<string, unknown>;
      const label = `${method} ${rawPath}`;
      if (typeof rawPath !== "string" || !rawPath.startsWith("/")) {
        warnings.push(`Skipped ${label}: the path must start with "/".`);
        continue;
      }
      const params: CustomApiParam[] = [];
      let unsupported: string | null = null;
      const allParams = [
        ...sharedParams,
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      for (const rawParam of allParams) {
        if (!rawParam || typeof rawParam !== "object") continue;
        const p = rawParam as Record<string, unknown>;
        if (p.$ref !== undefined) {
          unsupported = "it uses $ref parameters (inline them first)";
          break;
        }
        const location = p.in;
        if (location === "header" || location === "cookie") {
          unsupported = `it declares a ${String(location)} parameter, which custom APIs do not support`;
          break;
        }
        if (location !== "path" && location !== "query") continue;
        if (typeof p.name !== "string") continue;
        params.push({
          name: p.name,
          in: location,
          kind: paramKind(p.schema),
          required: location === "path" ? true : p.required === true,
          ...(typeof p.description === "string"
            ? {
                description: cleanText(
                  p.description,
                  CUSTOM_API_MAX_DESCRIPTION,
                ),
              }
            : {}),
        });
      }
      if (unsupported) {
        warnings.push(`Skipped ${label}: ${unsupported}.`);
        continue;
      }
      // Request body: only a flat application/json object schema imports.
      const requestBody = op.requestBody as Record<string, unknown> | undefined;
      if (requestBody && method !== "GET" && method !== "DELETE") {
        const content = requestBody.content as
          | Record<string, unknown>
          | undefined;
        const json = content?.["application/json"] as
          | Record<string, unknown>
          | undefined;
        const schema = json?.schema as Record<string, unknown> | undefined;
        if (!schema || schema.$ref !== undefined || schema.type !== "object") {
          warnings.push(
            `${label}: the request body schema could not be imported automatically — add body parameters manually if needed.`,
          );
        } else {
          const required = new Set(
            Array.isArray(schema.required)
              ? schema.required.filter((r) => typeof r === "string")
              : [],
          );
          const properties = (schema.properties ?? {}) as Record<
            string,
            unknown
          >;
          for (const [name, propSchema] of Object.entries(properties)) {
            const prop = propSchema as Record<string, unknown> | null;
            const type = prop && typeof prop === "object" ? prop.type : null;
            if (type !== "string" && type !== "number" && type !== "integer") {
              warnings.push(
                `${label}: body field "${name}" is not a plain string/number and was skipped.`,
              );
              continue;
            }
            params.push({
              name,
              in: "body",
              kind: type === "string" ? "string" : "number",
              required: required.has(name),
              ...(type === "string" ? { multiline: true } : {}),
              ...(prop && typeof prop.description === "string"
                ? {
                    description: cleanText(
                      prop.description,
                      CUSTOM_API_MAX_DESCRIPTION,
                    ),
                  }
                : {}),
            });
          }
        }
      } else if (requestBody) {
        warnings.push(
          `Skipped ${label}: ${method} operations cannot carry a request body here.`,
        );
        continue;
      }
      const baseId =
        typeof op.operationId === "string" && op.operationId.trim() !== ""
          ? toOperationId(op.operationId)
          : toOperationId(`${method} ${rawPath}`);
      let id = baseId || "operation";
      let suffix = 2;
      while (seenIds.has(id)) {
        // Reserve room for the suffix BEFORE appending it: truncating the
        // combined string back to the cap would strip the suffix again and
        // spin this loop forever once two long ids share a 60-char prefix.
        const tail = `_${suffix++}`;
        id = `${(baseId || "operation").slice(0, 60 - tail.length)}${tail}`;
      }
      seenIds.add(id);
      const description =
        cleanText(op.summary, CUSTOM_API_MAX_DESCRIPTION) ||
        cleanText(op.description, CUSTOM_API_MAX_DESCRIPTION) ||
        `${method} ${cleanText(rawPath, 150)}`;
      operations.push({
        id,
        method,
        path: rawPath,
        description,
        // Conservative defaults: reads are reads; anything else is a full
        // write until the owner explicitly downgrades it to draft.
        level: method === "GET" ? "read" : "write",
        params,
      });
    }
  }
  if (skippedOverCap > 0) {
    warnings.push(
      `Only the first ${CUSTOM_API_MAX_OPERATIONS} operations were imported; ${skippedOverCap} more were skipped. Remove the ones you do not need and add others manually.`,
    );
  }
  if (operations.length === 0) {
    return {
      ok: false,
      error:
        warnings.length > 0
          ? `No operations could be imported. ${warnings.join(" ")}`
          : "No importable operations were found in the document.",
    };
  }
  return {
    ok: true,
    value: { operations, warnings, suggestedBaseUrl, suggestedName },
  };
}
