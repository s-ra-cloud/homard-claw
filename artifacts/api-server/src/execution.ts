import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ANTHROPIC_MESSAGES_URL,
  claudeOAuthHeaders,
  claudeSystemBlocks,
  classifyClaudeAuthFailure,
  readClaudeErrorInfo,
} from "./claude-oauth";

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
  /**
   * Worth another attempt: provider 5xx, a dropped/refused connection, or a
   * completion the provider abandoned mid-generation (upstream error, or the
   * whole token budget consumed before any visible text).
   */
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
   * Optional owner-facing explanation composed entirely by this server.
   * Upstream response bodies must never be copied here because they can echo
   * request content or credentials.
   */
  readonly userMessage: string | null;
  /**
   * Rate limits and transient outages are retryable with backoff. Auth
   * failures, allowance exhaustion, policy blocks, timeouts, and malformed
   * responses are not: repeating them would just burn attempts on a problem
   * that needs a human.
   */
  readonly retryable: boolean;

  /**
   * Whether the provider's model turn had started when the failure
   * surfaced. `false` is positive evidence nothing ran (no allowance was
   * spent); `null` means unknown and must be treated as "may have run".
   */
  turnStarted: boolean | null = null;

  constructor(
    kind: ProviderCallErrorKind,
    message: string,
    userMessage: string | null = null,
  ) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.userMessage = userMessage;
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

export type InputAttachment = {
  name: string;
  mimeType: string;
  encoding: "text" | "base64";
  content: string;
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
  /**
   * The workspace whose stored credential (and allowance) pays for this
   * call. Always the durable owner of the work — the task's or agent's
   * workspace — never anything a client supplied directly.
   */
  workspaceId: string;
  /**
   * The account the run executes (and bills) as, for account-scoped
   * providers such as Codex. Resolved server-side by the caller — the
   * worker or Talk — from the workspace row at the same moment it derives
   * the credential lease key, so the lease and the run can never disagree
   * about whose session is being spent. Never taken from client input.
   */
  clerkUserId?: string | null;
  provider: ProviderId;
  model: string;
  system: string;
  prompt: string;
  attachments?: InputAttachment[];
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
  authStatus(workspaceId: string): Promise<{ ready: boolean; message: string }>;
  execute(req: ProviderCallRequest): Promise<ProviderCallResult>;
}

/** Hard ceiling on a single completion, independent of budget. */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * Resolve the credential the CALLING WORKSPACE stored for this provider.
 * There is deliberately no environment fallback: a workspace without its
 * own credential fails closed with a clear configuration error instead of
 * quietly spending someone else's allowance.
 */
async function credentialFor(
  workspaceId: string,
  provider: "claude_max" | "openrouter",
): Promise<string> {
  let stored: string | null;
  try {
    stored = await getProviderCredential(workspaceId, provider);
  } catch (error) {
    if (error instanceof ProviderCredentialError) {
      throw new ProviderCallError(
        error.kind === "reenter_required" ? "auth" : "not_configured",
        error.message,
      );
    }
    throw error;
  }
  if (!stored) {
    throw new ProviderCallError(
      "not_configured",
      provider === "claude_max"
        ? "Claude Code is not configured for this workspace. Add your Claude Code OAuth token on the Providers page to run this task."
        : "OpenRouter is not configured for this workspace. Add your OpenRouter API key on the Providers page to run this task.",
    );
  }
  return stored;
}

/**
 * Provider response bodies are never persisted or surfaced: an error body
 * can echo request data (including Authorization material through proxies),
 * and errorMessage flows into durable logs and the UI. Status code only.
 */
