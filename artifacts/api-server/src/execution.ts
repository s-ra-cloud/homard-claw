/**
 * Provider execution: one authorized chat-completion call per task attempt.
 *
 * Credentials are read from environment secrets at call time and never leave
 * this module. All failures surface as structured ProviderCallError values so
 * the worker can decide between retry, block, and fail — no silent fallbacks.
 */

export type ProviderCallErrorKind =
  | "not_configured"
  | "auth"
  | "rate_limit"
  /** Provider 5xx or a dropped/refused connection: worth another attempt. */
  | "transient"
  /** A subscription plan allowance is exhausted; money would be needed. */
  | "allowance"
  | "timeout"
  | "cancelled"
  | "provider_error";

/** Kinds the worker may retry with backoff; everything else is terminal. */
const RETRYABLE_KINDS: ReadonlySet<ProviderCallErrorKind> = new Set([
  "rate_limit",
  "transient",
]);

export class ProviderCallError extends Error {
  readonly kind: ProviderCallErrorKind;
  /**
   * Rate limits and transient outages are retryable with backoff. Auth
   * failures, allowance exhaustion, policy blocks, timeouts, and malformed
   * responses are not: repeating them would just burn attempts on a problem
   * that needs a human.
   */
  readonly retryable: boolean;

  constructor(kind: ProviderCallErrorKind, message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
  }
}

/**
 * Granular usage as the provider reported it. Every field is nullable:
 * a provider that does not expose a number must leave it null rather than
 * have one invented for it.
 */
export type ProviderUsageDetail = {
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
};

export type ProviderCallResult = {
  output: string;
  inputTokens: number;
  outputTokens: number;
  usageDetail?: ProviderUsageDetail;
  /** Provider-side conversation id, when the provider keeps threads. */
  threadId?: string | null;
};

/**
 * Coarse execution phase, surfaced to the office while a task runs. The
 * durable `status` column stays authoritative for the lifecycle.
 */
export type ProviderPhase =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "rate_limited"
  | "auth_required"
  | "failed"
  | "cancelled";

export type ProviderCallRequest = {
  provider: ProviderId;
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Codex reasoning effort; ignored by providers that have none. */
  reasoningEffort?: string | null;
  /** Resume this provider-side thread instead of starting a new one. */
  threadId?: string | null;
  /** Isolated working directory for providers that execute in a sandbox. */
  workingDirectory?: string | null;
  /** Agent trust inputs used to derive a restrictive sandbox. */
  sandbox?: {
    securityPreset: string;
    autonomy: string;
    /**
     * Persisted sensitive-data sandbox flag. When true it overrides the
     * preset/autonomy/environment combination and forces the strictest
     * available Codex sandbox: read-only, no network, no web search.
     */
    sensitiveDataSandbox?: boolean;
  } | null;
  onPhase?: (phase: ProviderPhase) => void | Promise<void>;
  onProgress?: (progress: { level: "info" | "warn" | "error"; message: string }) => void | Promise<void>;
  onThreadId?: (threadId: string) => void | Promise<void>;
};

/**
 * One provider, behind one contract.
 *
 * Start/continue, cancellation, streaming progress, final output, usage,
 * sanitized errors, and authentication status all go through the adapter,
 * so the worker never special-cases a provider. Claude Code and OpenRouter
 * keep their exact previous behavior; Codex adds thread continuity and
 * streamed progress on the same interface.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly billing: ProviderBilling;
  /** Whether a run may be attempted right now, and why not if it may not. */
  authStatus(): Promise<{ ready: boolean; message: string }>;
  execute(req: ProviderCallRequest): Promise<ProviderCallResult>;
}

/** Hard ceiling on a single completion, independent of budget. */
export const MAX_OUTPUT_TOKENS = 4096;

function credentialFor(provider: "claude_max" | "openrouter"): string {
  const env =
    provider === "claude_max"
      ? process.env.CLAUDE_CODE_OAUTH_TOKEN
      : process.env.OPENROUTER_API_KEY;
  if (!env || env.trim() === "") {
    throw new ProviderCallError(
      "not_configured",
      provider === "claude_max"
        ? "Claude is not configured. Add CLAUDE_CODE_OAUTH_TOKEN to run this task."
        : "OpenRouter is not configured. Add OPENROUTER_API_KEY to run this task.",
    );
  }
  return env;
}

