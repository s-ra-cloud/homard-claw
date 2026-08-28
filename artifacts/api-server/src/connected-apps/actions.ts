import {
  appActionsTable,
  db,
  tasksTable,
  type AppActionRecord,
} from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { recordAudit } from "../audit";
import { executeCapabilityTool } from "../capabilities/execute";
import { findRegistryEntry } from "../capabilities/registry";
import {
  loadWorkspaceCapabilities,
  type ResolvedCapabilityTool,
} from "../capabilities/service";
import { APP_CATALOG, type ConnectedAppId } from "./catalog";
import {
  hasOutcomeVerifier,
  verifierConsistency,
  verifyOperationOutcome,
  type ExecutionOutcome,
} from "./connections";

/** Resolve one operation against the workspace's pinned capability catalog. */
async function resolveTool(
  operation: string,
  workspaceId: string | null,
): Promise<ResolvedCapabilityTool | null> {
  const capabilities = await loadWorkspaceCapabilities(workspaceId);
  return capabilities.tools.get(operation) ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = Tx | typeof db;

/** All actions ever requested for a task, oldest first. */
export async function listTaskActions(
  taskId: string,
): Promise<AppActionRecord[]> {
  return db
    .select()
    .from(appActionsTable)
    .where(eq(appActionsTable.taskId, taskId))
    .orderBy(asc(appActionsTable.createdAt));
}

/** Most recent actions across all of an agent's tasks, newest first. */
export async function listRecentAgentActions(
  agentId: string,
  limit = 20,
): Promise<Array<AppActionRecord & { taskObjective: string | null }>> {
  const rows = await db
    .select({
      action: appActionsTable,
      taskObjective: tasksTable.objective,
    })
    .from(appActionsTable)
    .leftJoin(tasksTable, eq(appActionsTable.taskId, tasksTable.id))
    .where(eq(appActionsTable.agentId, agentId))
    .orderBy(desc(appActionsTable.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row.action, taskObjective: row.taskObjective }));
}

/** Record a denied request durably, with its reason, inside the audit chain. */
export async function recordDeniedAction(input: {
  taskId: string;
  agentId: string;
  agentName: string;
  workspaceId: string | null;
  app: string | null;
  operation: string;
  params: Record<string, unknown> | null;
  reason: string;
}): Promise<AppActionRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(appActionsTable)
      .values({
        taskId: input.taskId,
        agentId: input.agentId,
        app: input.app ?? "unknown",
        operation: input.operation.slice(0, 200),
        params: input.params,
        targetSummary: input.reason.slice(0, 300),
        status: "denied",
        errorMessage: input.reason,
        decidedAt: new Date(),
      })
      .returning();
    await recordAudit(
      input.workspaceId,
      "app_action.denied",
      `${input.agentName} was denied a connected-app action (${row.operation}): ${input.reason}`,
      tx,
    );
    return row;
  });
}

/**
 * Run an immediately allowed (read/draft) action: the row is written as
 * "executing" before the connector is called, so a crash mid-call leaves a
 * visible trace instead of a silent gap, then finalized with the outcome.
 */
export async function runAllowedAction(input: {
  taskId: string;
  agentId: string;
  agentName: string;
  workspaceId: string | null;
  app: string;
  operation: string;
  params: Record<string, unknown>;
  targetSummary: string;
}): Promise<{ action: AppActionRecord; outcome: ExecutionOutcome }> {
  const [pending] = await db
    .insert(appActionsTable)
    .values({
      taskId: input.taskId,
      agentId: input.agentId,
      app: input.app,
      operation: input.operation,
      params: input.params,
      targetSummary: input.targetSummary,
      status: "executing",
      decidedAt: new Date(),
      executingAt: new Date(),
    })
    .returning();
  const tool = await resolveTool(input.operation, input.workspaceId);
  const outcome: ExecutionOutcome = tool
    ? await executeCapabilityTool(tool, input.params, {
        actionId: pending.id,
        workspaceId: input.workspaceId,
      })
    : { ok: false, kind: "failed", message: "Unknown operation." };
  const action = await finalizeAction(
    pending.id,
    input.agentName,
    outcome,
    input.workspaceId,
  );
  return { action, outcome };
}

