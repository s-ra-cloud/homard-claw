import { logger } from "../lib/logger";
import type { CapabilityMcpServer } from "./manifest";

/**
 * The MCP transport boundary: a minimal JSON-RPC-over-HTTPS client for
 * approved remote MCP servers. Constraints, all deliberate:
 * - HTTPS only; the endpoint and optional bearer token come from server env
 *   referenced by name in the manifest — credentials never appear in
 *   manifests, prompts, action rows, or error messages.
 * - No package code, no child processes, no stdio servers.
 * - Every call is bounded by a timeout and a result character cap, and
 *   failures are sanitized before anything reaches a model or the UI.
 */

export type McpEndpoint = {
  url: string;
  token: string | null;
};

export class McpConfigError extends Error {}

/** Resolve the env-referenced endpoint. Returns null when unconfigured. */
export function resolveMcpEndpoint(
  server: CapabilityMcpServer | undefined,
): McpEndpoint | null {
  if (!server) return null;
  const url = process.env[server.urlEnv]?.trim();
  if (!url) return null;
  if (!/^https:\/\//i.test(url)) {
    throw new McpConfigError(
      `The MCP endpoint in ${server.urlEnv} must be an https:// URL.`,
    );
  }
  const token = server.authTokenEnv
    ? (process.env[server.authTokenEnv]?.trim() ?? null)
    : null;
  return { url, token: token || null };
}

type JsonRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; message: string };

let rpcSeq = 0;

/** One JSON-RPC request. Accepts plain JSON or SSE-framed responses. */
async function mcpRpc(
  endpoint: McpEndpoint,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<JsonRpcResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcSeq,
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `The capability server rejected the request (HTTP ${response.status}).`,
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await response.text();
    let payload: unknown;
    if (contentType.includes("text/event-stream")) {
      // Streamable HTTP: take the last data: frame carrying our response.
      let last: string | null = null;
      for (const line of bodyText.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) last = trimmed.slice(5).trim();
      }
      if (!last) {
        return { ok: false, message: "The capability server sent an empty stream." };
      }
      payload = JSON.parse(last);
    } else {
      payload = JSON.parse(bodyText);
    }
    const rpc = payload as {
      result?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    if (rpc.error) {
      // The remote error text is untrusted and is NOT forwarded: error
      // strings are a prompt-injection channel too. Code only, for triage.
      const code =
        typeof rpc.error.code === "number" ? ` (code ${rpc.error.code})` : "";
      logger.warn({ method, error: rpc.error }, "MCP server returned an error");
      return {
        ok: false,
        message: `The capability server rejected this call${code}.`,
      };
    }
    return { ok: true, result: rpc.result };
  } catch (error) {
    // Sanitized: no URL, no token, no stack — those belong to the server log.
    logger.warn({ method, error }, "MCP call failed");
    const aborted =
      error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      message: aborted
        ? "The capability server did not answer within the time limit."
        : "The capability server could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export type McpRemoteTool = {
  name: string;
  description: string | null;
};

/** Discover the remote server's advertised tools (health + drift checks). */
export async function mcpListTools(
  endpoint: McpEndpoint,
  timeoutMs = 10_000,
): Promise<{ ok: true; tools: McpRemoteTool[] } | { ok: false; message: string }> {
  const outcome = await mcpRpc(endpoint, "tools/list", {}, timeoutMs);
  if (!outcome.ok) return outcome;
  const raw = (outcome.result as { tools?: unknown })?.tools;
  if (!Array.isArray(raw)) {
    return { ok: false, message: "The capability server sent an invalid tool list." };
  }
  const tools: McpRemoteTool[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      const t = item as { name: string; description?: unknown };
      tools.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : null,
      });
    }
  }
  return { ok: true, tools };
}

/** Strip control characters so tool output cannot smuggle terminal tricks. */
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Call one remote tool with bounded output. The returned text is UNTRUSTED
 * EXTERNAL DATA by contract — callers feed it to models only inside the
 * untrusted-content framing the apps prompt already establishes.
 */
export async function mcpCallTool(
  endpoint: McpEndpoint,
  remoteName: string,
  args: Record<string, unknown>,
  options: { timeoutMs: number; charLimit: number },
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const outcome = await mcpRpc(
    endpoint,
    "tools/call",
    { name: remoteName, arguments: args },
    options.timeoutMs,
  );
  if (!outcome.ok) return outcome;
  const result = outcome.result as {
    isError?: unknown;
    content?: unknown;
  } | null;
  const parts: string[] = [];
  if (result && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        parts.push((item as { text: string }).text);
      }
    }
  }
  const text = sanitizeText(parts.join("\n").trim());
  if (result?.isError === true) {
    // Do not forward the remote error text to the model or UI — it is
    // untrusted content. It goes to the server log only.
    logger.warn({ remoteName }, "MCP tool reported an error result");
    return {
      ok: false,
      message: "The tool reported an error and returned no usable result.",
    };
  }
  const bounded =
    text.length > options.charLimit
      ? `${text.slice(0, options.charLimit)}\n[truncated: the tool returned more than ${options.charLimit} characters]`
      : text;
  return { ok: true, text: bounded || "(the tool returned no text content)" };
}
