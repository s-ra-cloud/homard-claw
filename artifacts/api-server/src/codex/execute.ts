import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sanitizeErrorMessage } from "../lib/sanitize";
import {
  clearCodexWorkingCopy,
  codexChildEnv,
  codexRuntimeState,
  persistCodexRefresh,
  requireCodexRuntime,
  type CodexRuntimeState,
} from "./runtime";
import {
  CodexSdkUnavailableError,
  loadCodexSdk,
  type CodexThreadEvent,
  type CodexThreadItem,
  type CodexThreadOptions,
  type CodexUsage,
} from "./sdk";
import { codexWorkspaceRoot } from "./config";

/**
 * One Codex turn, executed through the official SDK against the owner's
 * ChatGPT-managed session.
 *
 * The thread runs inside an isolated per-conversation directory with a
 * restrictive sandbox derived from the agent's permissions. Progress is
 * streamed back sanitized; nothing that reaches the caller can carry
 * credential material, and the Codex environment is built from an
 * allowlist so no HomardClaw secret is visible to the agent's tools.
 */

export type CodexPhase =
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "rate_limited"
  | "auth_required"
  | "failed"
  | "cancelled";

export type CodexProgress = {
  level: "info" | "warn" | "error";
  message: string;
};

export type CodexSandboxProfile = {
  sandboxMode: "read-only" | "workspace-write";
  networkAccessEnabled: boolean;
  webSearchMode: "disabled" | "live";
  approvalPolicy: "never" | "on-request";
};

export type CodexRunInput = {
  /** Combined HomardClaw system framing; injected as the turn preamble. */
  system: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  /** Absolute path of the conversation's isolated workspace. */
  workingDirectory: string;
  /** Resume this SDK thread when set; otherwise a new thread is started. */
  threadId: string | null;
  sandbox: CodexSandboxProfile;
  signal: AbortSignal;
  onThreadId?: (threadId: string) => void | Promise<void>;
  onPhase?: (phase: CodexPhase) => void | Promise<void>;
  onProgress?: (progress: CodexProgress) => void | Promise<void>;
};

export type CodexRunResult = {
  output: string;
  threadId: string | null;
  usage: CodexUsage | null;
};

export type CodexFailureKind =
  | "not_configured"
  | "auth"
  | "rate_limit"
  | "allowance"
  | "cancelled"
  | "provider_error";

export class CodexRunError extends Error {
  /**
   * Whether the model turn had started when this failure surfaced.
   * `false` is positive evidence the failure happened before execution
   * (nothing ran, no allowance was spent — e.g. a failed thread resume);
   * `true` means the turn ran; `null` means unknown, which callers must
   * treat as "may have run".
   */
  turnStarted: boolean | null = null;

  constructor(
    readonly kind: CodexFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexRunError";
  }
}

/**
 * Map HomardClaw's own agent permissions onto Codex sandbox settings. The
 * mapping is one-way restrictive: nothing here can produce
 * `danger-full-access`, and network access stays off unless the operator
 * opted in for the most trusted preset.
 */
export function codexSandboxFor(input: {
  securityPreset: string;
  autonomy: string;
  allowNetwork: boolean;
  /**
   * Sensitive-data sandbox: an owner-persisted isolation flag that beats
   * everything else here. No preset, autonomy level, or environment
   * variable may re-open the network or filesystem for such an agent.
   */
  sensitiveDataSandbox?: boolean;
}): CodexSandboxProfile {
  if (input.sensitiveDataSandbox) {
    return {
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    };
  }
  const trusted =
    input.securityPreset === "operator" && input.autonomy === "autonomous";
  const readOnly = input.securityPreset === "observer";
  const network = trusted && input.allowNetwork;
  return {
    sandboxMode: readOnly ? "read-only" : "workspace-write",
    networkAccessEnabled: network,
    webSearchMode: network ? "live" : "disabled",
    // Codex must never block waiting on an interactive approval it can
    // never receive: HomardClaw owns approvals, so the sandbox simply
    // refuses anything outside it.
    approvalPolicy: "never",
  };
}