/**
 * Claim an approved external write for execution. The guarded UPDATE is the
 * exactly-once fence: only one caller ever moves approved → executing, so
 * an approved email can never be sent twice however many workers race.
 */
export async function claimApprovedAction(
  actionId: string,
): Promise<AppActionRecord | null> {
  const [claimed] = await db
    .update(appActionsTable)
    .set({ status: "executing", executingAt: new Date() })
    .where(
      and(
        eq(appActionsTable.id, actionId),
        eq(appActionsTable.status, "approved"),
      ),
    )
    .returning();
  return claimed ?? null;
}

/**
 * Settle a claimed action as denied without touching the connector. Used
 * when re-authorization after approval fails — the grant was revoked, the
 * app disabled, or the recorded params no longer validate.
 */
export async function denyClaimedAction(
  action: AppActionRecord,
  agentName: string,
  reason: string,
  workspaceId: string | null,
): Promise<AppActionRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(appActionsTable)
      .set({ status: "denied", errorMessage: reason, decidedAt: new Date() })
      .where(eq(appActionsTable.id, action.id))
      .returning();
    await recordAudit(
      workspaceId,
      "app_action.denied",
      `An approved action by ${agentName} (${action.operation}: ${action.targetSummary}) was NOT run: ${reason}`,
      tx,
    );
    return row;
  });
}

/**
 * How each stranded "executing" row was resolved:
 * - "confirmed": the provider proved the write landed; settled as executed.
 * - "requeued": the provider proved it never landed and the row carries an
 *   owner approval, so it was moved back to "approved" for a safe re-run.
 * - "not_executed": provably never landed, but there is no approval to
 *   re-run under (read/draft path); settled as failed so the agent can
 *   request it again.
 * - "unknown": verification was impossible or inconclusive; settled as
 *   unknown-outcome and never retried — the pre-verification behavior.
 */
export type ReconciledAction = {
  action: AppActionRecord;
  resolution: "confirmed" | "requeued" | "not_executed" | "unknown";
};
/**
 * Resolve actions stranded in "executing" by a crashed attempt. Only the
 * single worker that owns the task attempt may call this, and only before
 * it starts new actions: any "executing" row it did not just create belongs
 * to a dead run whose connector call may or may not have gone through.
 *
 * Every write executor embeds an idempotency marker derived from the action
 * row id, so ambiguity is settled by ASKING the provider: a verification
 * read either confirms the write (settled as executed), proves its absence
 * (safe to re-run), or fails — in which case the outcome is recorded as
 * unknown rather than retried, because retrying an external write on
 * ambiguity is how an email gets sent twice.
 */
export async function reconcileStaleExecutingActions(
  taskId: string,
  agentName: string,
  workspaceId: string | null,
): Promise<ReconciledAction[]> {
  const stale = await db
    .select()
    .from(appActionsTable)
    .where(
      and(
        eq(appActionsTable.taskId, taskId),
        eq(appActionsTable.status, "executing"),
      ),
    );
  const resolved: ReconciledAction[] = [];
  for (const action of stale) {
    resolved.push(await reconcileOneStaleAction(action, agentName, workspaceId));
  }
  return resolved;
}

/**
 * How old an interrupted attempt must be before an eventually consistent
 * provider index (Gmail search, Drive query) saying "nothing there" is
 * believed. Younger absences settle as unknown: the write may simply not
 * be indexed yet, and re-sending on a stale index is a duplicate.
 */
const EVENTUAL_ABSENCE_TRUST_AFTER_MS = 3 * 60 * 1000;

