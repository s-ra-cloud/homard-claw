import { randomUUID } from "node:crypto";
import { logger } from "./lib/logger";
import {
  callProvider,
  ProviderCallError,
  type ProviderCallResult,
} from "./execution";
import { codexAuthFingerprint } from "./codex/runtime";
import { codexLeaseHeartbeatMs, codexLeaseTtlMs } from "./codex/config";
import {
  acquireProviderLease,
  codexLeaseKey,
  releaseProviderLease,
  renewProviderLease,
} from "./provider-leases";
import {
  markConversationUnresumable,
  recordThreadId,
  resolveConversation,
  touchConversation,
} from "./provider-conversations";
import { loadAgentAppAccess } from "./connected-apps/authorize";
import { sanitizeErrorMessage } from "./lib/sanitize";

/**
 * Codex execution context for Talk (typed and voice conversations).
 *
 * Task runs prepare an isolated per-agent workspace, take the durable
 * ChatGPT-credential lease, and pass the agent's sandbox restrictions to
 * the Codex adapter. Talk previously did none of that — the adapter then
 * refused the call before ever contacting Codex, and the refusal was
 * mislabeled as a missing provider key. This module gives a live
 * conversation the exact same safe context, sized for an interactive
 * request instead of a queued task.
 */

export type CodexTalkFailureKind =
  /** The isolated conversation workspace could not be prepared. */
  | "workspace"
  /** Codex is not set up for this workspace (flag, storage, no sign-in). */
  | "setup"
  /** The ChatGPT session could not authenticate. */
  | "auth"
  /** Another run holds the ChatGPT credential and the wait ran out. */
  | "busy"
  /** The plan allowance is exhausted. */
  | "allowance"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "provider";

export class CodexTalkError extends Error {
  /**
   * Whether the model turn had started when the failure surfaced.
   * `false` proves nothing ran (no allowance spent); `null` is unknown
   * and must be treated as "may have run".
   */
  turnStarted: boolean | null = null;

  constructor(
    readonly kind: CodexTalkFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexTalkError";
  }
}

/**
 * How long a Talk turn is willing to queue behind a task for the ChatGPT
 * credential. A live conversation cannot wait out a minutes-long task, so
 * the bound is short: either the lease frees up almost immediately (the
 * common case between task rounds is not covered — the worker heartbeats —
 * but a just-finished task's release is) or the owner gets a clear busy
 * message and can retry.
 */
const LEASE_WAIT_TOTAL_MS = 5_000;
const LEASE_WAIT_INTERVAL_MS = 1_000;

let leaseWaitOverride: { totalMs: number; intervalMs: number } | null = null;