/**
 * Provider response bodies are never persisted or surfaced: an error body
 * can echo request data (including Authorization material through proxies),
 * and errorMessage flows into durable logs and the UI. Status code only.
 */
function mapHttpError(status: number): ProviderCallError {
  if (status === 401 || status === 403) {
    return new ProviderCallError(
      "auth",
      "The provider rejected the stored credential. Re-check the configured secret.",
    );
  }
  if (status === 429) {
    return new ProviderCallError(
      "rate_limit",
      "The provider is rate limiting requests.",
    );
  }
  // 5xx means the provider itself is unhealthy (502/503 behind a load
  // balancer, 500 from an overloaded backend). Those clear on their own far
  // more often than not, so they are worth another attempt rather than a
  // failure the owner has to notice and retry by hand.
  if (status >= 500) {
    return new ProviderCallError(
      "transient",
      `The provider returned HTTP ${status}.`,
    );
  }
  return new ProviderCallError(
    "provider_error",
    `The provider returned HTTP ${status}.`,
  );
}

import { sanitizeErrorMessage } from "./lib/sanitize";
import {
  PROVIDER_BILLING,
  PROVIDER_LABELS,
  providerReadiness,
  type ProviderBilling,
  type ProviderId,
} from "./providers";
import { CodexRunError, codexSandboxFor, runCodexTurn } from "./codex/execute";

/**
 * Connection-level failures that say nothing about the request itself:
 * dropped or refused sockets, DNS hiccups, and undici's own connect/socket
 * timeouts. They are safe to repeat because the provider never processed
 * the call. The worker's deliberate per-call abort is NOT in here — that is
 * a `timeout`, and it stays terminal.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * `fetch` reports these as a generic TypeError with the real code buried on
 * the cause chain, so walk it. Returns the matching code, which is a fixed
 * identifier and therefore safe to persist verbatim.
 */
function transientNetworkCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function mapNetworkError(error: unknown, signal: AbortSignal): ProviderCallError {
  if (error instanceof Error && error.name === "AbortError") {
    // The worker aborts for the per-call timeout, an owner cancellation, or
    // a lost worker lease. Only the timeout is a task failure the current
    // process still owns; everything else must write no further state.
    return signal.reason === "timeout"
      ? new ProviderCallError("timeout", "The provider call timed out.")
      : new ProviderCallError("cancelled", "The call was aborted.");
  }
  const transientCode = transientNetworkCode(error);
  if (transientCode) {
    return new ProviderCallError(
      "transient",
      `The connection to the provider failed (${transientCode}).`,
    );
  }
  // Network/SDK error messages are arbitrary and can echo request material
  // (proxies sometimes include the failing request's headers). Scrub them
  // before they reach durable errorMessage/log/notification storage.
  return new ProviderCallError(
    "provider_error",
    error instanceof Error
      ? sanitizeErrorMessage(error.message)
      : "Unknown network error",
  );
}

async function callClaude(req: ProviderCallRequest): Promise<ProviderCallResult> {
  const token = credentialFor("claude_max");
  let res: globalThis.Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: req.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
  } catch (error) {
    throw mapNetworkError(error, req.signal);
  }
  if (!res.ok) throw mapHttpError(res.status);
  let payload: {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new ProviderCallError("provider_error", "Claude returned a malformed response.");
  }
  const output = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (!output) {
    throw new ProviderCallError("provider_error", "Claude returned no text output.");
  }
  return {
    output,
    inputTokens: Math.max(0, Math.round(payload.usage?.input_tokens ?? 0)),
    outputTokens: Math.max(0, Math.round(payload.usage?.output_tokens ?? 0)),
  };
}