async function reconcileOneStaleAction(
  action: AppActionRecord,
  agentName: string,
  workspaceId: string | null,
): Promise<ReconciledAction> {
  const settleUnknown = async (detail?: string): Promise<ReconciledAction> => ({
    action: await finalizeAction(
      action.id,
      agentName,
      {
        ok: false,
        kind: "failed",
        message: `The outcome is unknown — a previous run was interrupted mid-execution${detail ? ` and could not be verified (${detail})` : ""}. Verify in the external app before requesting it again.`,
      },
      workspaceId,
    ),
    resolution: "unknown",
  });

  if (!hasOutcomeVerifier(action.operation)) {
    // No provider verifier. The pinned manifest's recovery class decides:
    // retry-safe tools (idempotent reads/queries) may be re-run — under the
    // original action identity when an approval exists, or settled as
    // provably-not-delivered otherwise so the agent can simply ask again.
    // Everything else (non_retryable, unresolvable, unclassified) settles
    // as unknown: replaying an ambiguous external write is how an email
    // gets sent twice.
    const tool = await resolveTool(action.operation, workspaceId);
    if (tool?.recovery !== "retry_safe") return settleUnknown();
    if (!action.approvalId) {
      return {
        action: await finalizeAction(
          action.id,
          agentName,
          {
            ok: false,
            kind: "failed",
            message:
              "A previous run was interrupted mid-execution. This tool is classified retry-safe, so it was not replayed automatically — request it again if still needed.",
          },
          workspaceId,
        ),
        resolution: "not_executed",
      };
    }
    if (action.recoveryRequeuedAt) {
      return settleUnknown(
        "it was already retried once after an earlier crash; it will not be retried again",
      );
    }
    const requeued = await requeueForApprovalRetry(action, agentName, workspaceId);
    if (requeued) return { action: requeued, resolution: "requeued" };
    return settleUnknown("the row was concurrently modified");
  }

  const verdict = await verifyOperationOutcome(
    action.operation,
    action.params ?? {},
    action.id,
    workspaceId,
  );
  if (verdict.kind === "unknown") return settleUnknown(verdict.message);
  if (verdict.kind === "executed") {
    return {
      action: await finalizeAction(
        action.id,
        agentName,
        { ok: true, summary: verdict.summary },
        workspaceId,
      ),
      resolution: "confirmed",
    };
  }
  // The provider reported no trace of the write. For eventually consistent
  // indexes, absence only counts as proof once the interrupted attempt is
  // old enough to have been indexed; a fresh absence stays ambiguous.
  if (verifierConsistency(action.operation) === "eventual") {
    const startedAt =
      action.executingAt ?? action.decidedAt ?? action.createdAt;
    if (Date.now() - startedAt.getTime() < EVENTUAL_ABSENCE_TRUST_AFTER_MS) {
      return settleUnknown(
        "the interrupted attempt is too recent for the provider's search index to be conclusive",
      );
    }
  }
  // Provably never landed. If the owner approved it, hand it back to the
  // normal approved-action path: the worker re-checks authorization, then
  // claims and runs it exactly once with the SAME action id (and therefore
  // the same idempotency marker). Without an approval there is nothing to
  // re-run under, so record the verified non-delivery instead.
  // recoveryRequeuedAt is the durable single-retry fence: a row that was
  // already re-queued once is never re-queued again, however many crashes
  // follow — the second ambiguity settles as unknown.
  if (action.approvalId) {
    if (action.recoveryRequeuedAt) {
      return settleUnknown(
        "it was already retried once after an earlier crash; it will not be retried again",
      );
    }
    const requeued = await requeueForApprovalRetry(action, agentName, workspaceId);
    if (requeued) return { action: requeued, resolution: "requeued" };
    // Someone else already moved the row; report it as-is without settling.
    return settleUnknown("the row was concurrently modified");
  }
  return {
    action: await finalizeAction(
      action.id,
      agentName,
      {
        ok: false,
        kind: "failed",
        message:
          "A previous run was interrupted, and verification confirmed the action never went through. It was not retried automatically — request it again if still needed.",
      },
      workspaceId,
    ),
    resolution: "not_executed",
  };
}
/**
 * Move an interrupted, owner-approved action back to "approved" for one safe
 * retry under the SAME action id (and therefore the same idempotency
 * marker). recoveryRequeuedAt is the durable single-retry fence.
 */