function mapHttpError(
  status: number,
  provider: "Claude" | "OpenRouter",
): ProviderCallError {
  if (status === 401 || status === 403) {
    // Claude 401/403s never reach here: callClaude classifies them first
    // (via the shared claude-oauth classifier, which inspects but never
    // quotes the response body) so owners can tell a bad token from a
    // stale Claude Code protocol emulation.
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
  if (status === 402) {
    return new ProviderCallError(
      "allowance",
      `${provider} returned HTTP 402.`,
      `${provider} reports that this account has insufficient credits or allowance. Check the provider account, then resend.`,
    );
  }
  if (provider === "OpenRouter" && status === 404) {
    return new ProviderCallError(
      "provider_error",
      "OpenRouter returned HTTP 404.",
      "OpenRouter could not find an available endpoint for the selected model and request (HTTP 404). Choose another OpenRouter model; attached files can also limit which endpoints are eligible.",
    );
  }
  if (status === 400 || status === 422) {
    return new ProviderCallError(
      "provider_error",
      `${provider} returned HTTP ${status}.`,
      `${provider} rejected this request (HTTP ${status}). Check the selected model and attached file types, then resend.`,
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
  getProviderCredential,
  ProviderCredentialError,
} from "./provider-credentials";
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

function textAttachmentBlock(attachment: InputAttachment): string {
  return `\n\n--- ATTACHED DOCUMENT: ${attachment.name} (${attachment.mimeType}) ---\n${attachment.content}\n--- END ATTACHMENT ---`;
}

function claudeContent(prompt: string, attachments: InputAttachment[] = []): unknown {
  if (attachments.length === 0) return prompt;
  const blocks: unknown[] = [{ type: "text", text: prompt }];
  for (const attachment of attachments) {
    if (attachment.encoding === "text") {
      blocks.push({ type: "text", text: textAttachmentBlock(attachment) });
    } else if (attachment.mimeType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.content },
        title: attachment.name,
      });
    } else {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.content },
      });
    }
  }
  return blocks;
}

