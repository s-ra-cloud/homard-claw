import {
  executeOperation,
  type ExecutionOutcome,
} from "../connected-apps/connections";
import { mcpCallTool, McpConfigError, resolveMcpEndpoint } from "./mcp";
import type { ResolvedCapabilityTool } from "./service";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_RESULT_CHARS = 4_000;

/**
 * Execute one resolved capability tool. Built-in tools run through the
 * existing vetted executors (idempotency markers, OAuth transport, result
 * caps) exactly as before; MCP tools run through the bounded HTTPS client.
 * Either way the caller has already authorized the request against current
 * grants, sandbox state, and workspace enablement — this layer only carries
 * it out and returns a bounded, untrusted-by-contract result.
 */
export async function executeCapabilityTool(
  tool: ResolvedCapabilityTool,
  params: Record<string, unknown>,
  context: { actionId: string; workspaceId: string | null },
): Promise<ExecutionOutcome> {
  if (tool.def.executor.kind === "builtin") {
    if (!tool.builtinOp) {
      return {
        ok: false,
        kind: "failed",
        message: "This built-in operation is no longer available.",
      };
    }
    return executeOperation(tool.builtinOp, params, context);
  }
  let endpoint;
  try {
    endpoint = resolveMcpEndpoint(tool.manifest.mcpServer);
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      message:
        error instanceof McpConfigError
          ? error.message
          : "The capability server is misconfigured.",
    };
  }
  if (!endpoint) {
    return {
      ok: false,
      kind: "failed",
      message: `The ${tool.packageDisplayName} package is not connected: its server endpoint is not configured on this deployment.`,
    };
  }
  const outcome = await mcpCallTool(endpoint, tool.def.executor.remoteName, params, {
    timeoutMs: tool.def.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    charLimit: tool.def.resultCharLimit ?? DEFAULT_MCP_RESULT_CHARS,
  });
  if (!outcome.ok) return { ok: false, kind: "failed", message: outcome.message };
  return { ok: true, summary: outcome.text };
}