async function requeueForApprovalRetry(
  action: AppActionRecord,
  agentName: string,
  workspaceId: string | null,
): Promise<AppActionRecord | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(appActionsTable)
      .set({ status: "approved", recoveryRequeuedAt: new Date() })
      .where(
        and(
          eq(appActionsTable.id, action.id),
          eq(appActionsTable.status, "executing"),
        ),
      )
      .returning();
    if (row) {
      await recordAudit(
        workspaceId,
        "app_action.requeued",
        `An interrupted action by ${agentName} (${action.operation}: ${action.targetSummary}) was determined safe to retry and re-queued.`,
        tx,
      );
    }
    return row ?? null;
  });
}

/** Execute a claimed (status "executing") action and finalize its row. */
export async function executeClaimedAction(
  action: AppActionRecord,
  agentName: string,
  workspaceId: string | null,
): Promise<{ action: AppActionRecord; outcome: ExecutionOutcome }> {
  const tool = await resolveTool(action.operation, workspaceId);
  const outcome: ExecutionOutcome = tool
    ? await executeCapabilityTool(tool, action.params ?? {}, {
        actionId: action.id,
        workspaceId,
      })
    : { ok: false, kind: "failed", message: "Unknown operation." };
  const finalized = await finalizeAction(action.id, agentName, outcome, workspaceId);
  return { action: finalized, outcome };
}

async function finalizeAction(
  actionId: string,
  agentName: string,
  outcome: ExecutionOutcome,
  workspaceId: string | null,
): Promise<AppActionRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(appActionsTable)
      .set(
        outcome.ok
          ? {
              status: "executed",
              resultSummary: outcome.summary,
              executedAt: new Date(),
            }
          : {
              status: "failed",
              errorMessage: outcome.message,
              executedAt: new Date(),
            },
      )
      .where(eq(appActionsTable.id, actionId))
      .returning();
    await recordAudit(
      workspaceId,
      outcome.ok ? "app_action.executed" : "app_action.failed",
      outcome.ok
        ? `${agentName} used a connected app: ${row.targetSummary}.`
        : `A connected-app action by ${agentName} failed (${row.targetSummary}): ${outcome.message.slice(0, 200)}`,
      tx,
    );
    return row;
  });
}

/**
 * Mirror an approval decision onto its linked action row (used by the
 * approvals route and the expiry sweep, inside their transactions).
 */