function openRouterContent(prompt: string, attachments: InputAttachment[] = []): unknown {
  if (attachments.length === 0) return prompt;
  const parts: unknown[] = [{ type: "text", text: prompt }];
  for (const attachment of attachments) {
    if (attachment.encoding === "text") {
      parts.push({ type: "text", text: textAttachmentBlock(attachment) });
    } else if (attachment.mimeType === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: attachment.name,
          file_data: `data:${attachment.mimeType};base64,${attachment.content}`,
        },
      });
    } else {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mimeType};base64,${attachment.content}` },
      });
    }
  }
  return parts;
}

async function materializeCodexAttachments(
  workingDirectory: string,
  attachments: InputAttachment[] = [],
): Promise<{ promptSuffix: string }> {
  if (attachments.length === 0) return { promptSuffix: "" };
  const folder = path.join(workingDirectory, ".homardclaw-attachments");
  await mkdir(folder, { recursive: true });
  const paths: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || `file-${index + 1}`;
    const relative = `.homardclaw-attachments/${index + 1}-${safeName}`;
    await writeFile(
      path.join(workingDirectory, relative),
      attachment.encoding === "base64"
        ? Buffer.from(attachment.content, "base64")
        : attachment.content,
    );
    paths.push(`${attachment.name}: ${relative}`);
  }
  return {
    promptSuffix: `\n\nThe owner attached these files inside your private workspace. Read or inspect them as part of the request:\n${paths.join("\n")}`,
  };
}

async function callClaude(req: ProviderCallRequest): Promise<ProviderCallResult> {
  const token = await credentialFor(req.workspaceId, "claude_max");
  let res: globalThis.Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: req.signal,
      // The same header builder the health check uses: a token that passed
      // configuration is guaranteed to be presented identically here.
      headers: claudeOAuthHeaders(token),
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        // OAuth requests must open with the Claude Code identity block;
        // the task's real system prompt follows as its own block.
        system: claudeSystemBlocks(req.system),
        messages: [{ role: "user", content: claudeContent(req.prompt, req.attachments) }],
      }),
    });
  } catch (error) {
    throw mapNetworkError(error, req.signal);
  }
  if (res.status === 401 || res.status === 403) {
    // Same classifier the health probe uses: the error body is inspected
    // only to choose between fixed explanations (bad token value, expired
    // token, or Anthropic refusing the app's Claude Code emulation) and
    // is never copied into the error, task record, or logs.
    const failure = classifyClaudeAuthFailure(
      res.status,
      await readClaudeErrorInfo(res),
    );
    throw new ProviderCallError("auth", failure.message);
  }
  if (!res.ok) throw mapHttpError(res.status, "Claude");
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

/** Shape-tolerant view of one OpenRouter completion choice. */
type OpenRouterChoice = {
  finish_reason?: unknown;
  error?: unknown;
  message?: { content?: unknown; reasoning?: unknown } | null;
};

/**
 * OpenRouter's OpenAI-compatible schema allows `message.content` to be a
 * plain string or an array of typed parts (some upstream providers answer
 * multimodal requests that way). Extract every supported text
 * representation; a non-text shape yields null so the caller can classify
 * WHY the completion carried no text instead of guessing.
 */
function openRouterTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return null;
}

/**
 * Only finish reasons from OpenRouter's documented normalized set may be
 * persisted; anything else is an arbitrary provider string and is reduced
 * to "unknown" before it can reach durable errorMessage storage.
 */
const OPENROUTER_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content_filter",
  "error",
  "tool_calls",
]);

function openRouterFinishReason(choice: OpenRouterChoice): string {
  const raw = choice.finish_reason;
  return typeof raw === "string" && OPENROUTER_FINISH_REASONS.has(raw)
    ? raw
    : "unknown";
}

/**
 * OpenRouter can deliver a failure as HTTP 200 with an `error` object in
 * the body (e.g. moderation blocks, upstream failures discovered after
 * headers were sent). Its `code` mirrors HTTP status semantics, so a valid
 * numeric code reuses the exact status classification — auth, rate limit,
 * allowance, transient — the worker already retries or blocks on. The
 * provider's error MESSAGE is deliberately ignored: it can echo the prompt
 * or request material, and our messages flow into durable task records.
 */
function openRouterBodyError(code: unknown): ProviderCallError {
  const numeric =
    typeof code === "number" && Number.isInteger(code) ? code : null;
  if (numeric !== null && numeric >= 400 && numeric <= 599) {
    return mapHttpError(numeric, "OpenRouter");
  }
  return new ProviderCallError(
    "provider_error",
    numeric !== null
      ? `OpenRouter reported error code ${numeric}.`
      : "OpenRouter reported an error for this request.",
    "OpenRouter reported an error while handling this request. Check the selected model and attached file types, then resend.",
  );
}

async function callOpenRouter(req: ProviderCallRequest): Promise<ProviderCallResult> {
  const key = await credentialFor(req.workspaceId, "openrouter");
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
          { role: "user", content: openRouterContent(req.prompt, req.attachments) },
        ],
      }),
    });
  } catch (error) {
    throw mapNetworkError(error, req.signal);
  }
  if (!res.ok) throw mapHttpError(res.status, "OpenRouter");
  let payload: {
    error?: unknown;
    choices?: OpenRouterChoice[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new ProviderCallError("provider_error", "OpenRouter returned a malformed response.");
  }
  if (payload.error && typeof payload.error === "object") {
    throw openRouterBodyError((payload.error as { code?: unknown }).code);
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!choice || typeof choice !== "object") {
    throw new ProviderCallError(
      "provider_error",
      "OpenRouter returned no completion choices.",
      "OpenRouter answered without any completion. Resend the task, or choose a different OpenRouter model if this repeats.",
    );
  }
  const finishReason = openRouterFinishReason(choice);
  if (choice.error && typeof choice.error === "object") {
    // A choice-level error means the upstream model failed mid-generation.
    // Like a 5xx, that says nothing about the request itself and usually
    // clears on its own, so it is worth another attempt.
    throw new ProviderCallError(
      "transient",
      "The OpenRouter upstream provider failed while generating this completion.",
    );
  }
  const output = openRouterTextContent(choice.message?.content ?? null);
  if (typeof output === "string" && output !== "") {
    return {
      output,
      inputTokens: Math.max(0, Math.round(payload.usage?.prompt_tokens ?? 0)),
      outputTokens: Math.max(0, Math.round(payload.usage?.completion_tokens ?? 0)),
    };
  }
  // No usable text. Classify why, so the worker can retry what is worth
  // retrying and the owner can act on what is not.
  if (finishReason === "length") {
    // The whole output budget was consumed (reasoning models often spend it
    // all before the first visible token). Generation is nondeterministic,
    // so a retry under the worker's existing backoff frequently succeeds.
    throw new ProviderCallError(
      "transient",
      "OpenRouter hit the output token limit before producing any text (finish reason: length).",
      "The model spent its entire output budget before writing any text. This is retried automatically; if it keeps happening, choose a different OpenRouter model.",
    );
  }
  if (finishReason === "content_filter") {
    throw new ProviderCallError(
      "provider_error",
      "OpenRouter withheld this completion (finish reason: content_filter).",
      "The provider's content filter withheld the reply. Rephrase the objective or choose a different OpenRouter model.",
    );
  }
  if (finishReason === "tool_calls") {
    throw new ProviderCallError(
      "provider_error",
      "OpenRouter returned a tool call instead of text (finish reason: tool_calls).",
      "The selected model answered with a tool call, which tasks cannot execute. Choose an OpenRouter model that replies in plain text.",
    );
  }
  const reasoning = choice.message?.reasoning;
  const reasoningOnly = typeof reasoning === "string" && reasoning.trim() !== "";
  throw new ProviderCallError(
    "provider_error",
    reasoningOnly
      ? `OpenRouter returned only reasoning output and no final text (finish reason: ${finishReason}).`
      : `OpenRouter returned no text output (finish reason: ${finishReason}).`,
    "The model finished without producing any text. Resend the task, or choose a different OpenRouter model if this repeats.",
  );
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const claudeAdapter: ProviderAdapter = {
  id: "claude_max",
  label: PROVIDER_LABELS.claude_max,
  billing: PROVIDER_BILLING.claude_max,
  authStatus: (workspaceId) => providerReadiness(workspaceId, "claude_max"),
  execute: callClaude,
};

const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  label: PROVIDER_LABELS.openrouter,
  billing: PROVIDER_BILLING.openrouter,
  authStatus: (workspaceId) => providerReadiness(workspaceId, "openrouter"),
  execute: callOpenRouter,
};

/** Codex failure kinds map one-to-one onto the shared error contract. */
function toCallError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof CodexRunError) {
    const mapped = new ProviderCallError(error.kind, error.message);
    mapped.turnStarted = error.turnStarted;
    return mapped;
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
  authStatus: (workspaceId) => providerReadiness(workspaceId, "codex_chatgpt"),
  async execute(req) {
    if (!req.workingDirectory) {
      throw new ProviderCallError(
        "not_configured",
        "Codex needs an isolated working directory, and none was prepared for this task.",
      );
    }
    // The identity a Codex run bills arrives with the request — resolved
    // server-side by the caller from the workspace row at the same moment
    // it keyed the credential lease. It is deliberately NOT re-resolved
    // here: a legacy-workspace hand-over between two lookups could
    // otherwise run account B's session under account A's lease. No
    // identity supplied means nothing to run as.
    const clerkUserId = req.clerkUserId ?? null;
    if (!clerkUserId) {
      throw new ProviderCallError(
        "not_configured",
        "No account was resolved for this Codex run, so it was refused.",
      );
    }
    try {
      const attachmentContext = await materializeCodexAttachments(
        req.workingDirectory,
        req.attachments,
      );
      const result = await runCodexTurn({
        clerkUserId,
        system: req.system,
        prompt: req.prompt + attachmentContext.promptSuffix,
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