/** Per-agent, per-conversation working directory. Created on demand. */
export async function ensureCodexWorkspace(
  agentId: string,
  conversationId: string,
): Promise<string> {
  const root = codexWorkspaceRoot();
  if (!root) {
    throw new CodexRunError(
      "not_configured",
      "Codex has no workspace root configured, so an isolated working directory cannot be created.",
    );
  }
  const dir = path.join(root, agentId, conversationId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Messages that identify a broken thread resume — the provider says the
 * stored rollout/session no longer exists (production form:
 * `thread/resume failed: no rollout found for thread id ... (code -32600)`).
 * These are checked before the generic hint buckets because the message
 * echoes the raw thread id, whose digits could otherwise collide with a
 * numeric hint like "429" or "401" and misclassify a dead thread as a
 * rate-limit or auth failure.
 */
const THREAD_RESUME_HINTS = [
  "no rollout found",
  "rollout not found",
  "thread/resume failed",
];

/**
 * The one resume failure that is provider-confirmed pre-execution even when
 * it arrives as a rejected promise: the server refused `thread/resume`
 * because the stored rollout no longer exists (JSON-RPC -32600, production
 * form `thread/resume failed: no rollout found for thread id ...`). The CLI
 * echoes that server rejection verbatim before any turn can begin, so no
 * allowance was spent. Deliberately stricter than THREAD_RESUME_HINTS: both
 * the failing method and the missing-rollout reason must appear together.
 * Anything looser (a lone "no rollout found", a generic session message)
 * stays unknown and fails closed.
 */
export function isConfirmedMissingRollout(rawMessage: string): boolean {
  const haystack = rawMessage.toLowerCase();
  return (
    haystack.includes("thread/resume") &&
    (haystack.includes("no rollout found") ||
      haystack.includes("rollout not found"))
  );
}

const RATE_LIMIT_HINTS = ["rate limit", "rate_limit", "429", "too many requests"];
const ALLOWANCE_HINTS = [
  "usage limit",
  "usage_limit",
  "quota",
  "plan limit",
  "allowance",
  "you've hit your",
  "weekly limit",
];
const AUTH_HINTS = [
  "401",
  "unauthorized",
  "not authenticated",
  "authentication",
  "please run codex login",
  "login",
  "token expired",
  "invalid_grant",
];

/**
 * Classify a Codex failure from its message. Sanitized first: Codex error
 * strings can echo the failing request, and the classification result is
 * persisted on the task.
 */
export function classifyCodexError(rawMessage: string): CodexRunError {
  const message = sanitizeErrorMessage(rawMessage);
  const haystack = message.toLowerCase();
  if (THREAD_RESUME_HINTS.some((hint) => haystack.includes(hint))) {
    const error = new CodexRunError("provider_error", message);
    // The full production signature is the server's own pre-turn resume
    // rejection, so it counts as proof nothing ran — even when it reaches
    // us through a rejected promise instead of a streamed event. Stream
    // handlers that saw `turn.started` overwrite this with the truth.
    if (isConfirmedMissingRollout(message)) error.turnStarted = false;
    return error;
  }
  if (ALLOWANCE_HINTS.some((hint) => haystack.includes(hint))) {
    return new CodexRunError(
      "allowance",
      `The ChatGPT Codex allowance is exhausted: ${message}`,
    );
  }
  if (RATE_LIMIT_HINTS.some((hint) => haystack.includes(hint))) {
    return new CodexRunError("rate_limit", `Codex is rate limiting requests: ${message}`);
  }
  if (AUTH_HINTS.some((hint) => haystack.includes(hint))) {
    return new CodexRunError(
      "auth",
      `Codex could not authenticate the ChatGPT session: ${message}`,
    );
  }
  return new CodexRunError("provider_error", message);
}

/** Human-readable, credential-free description of a streamed item. */
export function describeCodexItem(item: CodexThreadItem): CodexProgress | null {
  switch (item.type) {
    case "command_execution": {
      const status =
        item.status === "in_progress"
          ? "running"
          : item.status === "failed"
            ? `failed (exit ${item.exit_code ?? "?"})`
            : "finished";
      return {
        level: item.status === "failed" ? "warn" : "info",
        message: `Command ${status}: ${sanitizeErrorMessage(item.command).slice(0, 200)}`,
      };
    }
    case "file_change":
      return {
        level: item.status === "failed" ? "warn" : "info",
        message: `File changes ${item.status}: ${item.changes
          .map((change) => `${change.kind} ${change.path}`)
          .join(", ")
          .slice(0, 300)}`,
      };
    case "mcp_tool_call":
      return {
        level: "info",
        message: `Tool call ${item.server}/${item.tool}: ${item.status}`,
      };
    case "web_search":
      return {
        level: "info",
        message: `Web search: ${sanitizeErrorMessage(item.query).slice(0, 160)}`,
      };
    case "todo_list":
      return {
        level: "info",
        message: `Plan: ${item.items
          .map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`)
          .join("; ")
          .slice(0, 300)}`,
      };
    case "error":
      return { level: "error", message: sanitizeErrorMessage(item.message) };
    // Assistant prose and raw reasoning are the answer itself, not
    // progress; they are returned as output rather than mirrored into the
    // durable log twice.
    default:
      return null;
  }
}

/**
 * Run one turn. Returns the final response plus whatever usage the SDK
 * exposed; never invents a cost, a token count, or a remaining balance.
 */
export async function runCodexTurn(input: CodexRunInput): Promise<CodexRunResult> {
  let state: CodexRuntimeState;
  try {
    state = await requireCodexRuntime();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Codex is not available.";
    const kind =
      error instanceof Error && error.name === "CodexRuntimeError"
        ? ((error as { kind?: string }).kind === "auth" ? "auth" : "not_configured")
        : "not_configured";
    throw new CodexRunError(kind as CodexFailureKind, detail);
  }

  try {
    return await runTurnWithState(state, input);
  } finally {
    // Codex refreshes its own tokens mid-run and rewrites auth.json. That
    // update is folded back into durable storage here — while the run's
    // lease still guarantees nobody else is touching the same session —
    // because the filesystem copy does not survive a restart.
    await saveRefreshedSession(state);
  }
}

async function saveRefreshedSession(state: CodexRuntimeState): Promise<void> {
  if (!state.clerkUserId || !state.credentialRevision) return;
  try {
    await persistCodexRefresh(state.clerkUserId, state.credentialRevision);
  } catch {
    // A failed write-back must never mask the run's own outcome: the next
    // run materializes the stored copy again and Codex refreshes from it.
  }
  try {
    // Nothing else needs the decrypted copy until the next run writes it
    // out again.
    await clearCodexWorkingCopy(state.clerkUserId);
  } catch {
    // Leftover working copies are the disk-usage problem, not a run
    // failure; the file is owner-only either way.
  }
}

async function runTurnWithState(
  state: CodexRuntimeState,
  input: CodexRunInput,
): Promise<CodexRunResult> {
  let sdk;
  try {
    sdk = await loadCodexSdk();
  } catch (error) {
    throw new CodexRunError(
      "not_configured",
      error instanceof CodexSdkUnavailableError
        ? error.message
        : "The Codex SDK could not be loaded.",
    );
  }

  const client = sdk.createClient({
    // The SDK inherits nothing from this process when `env` is supplied.
    env: codexChildEnv(state.home as string),
  });

  const threadOptions: CodexThreadOptions = {
    model: input.model,
    modelReasoningEffort: input.reasoningEffort,
    workingDirectory: input.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: input.sandbox.sandboxMode,
    networkAccessEnabled: input.sandbox.networkAccessEnabled,
    webSearchMode: input.sandbox.webSearchMode,
    webSearchEnabled: input.sandbox.webSearchMode !== "disabled",
    approvalPolicy: input.sandbox.approvalPolicy,
    // No directory outside the conversation workspace is writable.
    additionalDirectories: [],
  };

  const thread = input.threadId
    ? client.resumeThread(input.threadId, threadOptions)
    : client.startThread(threadOptions);

  await input.onPhase?.("starting");

  const turnInput = `${input.system}\n\n---\n\n${input.prompt}`;
  // Tracks whether the model turn ever began. Only a terminal error event
  // *streamed back by the provider* before `turn.started` counts as proof
  // of pre-execution failure (`turnStarted = false`): the server itself
  // reported the turn never ran, so no allowance was spent. A rejected
  // promise generally proves nothing — the request may have been accepted
  // remotely before the client-side failure — and stays `null` (unknown),
  // with one narrow exception: the full confirmed missing-rollout resume
  // rejection (see isConfirmedMissingRollout) is the server's own pre-turn
  // refusal echoed by the CLI, so the classifier marks it `false`.
  let turnStarted = false;
  let streamed;
  try {
    streamed = await thread.runStreamed(turnInput, { signal: input.signal });
  } catch (error) {
    throw toRunError(error, input.signal);
  }

  let threadId: string | null = input.threadId;
  let usage: CodexUsage | null = null;
  let failure: CodexRunError | null = null;
  const messages: string[] = [];

  try {
    for await (const event of streamed.events as AsyncIterable<CodexThreadEvent>) {
      if (input.signal.aborted) break;
      switch (event.type) {
        case "thread.started":
          threadId = event.thread_id;
          await input.onThreadId?.(event.thread_id);
          break;
        case "turn.started":
          turnStarted = true;
          await input.onPhase?.("running");
          break;
        case "turn.completed":
          usage = event.usage;
          break;
        case "turn.failed":
          failure = classifyCodexError(event.error.message);
          failure.turnStarted = turnStarted;
          break;
        case "error":
          failure = classifyCodexError(event.message);
          failure.turnStarted = turnStarted;
          break;
        case "item.completed": {
          if (event.item.type === "agent_message") {
            messages.push(event.item.text);
            break;
          }
          const described = describeCodexItem(event.item);
          if (described) await input.onProgress?.(described);
          break;
        }
        case "item.started":
        case "item.updated":
          break;
      }
    }
  } catch (error) {
    const runError = toRunError(error, input.signal);
    // A stream that breaks mid-iteration only yields safe knowledge in one
    // direction: if the turn was seen starting, record that so nobody
    // replays it — even over a classifier verdict of "never started". Its
    // absence proves nothing (the connection may have died after remote
    // acceptance), so an unknown flag stays unknown.
    if (turnStarted) runError.turnStarted = true;
    throw runError;
  }

  if (input.signal.aborted) {
    throw new CodexRunError(
      "cancelled",
      input.signal.reason === "timeout"
        ? "The Codex run timed out."
        : "The Codex run was cancelled.",
    );
  }
  if (failure) throw failure;

  const output = messages.join("\n\n").trim();
  if (output === "") {
    throw new CodexRunError("provider_error", "Codex returned no text output.");
  }
  return { output, threadId, usage };
}

function toRunError(error: unknown, signal: AbortSignal): CodexRunError {
  if (error instanceof CodexRunError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CodexRunError(
      "cancelled",
      signal.reason === "timeout"
        ? "The Codex run timed out."
        : "The Codex run was cancelled.",
    );
  }
  return classifyCodexError(
    error instanceof Error ? error.message : "Unknown Codex SDK error",
  );
}

/**
 * Cheap, side-effect-free connection check for one account:
 * configuration, private working storage, ChatGPT auth mode, freshness,
 * and SDK availability. It deliberately does not start a thread — a "test"
 * must never consume anyone's allowance or leave a stray session behind.
 */
export async function testCodexConnection(clerkUserId?: string | null): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const state = await codexRuntimeState(clerkUserId);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "Feature flag",
      ok: state.enabled,
      detail: state.enabled
        ? "CODEX_ENABLED is set."
        : "CODEX_ENABLED is not set, so Codex is hidden.",
    },
    {
      name: "Private working storage",
      ok: state.storageReady,
      detail: state.storageReady
        ? "A private per-account directory is writable; the sign-in itself is kept in the database."
        : state.detail,
    },
    {
      name: "ChatGPT authentication",
      ok: state.usesChatGptAllowance,
      detail: state.detail,
    },
  ];
  const sdk = await import("./sdk");
  const availability = await sdk.codexSdkAvailable();
  checks.push({
    name: "Codex SDK",
    ok: availability.available,
    detail: availability.detail,
  });
  return { ok: checks.every((check) => check.ok), checks };
}