export async function settleActionForApproval(
  tx: DbLike,
  approvalId: string,
  status: "approved" | "rejected" | "expired",
): Promise<AppActionRecord | null> {
  const [row] = await tx
    .update(appActionsTable)
    .set({ status, decidedAt: new Date() })
    .where(
      and(
        eq(appActionsTable.approvalId, approvalId),
        eq(appActionsTable.status, "waiting_approval"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Bounds for the action-result replay in follow-up prompts. A single entry
 * keeps a verbatim head (where operations put their status line and the
 * identifiers needed for chaining — message ids, spreadsheet ids, links)
 * and a verbatim tail (where listings end with the newest rows), with the
 * middle elided. The whole replayed section then fits a hard character
 * budget, so a simple task can never grow an unbounded prompt out of large
 * external results.
 */
export const ACTION_RESULT_HEAD_CHARS = 1_200;
export const ACTION_RESULT_TAIL_CHARS = 400;
/** Worst-case size of one compacted entry, for budget preflight maths. */
export const COMPACT_ACTION_ENTRY_MAX_CHARS =
  ACTION_RESULT_HEAD_CHARS + ACTION_RESULT_TAIL_CHARS + 200;
/** Hard budget for the whole replayed action-history section of a prompt. */
export const ACTION_HISTORY_CHAR_BUDGET = 24_000;
/** Older entries collapse to their status line under this secondary budget. */
const COLLAPSED_ENTRY_CHARS = 200;
const COLLAPSED_SECTION_CHAR_BUDGET = 4_000;

/**
 * Compact one replayed action entry to a bounded head+tail window. Entries
 * already within bounds are returned verbatim; the elision marker states
 * exactly how much was omitted, so the model never mistakes a truncated
 * listing for a complete one.
 */
export function compactActionEntry(entry: string): string {
  const keep = ACTION_RESULT_HEAD_CHARS + ACTION_RESULT_TAIL_CHARS;
  // Slightly over-budget entries pass verbatim: an elision marker longer
  // than the text it removes would make the prompt bigger, not smaller.
  if (entry.length <= keep + 160) return entry;
  const omitted = entry.length - keep;
  return `${entry.slice(0, ACTION_RESULT_HEAD_CHARS)}\n…[${omitted} characters omitted from the middle of this result to keep the prompt bounded; the beginning and end are verbatim]…\n${entry.slice(-ACTION_RESULT_TAIL_CHARS)}`;
}

/** Collapse an entry to its first (status) line for the low-detail tier. */
function collapseActionEntry(entry: string): string {
  const newline = entry.indexOf("\n");
  const firstLine = newline === -1 ? entry : entry.slice(0, newline);
  const head =
    firstLine.length > COLLAPSED_ENTRY_CHARS
      ? `${firstLine.slice(0, COLLAPSED_ENTRY_CHARS)}…`
      : firstLine;
  return `${head} (result details omitted)`;
}

/**
 * Bound a whole action history for replay in a prompt. The newest entries
 * keep their (individually compacted) detail — they carry the identifiers
 * and status evidence the next step chains on — older entries collapse to
 * their one-line status, and anything beyond the secondary budget is
 * summarized by count. Original order is preserved.
 */
export function compactActionHistoryForPrompt(
  entries: readonly string[],
): string[] {
  const kept: (string | null)[] = new Array(entries.length).fill(null);
  let detailedUsed = 0;
  let collapsedUsed = 0;
  let omittedCount = 0;
  // Newest first: recency decides who keeps detail.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const detailed = compactActionEntry(entries[i]!);
    if (detailedUsed + detailed.length <= ACTION_HISTORY_CHAR_BUDGET) {
      kept[i] = detailed;
      detailedUsed += detailed.length;
      continue;
    }
    const collapsed = collapseActionEntry(entries[i]!);
    if (collapsedUsed + collapsed.length <= COLLAPSED_SECTION_CHAR_BUDGET) {
      kept[i] = collapsed;
      collapsedUsed += collapsed.length;
      continue;
    }
    omittedCount += 1;
  }
  const out = kept.filter((entry): entry is string => entry !== null);
  if (omittedCount > 0) {
    out.unshift(
      `(${omittedCount} earlier settled action result(s) omitted to keep the prompt bounded; the statuses and results below are the most recent evidence.)`,
    );
  }
  return out;
}

/** One line per settled action, replayed to the model on follow-up rounds. */
export function describeActionForModel(action: AppActionRecord): string {
  const label =
    APP_CATALOG[action.app as ConnectedAppId]?.displayName ??
    findRegistryEntry(action.app)?.manifest.displayName ??
    action.app;
  switch (action.status) {
    case "executed":
      return `[${label}] ${action.operation} (${action.targetSummary}) → SUCCESS:\n${action.resultSummary ?? "(no output)"}`;
    case "failed":
      return `[${label}] ${action.operation} (${action.targetSummary}) → FAILED: ${action.errorMessage ?? "unknown error"}`;
    case "denied":
      return `[${label}] ${action.operation} → DENIED: ${action.errorMessage ?? "not permitted"}`;
    case "rejected":
      return `[${label}] ${action.operation} (${action.targetSummary}) → REJECTED by the owner; do not attempt it again.`;
    case "expired":
      return `[${label}] ${action.operation} (${action.targetSummary}) → approval EXPIRED undecided.`;
    default:
      return `[${label}] ${action.operation} (${action.targetSummary}) → ${action.status}.`;
  }
}
