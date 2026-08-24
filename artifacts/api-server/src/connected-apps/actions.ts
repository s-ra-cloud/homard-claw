import {
  appActionsTable,
  db,
  tasksTable,
  type AppActionRecord,
} from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { recordAudit } from "../audit";
import { APP_CATALOG, findOperation, type ConnectedAppId } from "./catalog";
import {
  executeOperation,
  hasOutcomeVerifier,
  verifierConsistency,
  verifyOperationOutcome,
  type ExecutionOutcome,
} from "./connections";

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
  app: ConnectedAppId | null;
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
  app: ConnectedAppId;
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
  const op = findOperation(input.operation);
  const outcome: ExecutionOutcome = op
    ? await executeOperation(op, input.params, { actionId: pending.id })
    : { ok: false, kind: "failed", message: "Unknown operation." };
  const action = await finalizeAction(pending.id, input.agentName, outcome);
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
): Promise<AppActionRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(appActionsTable)
      .set({ status: "denied", errorMessage: reason, decidedAt: new Date() })
      .where(eq(appActionsTable.id, action.id))
      .returning();
    await recordAudit(
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
    resolved.push(await reconcileOneStaleAction(action, agentName));
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
): Promise<ReconciledAction> {
  const settleUnknown = async (detail?: string): Promise<ReconciledAction> => ({
    action: await finalizeAction(action.id, agentName, {
      ok: false,
      kind: "failed",
      message: `The outcome is unknown — a previous run was interrupted mid-execution${detail ? ` and could not be verified (${detail})` : ""}. Verify in the external app before requesting it again.`,
    }),
    resolution: "unknown",
  });

  if (!hasOutcomeVerifier(action.operation)) return settleUnknown();

  const verdict = await verifyOperationOutcome(
    action.operation,
    action.params ?? {},
    action.id,
  );
  if (verdict.kind === "unknown") return settleUnknown(verdict.message);
  if (verdict.kind === "executed") {
    return {
      action: await finalizeAction(action.id, agentName, {
        ok: true,
        summary: verdict.summary,
      }),
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
    const requeued = await db.transaction(async (tx) => {
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
          "app_action.requeued",
          `An interrupted action by ${agentName} (${action.operation}: ${action.targetSummary}) was verified as never delivered and re-queued for a safe retry.`,
          tx,
        );
      }
      return row ?? null;
    });
    if (requeued) return { action: requeued, resolution: "requeued" };
    // Someone else already moved the row; report it as-is without settling.
    return settleUnknown("the row was concurrently modified");
  }
  return {
    action: await finalizeAction(action.id, agentName, {
      ok: false,
      kind: "failed",
      message:
        "A previous run was interrupted, and verification confirmed the action never went through. It was not retried automatically — request it again if still needed.",
    }),
    resolution: "not_executed",
  };
}
/** Execute a claimed (status "executing") action and finalize its row. */
export async function executeClaimedAction(
  action: AppActionRecord,
  agentName: string,
): Promise<{ action: AppActionRecord; outcome: ExecutionOutcome }> {
  const op = findOperation(action.operation);
  const outcome: ExecutionOutcome = op
    ? await executeOperation(op, action.params ?? {}, { actionId: action.id })
    : { ok: false, kind: "failed", message: "Unknown operation." };
  const finalized = await finalizeAction(action.id, agentName, outcome);
  return { action: finalized, outcome };
}

async function finalizeAction(
  actionId: string,
  agentName: string,
  outcome: ExecutionOutcome,
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

/** One line per settled action, replayed to the model on follow-up rounds. */
export function describeActionForModel(action: AppActionRecord): string {
  const label = APP_CATALOG[action.app as ConnectedAppId]?.displayName ?? action.app;
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