/** Test hook: shrink the busy-wait so contention tests do not sleep 5s. */
export function setCodexTalkLeaseWait(
  override: { totalMs: number; intervalMs: number } | null,
): void {
  leaseWaitOverride = override;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Every failure leaves this function as a CodexTalkError with a stable
 * kind, so the route can render an accurate, fixed, sanitized message —
 * never the generic "add a provider key" text that hid every setup
 * problem before.
 */
function toTalkError(error: unknown): CodexTalkError {
  if (error instanceof CodexTalkError) return error;
  if (error instanceof ProviderCallError) {
    const mapped = mapProviderError(error);
    mapped.turnStarted = error.turnStarted;
    return mapped;
  }
  return new CodexTalkError(
    "provider",
    error instanceof Error ? error.message : "Unknown Codex error",
  );
}

function mapProviderError(error: ProviderCallError): CodexTalkError {
  switch (error.kind) {
    case "auth":
      return new CodexTalkError("auth", error.message);
    case "not_configured":
      return new CodexTalkError("setup", error.message);
    case "allowance":
      return new CodexTalkError("allowance", error.message);
    case "rate_limit":
      return new CodexTalkError("rate_limit", error.message);
    case "timeout":
      return new CodexTalkError("timeout", error.message);
    case "cancelled":
      return new CodexTalkError("cancelled", error.message);
    default:
      return new CodexTalkError("provider", error.message);
  }
}

export type CodexTalkAgent = {
  id: string;
  workspaceId: string;
  securityPreset: string;
  autonomy: string;
  sensitiveDataSandbox: boolean;
};

/**
 * Whether a provider failure looks like a broken thread resume rather than
 * a real model failure. Codex keeps its resumable session files on scratch
 * disk, so every deployment restart wipes them while the conversation row
 * (and its thread id) survive in the database. Resuming then dies almost
 * instantly — before the model runs, so no allowance was spent and it is
 * safe to fall back to a fresh thread. Only generic provider failures are
 * eligible: auth, allowance, rate-limit, timeout, and busy failures are
 * real answers about the account, not the thread.
 */
function looksLikeThreadResumeFailure(error: CodexTalkError): boolean {
  if (error.kind !== "provider" && error.kind !== "workspace") return false;
  const message = error.message.toLowerCase();
  const aboutThread = /(session|rollout|thread|conversation)/.test(message);
  const looksMissing =
    /(not found|no such|missing|does not exist|unable to|failed to (resume|load|find|read)|corrupt)/.test(
      message,
    );
  return aboutThread && looksMissing;
}

export type CodexTalkRequest = {
  agent: CodexTalkAgent;
  model: string;
  reasoningEffort: string | null;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};

/**
 * Run one Codex Talk turn with the full task-grade execution context:
 * durable credential lease (bounded wait, heartbeat, guaranteed release),
 * isolated per-agent conversation workspace, resumed provider thread, and
 * the agent's current persisted sandbox restrictions.
 */
export async function runCodexTalkTurn(
  input: CodexTalkRequest,
): Promise<ProviderCallResult> {
  // Keyed by the account whose ChatGPT session the turn will use. No
  // account resolved means there is nothing to run as; fail closed with a
  // setup error, not a missing-API-key one.
  let fingerprint: string | null;
  try {
    fingerprint = await codexAuthFingerprint();
  } catch (error) {
    throw toTalkError(error);
  }
  if (!fingerprint) {
    throw new CodexTalkError(
      "setup",
      "No ChatGPT sign-in could be resolved for Codex, so the conversation was refused.",
    );
  }

  // One credential, one run at a time — the same durable lease queued
  // tasks take, so Talk and the worker can never race on auth.json or
  // double-spend the allowance. The turn id is a fresh UUID: leases are
  // per-attempt, and a Talk turn is its own attempt.
  const key = codexLeaseKey(fingerprint);
  const turnId = randomUUID();
  const wait = leaseWaitOverride ?? {
    totalMs: LEASE_WAIT_TOTAL_MS,
    intervalMs: LEASE_WAIT_INTERVAL_MS,
  };
  const waitDeadline = Date.now() + wait.totalMs;
  let acquired = false;
  for (;;) {
    const outcome = await acquireProviderLease(key, turnId, codexLeaseTtlMs());
    if (outcome.acquired) {
      acquired = true;
      break;
    }
    if (input.signal.aborted || Date.now() >= waitDeadline) break;
    await abortableDelay(
      Math.min(wait.intervalMs, Math.max(0, waitDeadline - Date.now())),
      input.signal,
    );
    if (input.signal.aborted) break;
  }
  if (!acquired) {
    throw new CodexTalkError(
      "busy",
      "The ChatGPT Codex session is busy with another run.",
    );
  }

  // From here the lease is ours and MUST be released on every path.
  let leaseLost = false;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) forwardAbort();
  input.signal.addEventListener("abort", forwardAbort, { once: true });

  // Renew while the call is in flight; abort the moment a renewal is
  // refused so we never keep talking on a credential another run owns.
  const heartbeat = setInterval(() => {
    void renewProviderLease(key, turnId, codexLeaseTtlMs()).then(
      (held) => {
        if (held) return;
        leaseLost = true;
        controller.abort("provider_lease_lost");
      },
      (error: unknown) => {
        // A transient database blip is not proof of loss; let the next
        // beat decide instead of killing a healthy conversation.
        logger.warn(
          { agentId: input.agent.id, error },
          "Could not renew the Codex credential lease for a Talk turn",
        );
      },
    );
  }, codexLeaseHeartbeatMs());
  heartbeat.unref?.();

  try {
    // Sandbox inputs are loaded fresh so a sensitive-data flag toggled a
    // moment ago applies to this very turn. A load failure fails closed to
    // the agent row's own persisted flag.
    let sensitiveDataSandbox = input.agent.sensitiveDataSandbox;
    try {
      sensitiveDataSandbox = (
        await loadAgentAppAccess(input.agent.id, input.agent.workspaceId)
      )
        .sensitiveDataSandbox;
    } catch (error) {
      logger.warn(
        { agentId: input.agent.id, error },
        "Could not load app access for a Talk turn; using the agent's persisted sandbox flag",
      );
    }

    // Two attempts at most: "continue" resumes the agent's latest thread
    // for continuity; if that resume is what failed (a wiped scratch disk
    // leaves stale thread ids behind after every deploy), the conversation
    // is marked unresumable and the turn runs once more on a fresh thread.
    let mode: "continue" | "new" = "continue";
    for (let attempt = 0; ; attempt++) {
      // The agent's most recent resumable conversation keeps continuity
      // with its task history; a fresh agent gets a fresh workspace.
      // Conversations are keyed per agent, so no workspace or thread ever
      // crosses agents.
      let conversation;
      try {
        conversation = await resolveConversation(
          input.agent.id,
          "codex_chatgpt",
          mode,
        );
      } catch (error) {
        throw new CodexTalkError(
          "workspace",
          error instanceof Error
            ? error.message
            : "The Codex workspace could not be prepared.",
        );
      }
      const conversationId = conversation.id;

      let result: ProviderCallResult;
      try {
        result = await callProvider({
          provider: "codex_chatgpt",
          model: input.model,
          system: input.system,
          prompt: input.prompt,
          maxOutputTokens: input.maxOutputTokens,
          signal: controller.signal,
          reasoningEffort: input.reasoningEffort,
          threadId: conversation.threadId,
          workingDirectory: conversation.workspacePath,
          sandbox: {
            securityPreset: input.agent.securityPreset,
            autonomy: input.agent.autonomy,
            sensitiveDataSandbox,
          },
          onThreadId: async (emitted) => {
            // Persisted the moment the SDK issues it, so a dropped
            // connection mid-turn still leaves a resumable thread behind.
            await recordThreadId(conversationId, emitted);
          },
        });
      } catch (error) {
        if (leaseLost) {
          throw new CodexTalkError(
            "busy",
            "The ChatGPT Codex session was taken over by another run.",
          );
        }
        const talkError = toTalkError(error);
        const resumeSuspected =
          attempt === 0 &&
          conversation.threadId !== null &&
          !controller.signal.aborted &&
          looksLikeThreadResumeFailure(talkError);
        if (resumeSuspected && talkError.turnStarted === false) {
          // The provider itself reported the turn failed before starting:
          // nothing ran, no allowance was spent, so the turn is safe to
          // replay once on a fresh thread.
          logger.warn(
            {
              agentId: input.agent.id,
              conversationId,
              kind: talkError.kind,
              detail: sanitizeErrorMessage(talkError.message).slice(0, 500),
            },
            "Codex Talk thread resume failed; retrying on a fresh thread",
          );
          // The broken thread must never be picked again — by Talk or by a
          // queued task. Best-effort: even if the mark fails, this turn
          // still runs on a fresh conversation.
          await markConversationUnresumable(conversationId).catch(() => {});
          mode = "new";
          continue;
        }
        if (resumeSuspected && talkError.turnStarted !== true) {
          // The failure looks like a broken resume but there is no proof
          // the remote turn never started, so replaying it here could
          // double-spend the allowance. Fail closed: retire the suspect
          // thread so the owner's resend runs on a fresh one instead.
          logger.warn(
            {
              agentId: input.agent.id,
              conversationId,
              kind: talkError.kind,
              detail: sanitizeErrorMessage(talkError.message).slice(0, 500),
            },
            "Codex Talk thread resume suspected broken; retired the thread for the next resend",
          );
          await markConversationUnresumable(conversationId).catch(() => {});
        }
        throw talkError;
      }
      await touchConversation(conversationId).catch(() => {
        // Continuity bookkeeping must never fail a turn that succeeded.
      });
      return result;
    }
  } finally {
    clearInterval(heartbeat);
    input.signal.removeEventListener("abort", forwardAbort);
    if (!leaseLost) {
      // Release deletes only our own row, so this is safe even if the
      // lease expired and was re-taken between the last beat and now.
      await releaseProviderLease(key, turnId).catch((error: unknown) => {
        logger.warn(
          { agentId: input.agent.id, error },
          "Could not release the Codex credential lease after a Talk turn",
        );
      });
    }
  }
}
