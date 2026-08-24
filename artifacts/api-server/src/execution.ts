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
  | "timeout"
  | "cancelled"
  | "provider_error";

export class ProviderCallError extends Error {
  readonly kind: ProviderCallErrorKind;
  /** Rate limits are retryable with backoff; everything else is terminal. */
  readonly retryable: boolean;

  constructor(kind: ProviderCallErrorKind, message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.retryable = kind === "rate_limit";
  }
}

export type ProviderCallResult = {
  output: string;
  inputTokens: number;
  outputTokens: number;
};

export type ProviderCallRequest = {
  provider: "claude_max" | "openrouter";
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};

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
  return new ProviderCallError(
    "provider_error",
    `The provider returned HTTP ${status}.`,
  );
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
  return new ProviderCallError(
    "provider_error",
    error instanceof Error ? error.message : "Unknown network error",
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

export async function callProvider(
  req: ProviderCallRequest,
): Promise<ProviderCallResult> {
  return req.provider === "claude_max" ? callClaude(req) : callOpenRouter(req);
}