async function callOpenRouter(req: ProviderCallRequest): Promise<ProviderCallResult> {
  const key = credentialFor("openrouter");
  let res: globalThis.Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: req.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      }),
    });
  } catch (error) {
    throw mapNetworkError(error, req.signal);
  }
  if (!res.ok) throw mapHttpError(res.status);
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new ProviderCallError("provider_error", "OpenRouter returned a malformed response.");
  }
  const output = payload.choices?.[0]?.message?.content;
  if (typeof output !== "string" || output === "") {
    throw new ProviderCallError("provider_error", "OpenRouter returned no text output.");
  }
  return {
    output,
    inputTokens: Math.max(0, Math.round(payload.usage?.prompt_tokens ?? 0)),
    outputTokens: Math.max(0, Math.round(payload.usage?.completion_tokens ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const claudeAdapter: ProviderAdapter = {
  id: "claude_max",
  label: PROVIDER_LABELS.claude_max,
  billing: PROVIDER_BILLING.claude_max,
  authStatus: () => providerReadiness("claude_max"),
  execute: callClaude,
};

const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  label: PROVIDER_LABELS.openrouter,
  billing: PROVIDER_BILLING.openrouter,
  authStatus: () => providerReadiness("openrouter"),
  execute: callOpenRouter,
};

/** Codex failure kinds map one-to-one onto the shared error contract. */
function toCallError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof CodexRunError) {
    return new ProviderCallError(error.kind, error.message);
  }
  if (error instanceof Error && error.name === "CodexRuntimeError") {
    const kind = (error as { kind?: string }).kind;
    return new ProviderCallError(
      kind === "auth" || kind === "api_key_auth" ? "auth" : "not_configured",
      sanitizeErrorMessage(error.message),
    );
  }
  return new ProviderCallError(
    "provider_error",
    error instanceof Error
      ? sanitizeErrorMessage(error.message)
      : "Unknown provider error",
  );
}

const codexAdapter: ProviderAdapter = {
  id: "codex_chatgpt",
  label: PROVIDER_LABELS.codex_chatgpt,
  billing: PROVIDER_BILLING.codex_chatgpt,
  authStatus: () => providerReadiness("codex_chatgpt"),
  async execute(req) {
    if (!req.workingDirectory) {
      throw new ProviderCallError(
        "not_configured",
        "Codex needs an isolated working directory, and none was prepared for this task.",
      );
    }
    try {
      const result = await runCodexTurn({
        system: req.system,
        prompt: req.prompt,
        model: req.model,
        reasoningEffort: req.reasoningEffort ?? "medium",
        workingDirectory: req.workingDirectory,
        threadId: req.threadId ?? null,
        sandbox: codexSandboxFor({
          securityPreset: req.sandbox?.securityPreset ?? "observer",
          autonomy: req.sandbox?.autonomy ?? "supervised",
          allowNetwork: process.env.CODEX_ALLOW_NETWORK === "true",
          // Missing sandbox inputs fail closed to isolated.
          sensitiveDataSandbox: req.sandbox?.sensitiveDataSandbox ?? true,
        }),
        signal: req.signal,
        onThreadId: req.onThreadId,
        onPhase: (phase) => req.onPhase?.(phase),
        onProgress: req.onProgress,
      });
      return {
        output: result.output,
        // Total input tokens include the cached portion; both are recorded
        // separately below so nothing is double-counted downstream.
        inputTokens: Math.max(0, Math.round(result.usage?.input_tokens ?? 0)),
        outputTokens: Math.max(0, Math.round(result.usage?.output_tokens ?? 0)),
        usageDetail: {
          cachedInputTokens: result.usage?.cached_input_tokens ?? null,
          cacheWriteInputTokens: result.usage?.cache_write_input_tokens ?? null,
          reasoningOutputTokens: result.usage?.reasoning_output_tokens ?? null,
        },
        threadId: result.threadId,
      };
    } catch (error) {
      throw toCallError(error);
    }
  },
};

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude_max: claudeAdapter,
  codex_chatgpt: codexAdapter,
  openrouter: openrouterAdapter,
};

export function getProviderAdapter(provider: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new ProviderCallError(
      "not_configured",
      `Unknown provider "${provider}".`,
    );
  }
  return adapter;
}

export async function callProvider(
  req: ProviderCallRequest,
): Promise<ProviderCallResult> {
  return getProviderAdapter(req.provider).execute(req);
}
