import {
  appActionsTable,
  db,
  type AppActionRecord,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { recordAudit } from "../audit";
import { APP_CATALOG, findOperation, type ConnectedAppId } from "./catalog";
import { executeOperation, type ExecutionOutcome } from "./connections";

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
    })
    .returning();
  const op = findOperation(input.operation);
  const outcome: ExecutionOutcome = op
    ? await executeOperation(op, input.params)
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
    .set({ status: "executing" })
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
 * Finalize actions stranded in "executing" by a crashed attempt. Only the
 * single worker that owns the task attempt may call this, and only before
 * it starts new actions: any "executing" row it did not just create belongs
 * to a dead run whose connector call may or may not have gone through. The
 * outcome is recorded as unknown rather than silently retried — retrying an
 * external write on ambiguity is how an email gets sent twice.
 */
export async function reconcileStaleExecutingActions(
  taskId: string,
  agentName: string,
): Promise<AppActionRecord[]> {
  const stale = await db
    .select()
    .from(appActionsTable)
    .where(
      and(
        eq(appActionsTable.taskId, taskId),
        eq(appActionsTable.status, "executing"),
      ),
    );
  const settled: AppActionRecord[] = [];
  for (const action of stale) {
    settled.push(
      await finalizeAction(action.id, agentName, {
        ok: false,
        kind: "failed",
        message:
          "The outcome is unknown — a previous run was interrupted mid-execution. Verify in the external app before requesting it again.",
      }),
    );
  }
  return settled;
}

/** Execute a claimed (status "executing") action and finalize its row. */
export async function executeClaimedAction(
  action: AppActionRecord,
  agentName: string,
): Promise<{ action: AppActionRecord; outcome: ExecutionOutcome }> {
  const op = findOperation(action.operation);
  const outcome: ExecutionOutcome = op
    ? await executeOperation(op, action.params ?? {})
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
