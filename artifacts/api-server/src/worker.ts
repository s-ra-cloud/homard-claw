import {
  agentMessagesTable,
  agentsTable,
  appActionsTable,
  approvalsTable,
  db,
  pool,
  systemStateTable,
  taskLogsTable,
  tasksTable,
} from "@workspace/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import {
  effectivePermissions,
  evaluateFallback,
  evaluateTaskPolicy,
  meteredSpendTodayCents,
} from "./policy";
import {
  MAX_OUTPUT_TOKENS,
  ProviderCallError,
  type ProviderPhase,
} from "./execution";
import {
  DEFAULT_RUNTIME,
  RuntimeUnavailableError,
  getRuntime,
  isRuntimeId,
} from "./runtime";
import {
  availableProviderIds,
  computeUsageCostCents,
  estimatePromptTokens,
  getModelPricing,
  isMeteredProvider,
  providerLabel,
  providerReadiness,
  resolveRouting,
  type ProviderId,
} from "./providers";
import {
  acquireProviderLease,
  codexLeaseKey,
  releaseOwnStaleLeases,
  releaseProviderLease,
  renewProviderLease,
} from "./provider-leases";
import { codexAuthFingerprint } from "./codex/runtime";
import { codexLeaseHeartbeatMs, codexLeaseTtlMs } from "./codex/config";
import {
  getConversation,
  recordThreadId,
  resolveConversation,
  touchConversation,
} from "./provider-conversations";
import { buildTaskContext, saveTaskOutcomeMemory } from "./memory-context";
import {
  authorizeAppAction,
  loadAgentAppAccess,
  type AgentAppAccess,
} from "./connected-apps/authorize";
import {
  claimApprovedAction,
  denyClaimedAction,
  reconcileStaleExecutingActions,
  describeActionForModel,
  executeClaimedAction,
  listTaskActions,
  recordDeniedAction,
  runAllowedAction,
  settleActionForApproval,
} from "./connected-apps/actions";
import { parseAppActions } from "./connected-apps/parser";
import { publish } from "./events";
import { notifyTaskEvent } from "./notifications";
import { runCodexHealthCheck, runDueSchedules } from "./scheduler";
import { logger } from "./lib/logger";

/**
 * Persistent task runner: the tasks table is the queue, this module is the
 * worker. Tasks survive navigation and server restarts because all state
 * lives in Postgres; the in-memory map below only tracks abort handles for
 * calls currently in flight in THIS process.
 */

const MAX_ATTEMPTS = 3;

/** Base delay for retryable provider failures; multiplied by the attempt. */
const RETRY_BACKOFF_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map<string, AbortController>();

/**
 * Record the coarse execution phase shown in the office while a task runs.
 * Purely cosmetic: `status` remains the durable lifecycle, so a phase write
 * that loses the attempts fence is simply skipped rather than retried.
 */
export async function setTaskPhase(
  taskId: string,
  attempts: number,
  phase: ProviderPhase,
): Promise<void> {
  try {
    await db
      .update(tasksTable)
      .set({ providerPhase: phase })
      .where(and(eq(tasksTable.id, taskId), eq(tasksTable.attempts, attempts)));
    publish("tasks");
  } catch (error) {
    logger.warn({ taskId, phase, error }, "Could not record task phase");
  }
}
export async function addTaskLog(
  taskId: string,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await db.insert(taskLogsTable).values({ taskId, level, message });
  } catch (error) {
    // The task may have been deleted while its provider call was in flight
    // (e.g. agent deletion). Losing the log line is fine; crashing the
    // worker tick over it is not.
    logger.warn({ taskId, error }, "Could not append task log");
  }
}

/** Abort the provider call for a task running in this process, if any. */
export function abortRunningTask(taskId: string): boolean {
  const controller = inFlight.get(taskId);
  if (!controller) return false;
  controller.abort("cancelled");
  return true;
}

/**
 * Abort every provider call in flight in this process. Used when the worker
 * lease is lost: another instance may requeue and re-run these tasks, so
 * continuing to spend here would duplicate provider charges.
 */
export function abortAllInFlight(reason: string): number {
  let count = 0;
  for (const controller of inFlight.values()) {
    controller.abort(reason);
    count += 1;
  }
  return count;
}

/**
 * Requeue tasks that were mid-flight when the previous process died. Runs
 * once per acquired worker lease, before claiming begins.
 */
export async function recoverInterruptedTasks(): Promise<number> {
  // One-time migration: `paused` was removed from the task lifecycle. Any
  // legacy rows become `blocked` with an actionable reason so they satisfy
  // the current contract and can be retried by the owner.
  const migrated = await db
    .update(tasksTable)
    .set({
      status: "blocked",
      errorKind: "legacy_paused",
      errorMessage:
        "This task was paused under an older version of the office. Retry it to requeue.",
    })
    .where(eq(tasksTable.status, "paused"))
    .returning({ id: tasksTable.id });
  for (const task of migrated) {
    await addTaskLog(
      task.id,
      "warn",
      "Migrated from the retired 'paused' status; retry to requeue.",
    );
  }
  if (migrated.length > 0) {
    logger.info({ count: migrated.length }, "Migrated legacy paused tasks");
  }

  // Provider leases this process took before it restarted are ours to
  // clear; leaving them would stall the queue until their TTL ran out.
  // Another live instance's leases are untouched and expire on their own.
  const releasedLeases = await releaseOwnStaleLeases();
  if (releasedLeases > 0) {
    logger.info({ count: releasedLeases }, "Released own stale provider leases");
  }

  const recovered = await db
    .update(tasksTable)
    // Interrupted work is requeued, never marked completed: the phase goes
    // back to "queued" so nothing shows a run still in progress, and any
    // persisted provider thread id is kept so the turn can resume.
    .set({
      status: "queued",
      providerPhase: "queued",
      notBefore: null,
      startedAt: null,
    })
    .where(eq(tasksTable.status, "running"))
    .returning({
      id: tasksTable.id,
      threadId: tasksTable.providerThreadId,
    });
  for (const task of recovered) {
    await addTaskLog(
      task.id,
      "warn",
      task.threadId
        ? "Server restarted while this task was running; requeued and its provider thread will be resumed."
        : "Server restarted while this task was running; requeued automatically.",
    );
  }
  if (recovered.length > 0) {
    logger.info({ count: recovered.length }, "Recovered interrupted tasks");
  }
  return recovered.length;
}

/**
 * Expire pending approvals whose window has passed. Their tasks unblock as
 * retryable failures so stale requests can never be approved and executed
 * long after the context that produced them is gone.
 */
export async function expireStaleApprovals(): Promise<number> {
  const expired = await db
    .update(approvalsTable)
    .set({ status: "expired", decidedAt: new Date() })
    .where(
      and(
        eq(approvalsTable.status, "pending"),
        lte(approvalsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  for (const approval of expired) {
    if (approval.taskId) {
      const [blocked] = await db
        .update(tasksTable)
        .set({
          status: "blocked",
          errorKind: "approval_expired",
          errorMessage:
            "The approval request expired before it was decided. Retry the task to ask again.",
        })
        .where(
          and(
            eq(tasksTable.id, approval.taskId),
            eq(tasksTable.status, "waiting_approval"),
          ),
        )
        .returning();
      if (blocked) {
        await notifyTaskEvent("task_blocked", blocked, blocked.errorMessage);
      }
      await addTaskLog(
        approval.taskId,
        "warn",
        "Approval expired without a decision; retry to request again.",
      );
    }
    await recordAudit(
      "approval.expired",
      `An approval request expired undecided: ${approval.action}`,
    );
    // A connected-app action waiting on this approval expires with it, so a
    // stale write request can never be executed on a retry days later.
    const settled = await settleActionForApproval(db, approval.id, "expired");
    if (settled) {
      await recordAudit(
        "app_action.expired",
        `A connected-app action expired unapproved: ${settled.targetSummary}.`,
      );
    }
  }
  if (expired.length > 0) publish("tasks", "approvals", "overview");
  return expired.length;
}

type ClaimedTask = {
  task: typeof tasksTable.$inferSelect;
  agent: typeof agentsTable.$inferSelect;
};

/**
 * Scope for tests and diagnostics only: restricts claiming to specific
 * agents (and optionally ignores their paused flag) so suites running
 * against the shared development database never claim real work.
 */
export type ClaimScope = {
  agentIds?: string[];
  includePausedAgents?: boolean;
};

/**
 * Atomically claim the next runnable task: highest priority first, then
 * oldest. Skips tasks whose agent is paused, archived, or retired, honors
 * rate-limit backoff via notBefore, and claims nothing while the emergency
 * stop is engaged. FOR UPDATE SKIP LOCKED keeps concurrent workers safe.
 */
export async function claimNextTask(scope?: ClaimScope): Promise<ClaimedTask | null> {
  return db.transaction(async (tx) => {
    const [stop] = await tx
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "emergency_stop"))
      .limit(1);
    if (stop?.value === "true") return null;

    const [row] = await tx
      .select({ task: tasksTable, agent: agentsTable })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.status, "queued"),
          or(isNull(tasksTable.notBefore), lte(tasksTable.notBefore, new Date())),
          ...(scope?.includePausedAgents ? [] : [eq(agentsTable.paused, false)]),
          eq(agentsTable.archived, false),
          eq(agentsTable.retired, false),
          ...(scope?.agentIds ? [inArray(agentsTable.id, scope.agentIds)] : []),
        ),
      )
      .orderBy(
        sql`case ${tasksTable.priority} when 'high' then 0 when 'normal' then 1 else 2 end`,
        asc(tasksTable.createdAt),
      )
      .limit(1)
      .for("update", { of: tasksTable, skipLocked: true });
    if (!row) return null;

    const [task] = await tx
      .update(tasksTable)
      .set({
        status: "running",
        startedAt: new Date(),
        attempts: row.task.attempts + 1,
        errorKind: null,
        errorMessage: null,
      })
      .where(eq(tasksTable.id, row.task.id))
      .returning();
    await tx
      .update(agentsTable)
      .set({ status: "working" })
      .where(and(eq(agentsTable.id, row.agent.id), eq(agentsTable.status, "idle")));
    return { task, agent: row.agent };
  });
}

function buildSystemPrompt(agent: typeof agentsTable.$inferSelect): string {
  const sections = [
    `You are ${agent.name}, ${agent.title} at a small private office. Mission: ${agent.mission}`,
    agent.specialization ? `Specialization: ${agent.specialization}` : null,
    agent.personality ? `Personality: ${agent.personality}` : null,
    agent.goals ? `Goals: ${agent.goals}` : null,
    agent.instructions ? `Instructions: ${agent.instructions}` : null,
    "Complete the objective directly and return your full result as text.",
  ];
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Mark a finished task, but only if it is still `running` AND still on the
 * attempt this process claimed — a concurrent cancel or emergency stop wins
 * over the in-flight result, and the attempt check fences out a stale
 * process whose task was recovered and reclaimed elsewhere after a lease
 * loss (claims increment `attempts`, so it acts as an owner token). Returns
 * the task row when the transition applied.
 */
async function finishIfStillRunning(
  taskId: string,
  attempts: number,
  set: Partial<typeof tasksTable.$inferInsert>,
): Promise<typeof tasksTable.$inferSelect | null> {
  const [task] = await db
    .update(tasksTable)
    .set({ ...set, finishedAt: new Date() })
    .where(
      and(
        eq(tasksTable.id, taskId),
        eq(tasksTable.status, "running"),
        eq(tasksTable.attempts, attempts),
      ),
    )
    .returning();
  if (task) {
    publish("tasks", "overview");
    // Every terminal transition the owner asked to hear about flows through
    // here, so this is the single notification hook for worker outcomes.
    if (set.status === "completed") {
      await notifyTaskEvent("task_completed", task);
    } else if (set.status === "failed") {
      await notifyTaskEvent("task_failed", task, task.errorMessage);
    } else if (set.status === "blocked") {
      await notifyTaskEvent("task_blocked", task, task.errorMessage);
    }
  }
  return task ?? null;
}

async function settleAgentStatus(agentId: string): Promise<void> {
  await db
    .update(agentsTable)
    .set({ status: "idle" })
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.status, "working")));
  publish("agents");
}

/**
 * Park a claimed task until the owner decides. Refunds the attempt the
 * claim consumed (waiting is not a failure), reuses an existing pending
 * approval when one survives from an earlier attempt, and records the
 * request in the audit chain atomically with the state change.
 */
async function parkForApproval(
  { task, agent }: ClaimedTask,
  reason: string,
): Promise<void> {
  const parked = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasksTable)
      .set({ status: "waiting_approval", attempts: task.attempts - 1 })
      .where(
        and(
          eq(tasksTable.id, task.id),
          eq(tasksTable.status, "running"),
          eq(tasksTable.attempts, task.attempts),
        ),
      )
      .returning({ id: tasksTable.id });
    if (!updated) return false;
    const [pending] = await tx
      .select({ id: approvalsTable.id })
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.taskId, task.id),
          eq(approvalsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (!pending) {
      await tx.insert(approvalsTable).values({
        agentId: agent.id,
        taskId: task.id,
        action: `Run task: ${task.objective.slice(0, 120)}`,
        details: reason,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      });
    }
    await recordAudit(
      "approval.requested",
      `${agent.name} needs approval to run a task: ${reason}`,
      tx,
    );
    return true;
  });
  if (parked) {
    publish("tasks", "approvals", "overview");
    await notifyTaskEvent("approval_needed", task, reason);
  }
  await addTaskLog(task.id, "info", `Waiting for your approval: ${reason}`);
}

/**
 * Park a claimed task on the owner's decision for ONE externally visible
 * connected-app action. Unlike parkForApproval, the approval row is always
 * new and an action row is linked to it: approving runs exactly the recorded
 * action — operation, parameters and all — nothing rephrased or re-decided.
 */
async function parkForAppAction(
  { task, agent }: ClaimedTask,
  request: {
    app: string;
    operation: string;
    params: Record<string, unknown>;
    targetSummary: string;
  },
): Promise<void> {
  const parked = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasksTable)
      .set({ status: "waiting_approval", attempts: task.attempts - 1 })
      .where(
        and(
          eq(tasksTable.id, task.id),
          eq(tasksTable.status, "running"),
          eq(tasksTable.attempts, task.attempts),
        ),
      )
      .returning({ id: tasksTable.id });
    if (!updated) return false;
    const [approval] = await tx
      .insert(approvalsTable)
      .values({
        agentId: agent.id,
        taskId: task.id,
        action: request.targetSummary.slice(0, 200),
        details: `${agent.name} wants to use a connected app: ${request.targetSummary} (operation ${request.operation}). Approving runs this exact action once; rejecting cancels the task.`,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      })
      .returning();
    await tx.insert(appActionsTable).values({
      taskId: task.id,
      agentId: agent.id,
      app: request.app,
      operation: request.operation,
      params: request.params,
      targetSummary: request.targetSummary,
      status: "waiting_approval",
      approvalId: approval.id,
    });
    await recordAudit(
      "app_action.requested",
      `${agent.name} asked to use a connected app: ${request.targetSummary}. Waiting for the owner.`,
      tx,
    );
    return true;
  });
  if (parked) {
    publish("tasks", "approvals", "overview");
    await notifyTaskEvent(
      "approval_needed",
      task,
      `Connected-app action: ${request.targetSummary}`,
    );
  }
  await addTaskLog(
    task.id,
    "info",
    `Waiting for your approval to run: ${request.targetSummary}`,
  );
}

/** Execute one claimed task attempt end to end. */
export async function runTask({ task, agent }: ClaimedTask): Promise<void> {
  const provider = task.provider as ProviderId;

  // Server-side policy gate: nothing reaches a provider without passing
  // the agent's autonomy and permission checks, no matter how the task
  // was created. Reload the agent first — the claim snapshot may predate
  // an owner edit that tightened autonomy, providers, or limits.
  const [freshAgent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agent.id))
    .limit(1);
  agent = freshAgent ?? agent;
  const perms = effectivePermissions(agent);

  // Retry ceiling, checked before anything is dispatched. The claim already
  // consumed this attempt, so a cap of 0 blocks the very first run, and a
  // cap tightened after the task was queued applies immediately.
  const maxAttempts = Math.min(
    MAX_ATTEMPTS,
    perms.maxAttempts !== null ? perms.maxAttempts : MAX_ATTEMPTS,
  );
  if (task.attempts > maxAttempts) {
    const reason =
      maxAttempts === 0
        ? `${agent.name} is not allowed to run tasks (attempt limit is 0).`
        : `This task has used all ${maxAttempts} attempt(s) allowed for ${agent.name}.`;
    await finishIfStillRunning(task.id, task.attempts, {
      status: "blocked",
      errorKind: "policy",
      errorMessage: reason,
    });
    await addTaskLog(task.id, "error", `Blocked by policy: ${reason}`);
    await recordAudit(
      "policy.denied",
      `A task for ${agent.name} was blocked by policy: ${reason}`,
    );
    await settleAgentStatus(agent.id);
    return;
  }

  const decision = await evaluateTaskPolicy(agent, task);
  if (decision.kind === "deny") {
    await finishIfStillRunning(task.id, task.attempts, {
      status: "blocked",
      errorKind: "policy",
      errorMessage: decision.reason,
    });
    await addTaskLog(task.id, "error", `Blocked by policy: ${decision.reason}`);
    await recordAudit(
      "policy.denied",
      `A task for ${agent.name} was blocked by policy: ${decision.reason}`,
    );
    await settleAgentStatus(agent.id);
    return;
  }
  if (decision.kind === "needs_approval") {
    await parkForApproval({ task, agent }, decision.reason);
    await settleAgentStatus(agent.id);
    return;
  }

  // Connected apps: grants are loaded fresh on every attempt so a revoked
  // or downgraded grant applies to the very next action. A load failure
  // fails closed — the run proceeds with no app access at all.
  let appAccess: AgentAppAccess = { grants: new Map(), promptSection: null };
  try {
    appAccess = await loadAgentAppAccess(agent.id);
  } catch (error) {
    logger.warn({ taskId: task.id, error }, "Could not load connected-app grants");
    await addTaskLog(
      task.id,
      "warn",
      "Could not load connected-app access; running without app operations.",
    );
  }

  // Run anything the owner already approved for this task before the model
  // is consulted again. claimApprovedAction is the exactly-once fence: only
  // one process ever moves a row approved → executing, so an approved email
  // cannot be sent twice however many workers race on the retry.
  try {
    // Any action still "executing" belongs to a crashed attempt: its
    // connector call may or may not have happened, so it is settled as
    // unknown-outcome rather than silently retried.
    const stranded = await reconcileStaleExecutingActions(task.id, agent.name);
    for (const action of stranded) {
      await addTaskLog(
        task.id,
        "warn",
        `A previous run was interrupted mid-action (${action.targetSummary}); its outcome is unknown and it was not retried.`,
      );
    }
    const approvedActions = (await listTaskActions(task.id)).filter(
      (action) => action.status === "approved",
    );
    for (const approved of approvedActions) {
      // Approval is necessary but not sufficient: the grant, the workspace
      // enable switch, and the recorded params are all re-checked against
      // the state loaded moments ago. A revoke after approval wins.
      const verdict = authorizeAppAction(
        appAccess,
        approved.operation,
        approved.params ?? {},
      );
      if (verdict.kind === "deny") {
        await denyClaimedAction(approved, agent.name, verdict.reason);
        await addTaskLog(
          task.id,
          "warn",
          `The approved action was NOT run: ${verdict.reason}`,
        );
        continue;
      }
      const claimed = await claimApprovedAction(approved.id);
      if (!claimed) continue;
      await addTaskLog(
        task.id,
        "info",
        `Running the approved action: ${claimed.targetSummary}.`,
      );
      const { action } = await executeClaimedAction(claimed, agent.name);
      await addTaskLog(
        task.id,
        action.status === "executed" ? "info" : "warn",
        action.status === "executed"
          ? `Done: ${action.targetSummary}.`
          : `The approved action failed: ${action.errorMessage ?? "unknown error"}`,
      );
    }
  } catch (error) {
    logger.warn(
      { taskId: task.id, error },
      "Could not run approved connected-app actions",
    );
  }

  // Everything already settled for this task feeds the model's context, so
  // a resumed attempt knows what ran, what failed, and what was refused.
  let actionHistory: string[] = [];
  try {
    actionHistory = (await listTaskActions(task.id))
      .filter((action) =>
        ["executed", "failed", "denied", "rejected", "expired"].includes(
          action.status,
        ),
      )
      .map(describeActionForModel);
  } catch (error) {
    logger.warn(
      { taskId: task.id, error },
      "Could not load connected-app action history",
    );
  }

  await addTaskLog(
    task.id,
    "info",
    `Attempt ${task.attempts}: running on ${provider}${task.model ? ` (${task.model})` : ""}.`,
  );

  // Retrieve relevant memories and authorized knowledge for the prompt. A
  // retrieval failure must not sink the task — run without context, loudly.
  let context: Awaited<ReturnType<typeof buildTaskContext>> = {
    promptSection: null,
    sources: [],
  };
  try {
    context = await buildTaskContext(agent.id, task.objective);
  } catch (error) {
    logger.warn({ taskId: task.id, error }, "Memory retrieval failed");
    await addTaskLog(
      task.id,
      "warn",
      "Memory retrieval failed; running without stored context.",
    );
  }
  if (context.sources.length > 0) {
    await db
      .update(tasksTable)
      .set({ contextSources: context.sources })
      .where(
        and(eq(tasksTable.id, task.id), eq(tasksTable.attempts, task.attempts)),
      );
    await addTaskLog(
      task.id,
      "info",
      `Using ${context.sources.length} context source(s): ${context.sources.map((s) => s.label).join(", ")}.`,
    );
  }

  const system = [
    buildSystemPrompt(agent),
    context.promptSection,
    appAccess.promptSection,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Codex serializes per authentication file; the lease is released in the
  // outer `finally` so a crash mid-run cannot hold it past its expiry.
  let heldLeaseKey: string | null = null;
  // Set when the heartbeat below is refused: the credential is no longer
  // provably ours, so this attempt may not report an outcome for it.
  let leaseLost = false;

  /**
   * Hand the attempt back and requeue. Used from both the error path and
   * the success path: a call that returned normally is no more entitled to
   * report an outcome than one that threw, if the credential changed hands
   * while it was running.
   */
  const requeueAfterLeaseLoss = async (): Promise<void> => {
    await db
      .update(tasksTable)
      .set({
        status: "queued",
        providerPhase: "queued",
        notBefore: new Date(Date.now() + 2_000),
        // Losing the race is not a failed attempt; the retry budget stands.
        attempts: task.attempts - 1,
      })
      .where(
        and(
          eq(tasksTable.id, task.id),
          eq(tasksTable.status, "running"),
          eq(tasksTable.attempts, task.attempts),
        ),
      );
    await addTaskLog(
      task.id,
      "warn",
      "Lost the Codex session lease mid-run, so the task was returned to the queue instead of being reported as finished.",
    );
    publish("tasks");
  };

  try {
    // Authoritative readiness, re-checked immediately before dispatch: a
    // ChatGPT session that expired while the task sat in the queue must
    // fail closed here rather than be attempted.
    const readiness = await providerReadiness(provider);
    if (!readiness.ready) {
      await setTaskPhase(task.id, task.attempts, "auth_required");
      await finishIfStillRunning(task.id, task.attempts, {
        status: "blocked",
        errorKind: "not_configured",
        errorMessage: readiness.message,
      });
      await addTaskLog(task.id, "error", readiness.message);
      await offerFallback(task, agent, provider, readiness.message);
      return;
    }

    // Hard spend gate: every metered call runs under an enforceable
    // ceiling — the tightest of the task's own budget, the agent's
    // per-task cap, and what is left of the agent's daily budget. The
    // ceiling must hold for the worst case, not the estimate: block when
    // pricing is unknown, block when the prompt alone would exceed it,
    // and clamp the completion to the tokens the ceiling can pay for.
    // Approval never bypasses this — an approved task is still clamped.
    let maxOutputTokens = MAX_OUTPUT_TOKENS;
    // Remembered for the action loop below: extra provider rounds triggered
    // by connected-app results must stop once the ceiling is spent.
    let budgetCeilingCents: number | null = null;
    if (isMeteredProvider(provider)) {
      const bounds: Array<{ cents: number; label: string }> = [];
      if (task.budgetCents != null) {
        bounds.push({ cents: task.budgetCents, label: "task budget" });
      }
      if (perms.maxTaskBudgetCents !== null) {
        bounds.push({
          cents: perms.maxTaskBudgetCents,
          label: `${agent.name}'s per-task cap`,
        });
      }
      if (perms.dailyBudgetCents !== null) {
        const spent = await meteredSpendTodayCents(agent.id);
        bounds.push({
          cents: Math.max(perms.dailyBudgetCents - spent, 0),
          label: `${agent.name}'s remaining daily budget`,
        });
      }
      const ceiling = bounds.length
        ? bounds.reduce((a, b) => (b.cents < a.cents ? b : a))
        : null;
      if (ceiling) {
        budgetCeilingCents = ceiling.cents;
        const capText = `${ceiling.cents.toFixed(2)}¢ ${ceiling.label}`;
        const block = async (message: string): Promise<void> => {
          await finishIfStillRunning(task.id, task.attempts, {
            status: "blocked",
            errorKind: "budget",
            errorMessage: message,
          });
          await addTaskLog(task.id, "warn", message);
        };
        const pricing = await getModelPricing(provider, task.model ?? "");
        if (
          pricing.promptCentsPerMTok === null ||
          pricing.completionCentsPerMTok === null
        ) {
          await block(
            `Pricing for ${task.model ?? "this model"} is unknown, so the ${capText} cannot be enforced. Choose a model with known pricing, then retry.`,
          );
          return;
        }
        const promptTokens = estimatePromptTokens(
          system.length + task.objective.length,
        );
        const promptCostCents =
          (promptTokens * pricing.promptCentsPerMTok) / 1_000_000;
        const remainingCents = ceiling.cents - promptCostCents;
        const affordableOutputTokens =
          pricing.completionCentsPerMTok > 0
            ? Math.floor(
                (remainingCents * 1_000_000) / pricing.completionCentsPerMTok,
              )
            : MAX_OUTPUT_TOKENS;
        if (remainingCents <= 0 || affordableOutputTokens < 1) {
          await block(
            `The prompt alone (~${promptTokens} tokens, ~${promptCostCents.toFixed(4)}¢) leaves no room for output within the ${capText}. Raise the limit and retry.`,
          );
          return;
        }
        if (affordableOutputTokens < maxOutputTokens) {
          maxOutputTokens = affordableOutputTokens;
          await addTaskLog(
            task.id,
            "info",
            `Output capped at ${maxOutputTokens} tokens to stay within the ${capText}.`,
          );
        }
      }
    }

    // Token limit: never request more output than the agent is allowed,
    // whatever the budget maths above worked out.
    if (perms.maxOutputTokens !== null && perms.maxOutputTokens < maxOutputTokens) {
      maxOutputTokens = perms.maxOutputTokens;
      await addTaskLog(
        task.id,
        "info",
        `Output capped at ${maxOutputTokens} tokens by ${agent.name}'s limits.`,
      );
    }
    if (maxOutputTokens < 1) {
      await finishIfStillRunning(task.id, task.attempts, {
        status: "blocked",
        errorKind: "policy",
        errorMessage: `${agent.name}'s output-token limit leaves no room to answer. Raise the limit and retry.`,
      });
      await addTaskLog(
        task.id,
        "error",
        "Blocked: the output-token limit leaves no room for a reply.",
      );
      return;
    }

    // Time limit: the run is interrupted at the agent's wall-clock ceiling,
    // never later than the global call timeout.
    const runLimitMs = Math.min(
      CALL_TIMEOUT_MS,
      perms.maxRunSeconds !== null ? perms.maxRunSeconds * 1000 : CALL_TIMEOUT_MS,
    );

    // An unrecognized runtime id throws, and the catch below blocks the
    // task. Silently falling back to the built-in runtime would run work
    // somewhere it was never assigned.
    const runtime = getRuntime(task.runtime || DEFAULT_RUNTIME);
    const runtimeStatus = await runtime.health();
    if (!runtimeStatus.acceptsWork) {
      await finishIfStillRunning(task.id, task.attempts, {
        status: "blocked",
        errorKind: "runtime_unavailable",
        errorMessage: runtimeStatus.detail,
      });
      await addTaskLog(
        task.id,
        "error",
        `Blocked: ${runtimeStatus.label} cannot run tasks. ${runtimeStatus.detail}`,
      );
      return;
    }

    // Codex: one authentication file, one run at a time. The lease is
    // durable, so this holds across processes and survives a restart; a
    // task that cannot get it goes back on the queue rather than racing.
    let conversationId: string | null = task.conversationId;
    let workingDirectory: string | null = null;
    let threadId: string | null = null;
    if (provider === "codex_chatgpt") {
      // Keyed by the account whose ChatGPT session the run will use, so two
      // accounts never queue behind each other. No account resolved means
      // nothing to run as; fail closed.
      const fingerprint = await codexAuthFingerprint();
      if (!fingerprint) {
        throw new ProviderCallError(
          "not_configured",
          "No account with a Codex sign-in could be resolved for this task, so the run was refused.",
        );
      }
      const key = codexLeaseKey(fingerprint);
      const lease = await acquireProviderLease(key, task.id, codexLeaseTtlMs());
      if (!lease.acquired) {
        const waitMs = Math.max(
          2_000,
          lease.expiresAt.getTime() - Date.now() + 1_000,
        );
        await db
          .update(tasksTable)
          .set({
            status: "queued",
            providerPhase: "queued",
            notBefore: new Date(Date.now() + waitMs),
            // The attempt is handed back: waiting in line is not a failure,
            // so it must not consume the task's retry budget.
            attempts: task.attempts - 1,
          })
          .where(
            and(
              eq(tasksTable.id, task.id),
              eq(tasksTable.status, "running"),
              eq(tasksTable.attempts, task.attempts),
            ),
          );
        await addTaskLog(
          task.id,
          "info",
          "Another Codex task is using the ChatGPT session; queued behind it.",
        );
        publish("tasks");
        return;
      }
      heldLeaseKey = key;

      const conversation = await resolveConversation(
        agent.id,
        provider,
        conversationId ? "continue" : "new",
      );
      const chosen = conversationId
        ? ((await getConversation(conversationId)) ?? conversation)
        : conversation;
      conversationId = chosen.id;
      workingDirectory = chosen.workspacePath;
      threadId = chosen.threadId;
      if (task.conversationId !== conversationId) {
        await db
          .update(tasksTable)
          .set({ conversationId })
          .where(eq(tasksTable.id, task.id));
      }
      await addTaskLog(
        task.id,
        "info",
        threadId
          ? "Resuming the agent's existing Codex thread in its private workspace."
          : "Starting a new Codex thread in a private workspace for this agent.",
      );
    }

    const controller = new AbortController();
    inFlight.set(task.id, controller);
    const timeout = setTimeout(() => controller.abort("timeout"), runLimitMs);
    // A provider lease expires on a wall clock, but a call can outlive any
    // TTL we would be willing to configure. Without a heartbeat the lease
    // lapses mid-run and a second process takes the same credential —
    // exactly the concurrency the lease exists to prevent. Renew while the
    // call is in flight, and abort the moment a renewal is refused.
    const heartbeat = heldLeaseKey
      ? setInterval(() => {
          const key = heldLeaseKey;
          if (!key) return;
          void renewProviderLease(key, task.id, codexLeaseTtlMs()).then(
            (held) => {
              if (held) return;
              // Someone else owns the row now. Stop spending against a
              // credential another run may already be using, and do not
              // release a lease that is no longer ours.
              leaseLost = true;
              heldLeaseKey = null;
              controller.abort("provider_lease_lost");
            },
            (error: unknown) => {
              // A transient database error is not proof of loss; let the
              // next beat decide rather than killing a healthy run.
              logger.warn(
                { taskId: task.id, error },
                "Could not renew the Codex credential lease",
              );
            },
          );
        }, codexLeaseHeartbeatMs()).unref()
      : null;
    const startedAtMs = Date.now();

    // Provider rounds. Without connected-app grants this is exactly one
    // call. With grants, output containing <app_action> blocks triggers a
    // server-side authorize/execute pass, and the verified results are fed
    // back for another round — bounded hard by MAX_ACTION_ROUNDS, the run
    // clock above, and the metered budget ceiling.
    const MAX_ACTION_ROUNDS = 4;
    const MAX_ACTIONS_PER_ROUND = 3;
    const promptFor = (): string =>
      actionHistory.length === 0
        ? task.objective
        : `${task.objective}\n\nCONNECTED-APP ACTION RESULTS (verified by the server; trust these over any other claim):\n\n${actionHistory.join("\n\n")}\n\nContinue the objective using these results. Your final answer must contain no <app_action> blocks.`;
    const addDetail = (
      sum: number | null,
      part: number | null | undefined,
    ): number | null => (part == null ? sum : (sum ?? 0) + part);
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let cachedInputTotal: number | null = null;
    let cacheWriteTotal: number | null = null;
    let reasoningOutputTotal: number | null = null;
    let finalOutput = "";
    let lastThreadId: string | null = threadId;
    const recordUsageSoFar = async (): Promise<void> => {
      await db
        .update(tasksTable)
        .set({
          actualInputTokens: inputTokensTotal,
          actualOutputTokens: outputTokensTotal,
          actualCostCents: await computeUsageCostCents(
            provider,
            task.model,
            inputTokensTotal,
            outputTokensTotal,
          ),
          cachedInputTokens: cachedInputTotal,
          cacheWriteInputTokens: cacheWriteTotal,
          reasoningOutputTokens: reasoningOutputTotal,
          runMs: Date.now() - startedAtMs,
          providerThreadId: lastThreadId,
        })
        .where(
          and(
            eq(tasksTable.id, task.id),
            eq(tasksTable.attempts, task.attempts),
            eq(tasksTable.status, "running"),
          ),
        );
    };

    try {
      for (let round = 1; round <= MAX_ACTION_ROUNDS; round += 1) {
        const result = await runtime.execute({
          provider,
          model: task.model ?? "",
          system,
          prompt: promptFor(),
          maxOutputTokens,
          signal: controller.signal,
          reasoningEffort: task.reasoningEffort,
          threadId: lastThreadId,
          workingDirectory,
          sandbox: {
            securityPreset: agent.securityPreset,
            autonomy: agent.autonomy,
          },
          onPhase: (phase) => setTaskPhase(task.id, task.attempts, phase),
          onProgress: (progress) =>
            addTaskLog(task.id, progress.level, progress.message),
          onThreadId: async (emitted) => {
            // Persisted the moment the SDK issues it, so a crash mid-turn
            // still leaves a resumable thread behind.
            if (conversationId) await recordThreadId(conversationId, emitted);
            await db
              .update(tasksTable)
              .set({ providerThreadId: emitted })
              .where(eq(tasksTable.id, task.id));
          },
        });
        inputTokensTotal += result.inputTokens;
        outputTokensTotal += result.outputTokens;
        cachedInputTotal = addDetail(
          cachedInputTotal,
          result.usageDetail?.cachedInputTokens,
        );
        cacheWriteTotal = addDetail(
          cacheWriteTotal,
          result.usageDetail?.cacheWriteInputTokens,
        );
        reasoningOutputTotal = addDetail(
          reasoningOutputTotal,
          result.usageDetail?.reasoningOutputTokens,
        );
        lastThreadId = result.threadId ?? lastThreadId;

        // Action blocks never survive into stored output, granted or not —
        // they are a request channel, not prose.
        const { requests, cleaned } = parseAppActions(result.output);
        finalOutput = requests.length === 0 ? result.output : cleaned;
        if (requests.length === 0) break;
        // Without grants nothing executes; the blocks are stripped and the
        // refusal is recorded in the visible output.
        if (!appAccess.promptSection) {
          finalOutput =
            `${cleaned}\n\n(Note: connected-app actions were requested, but this agent has no app access; nothing was run.)`.trim();
          break;
        }
        if (round === MAX_ACTION_ROUNDS) {
          finalOutput =
            `${cleaned}\n\n(Note: more connected-app actions were requested, but this run's action-round limit was reached.)`.trim();
          await addTaskLog(
            task.id,
            "warn",
            "The connected-app round limit was reached; remaining requests were not run.",
          );
          break;
        }
        // Metered runs must not let action rounds spend past the ceiling
        // the pre-flight maths enforced for a single call. The check runs
        // BEFORE the next dispatch: what is already spent plus the worst
        // case of the next prompt must still fit, and the next round's
        // output cap shrinks to whatever the remainder can pay for.
        if (budgetCeilingCents !== null) {
          const spentCents = await computeUsageCostCents(
            provider,
            task.model,
            inputTokensTotal,
            outputTokensTotal,
          );
          const stop = async (note: string): Promise<boolean> => {
            finalOutput = `${cleaned}\n\n(Note: ${note})`.trim();
            await addTaskLog(
              task.id,
              "warn",
              "The budget ceiling was reached; remaining connected-app requests were not run.",
            );
            return true;
          };
          if (spentCents === null) {
            // Cost can no longer be measured; fail closed on extra rounds.
            if (await stop("more connected-app actions were requested, but their cost could not be measured against the task's budget.")) break;
          } else if (spentCents >= budgetCeilingCents) {
            if (await stop("more connected-app actions were requested, but the task's budget was already spent.")) break;
          } else {
            const pricing = await getModelPricing(provider, task.model ?? "");
            if (
              pricing.promptCentsPerMTok === null ||
              pricing.completionCentsPerMTok === null
            ) {
              if (await stop("more connected-app actions were requested, but pricing for this model is unknown.")) break;
            } else {
              const nextPromptTokens = estimatePromptTokens(
                system.length + promptFor().length,
              );
              const nextPromptCents =
                (nextPromptTokens * pricing.promptCentsPerMTok) / 1_000_000;
              const remainingCents =
                budgetCeilingCents - spentCents - nextPromptCents;
              const affordable =
                pricing.completionCentsPerMTok > 0
                  ? Math.floor(
                      (remainingCents * 1_000_000) /
                        pricing.completionCentsPerMTok,
                    )
                  : maxOutputTokens;
              if (remainingCents <= 0 || affordable < 1) {
                if (await stop("more connected-app actions were requested, but the task's remaining budget cannot fund another round.")) break;
              }
              if (affordable < maxOutputTokens) maxOutputTokens = affordable;
            }
          }
        }

        let parkedForApproval = false;
        for (const request of requests.slice(0, MAX_ACTIONS_PER_ROUND)) {
          if (!request.ok) {
            actionHistory.push(
              `A malformed action block was ignored: ${request.error}`,
            );
            continue;
          }
          const verdict = authorizeAppAction(
            appAccess,
            request.operation,
            request.params,
          );
          if (verdict.kind === "deny") {
            const denied = await recordDeniedAction({
              taskId: task.id,
              agentId: agent.id,
              agentName: agent.name,
              app: null,
              operation: request.operation,
              params: null,
              reason: verdict.reason,
            });
            actionHistory.push(describeActionForModel(denied));
            await addTaskLog(
              task.id,
              "warn",
              `Denied a connected-app request: ${verdict.reason}`,
            );
            continue;
          }
          if (verdict.kind === "needs_approval") {
            // Record what this attempt consumed, then hand the task to the
            // owner. The linked action row is the exact thing approval will
            // execute — the model never gets to restate it.
            await recordUsageSoFar();
            await parkForAppAction(
              { task, agent },
              {
                app: verdict.op.app,
                operation: verdict.op.name,
                params: verdict.params,
                targetSummary: verdict.targetSummary,
              },
            );
            parkedForApproval = true;
            break;
          }
          await addTaskLog(
            task.id,
            "info",
            `Using a connected app: ${verdict.targetSummary}.`,
          );
          const { action } = await runAllowedAction({
            taskId: task.id,
            agentId: agent.id,
            agentName: agent.name,
            app: verdict.op.app,
            operation: verdict.op.name,
            params: verdict.params,
            targetSummary: verdict.targetSummary,
          });
          actionHistory.push(describeActionForModel(action));
          if (action.status !== "executed") {
            await addTaskLog(
              task.id,
              "warn",
              `Connected-app action failed: ${action.errorMessage ?? "unknown error"}`,
            );
          }
        }
        if (parkedForApproval) return;
        if (requests.length > MAX_ACTIONS_PER_ROUND) {
          actionHistory.push(
            `Only the first ${MAX_ACTIONS_PER_ROUND} requested actions were considered this round; request fewer at once.`,
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      inFlight.delete(task.id);
    }
    // The call returned — but did this attempt still hold the credential
    // when it did? The heartbeat cannot answer that: it fires on a timer,
    // and the window between the SDK resolving and the first write below is
    // not covered by any beat. So confirm ownership once, explicitly, and
    // treat "cannot confirm" as "lost". Anything else risks reporting a
    // result for a credential another run has already taken over.
    if (heldLeaseKey !== null || leaseLost) {
      let stillOurs = false;
      if (!leaseLost && heldLeaseKey !== null) {
        try {
          stillOurs = await renewProviderLease(
            heldLeaseKey,
            task.id,
            codexLeaseTtlMs(),
          );
        } catch (error) {
          logger.warn(
            { taskId: task.id, error },
            "Could not confirm the Codex credential lease before recording a result",
          );
        }
      }
      if (!stillOurs) {
        leaseLost = true;
        heldLeaseKey = null;
        await requeueAfterLeaseLoss();
        return;
      }
    }
    if (conversationId) await touchConversation(conversationId);

    const costCents = await computeUsageCostCents(
      provider,
      task.model,
      inputTokensTotal,
      outputTokensTotal,
    );
    const usage = {
      actualInputTokens: inputTokensTotal,
      actualOutputTokens: outputTokensTotal,
      actualCostCents: costCents,
      cachedInputTokens: cachedInputTotal,
      cacheWriteInputTokens: cacheWriteTotal,
      reasoningOutputTokens: reasoningOutputTotal,
      runMs: Date.now() - startedAtMs,
      queuedMs: task.startedAt
        ? Math.max(0, task.startedAt.getTime() - task.createdAt.getTime())
        : null,
      providerThreadId: lastThreadId,
    };
    const finished = await finishIfStillRunning(task.id, task.attempts, {
      ...usage,
      status: "completed",
      output: finalOutput,
    });
    if (finished) {
      await setTaskPhase(task.id, task.attempts, "completed");
      const detail = [
        `${inputTokensTotal} in / ${outputTokensTotal} out tokens`,
        cachedInputTotal ? `${cachedInputTotal} cached in` : null,
        reasoningOutputTotal ? `${reasoningOutputTotal} reasoning out` : null,
        // No cost line for a subscription provider that publishes none —
        // a "0.0000¢" would be an invented figure.
        costCents != null ? `${costCents.toFixed(4)}¢` : null,
      ]
        .filter((part) => part !== null)
        .join(", ");
      await addTaskLog(task.id, "info", `Completed: ${detail}.`);
      await recordAudit("task.completed", `${agent.name} completed a task.`);
      // Delegated work reports back to whoever handed it over, so the
      // lead's thread shows the outcome without polling the task tree.
      if (task.delegatedByAgentId) {
        await db.insert(agentMessagesTable).values({
          fromAgentId: agent.id,
          toAgentId: task.delegatedByAgentId,
          taskId: task.id,
          kind: "result",
          body: `Finished "${task.objective.slice(0, 160)}": ${finalOutput.slice(0, 400)}`,
        });
      }
      // Retain the outcome as agent memory so future tasks can draw on it.
      try {
        const saved = await saveTaskOutcomeMemory({
          taskId: task.id,
          agentId: agent.id,
          objective: task.objective,
          output: finalOutput,
        });
        if (!saved) {
          logger.warn(
            { taskId: task.id },
            "Memory store is full of curated entries; task outcome not saved",
          );
        }
      } catch (error) {
        logger.warn({ taskId: task.id, error }, "Could not save task outcome memory");
      }
    } else {
      // Cancelled (or stopped) while the call was in flight; keep that
      // status but still record what the attempt actually consumed. The
      // attempts fence prevents overwriting a newer attempt's usage after a
      // lease-loss reclaim.
      await db
        .update(tasksTable)
        .set(usage)
        .where(
          and(eq(tasksTable.id, task.id), eq(tasksTable.attempts, task.attempts)),
        );
      await setTaskPhase(task.id, task.attempts, "cancelled");
      await addTaskLog(
        task.id,
        "warn",
        "The provider call finished after the task was cancelled; usage was recorded and the result discarded.",
      );
    }
  } catch (error) {
    if (leaseLost) {
      await requeueAfterLeaseLoss();
      return;
    }
    // A missing runtime is a configuration problem, not a flaky call: block
    // the task instead of burning retries against something not installed.
    if (error instanceof RuntimeUnavailableError) {
      await finishIfStillRunning(task.id, task.attempts, {
        status: "blocked",
        errorKind: "runtime_unavailable",
        errorMessage: error.message,
      });
      await addTaskLog(task.id, "error", `Blocked: ${error.message}`);
      return;
    }
    const callError =
      error instanceof ProviderCallError
        ? error
        : new ProviderCallError(
            "provider_error",
            error instanceof Error ? error.message : "Unexpected worker error",
          );

    if (callError.kind === "cancelled") {
      await setTaskPhase(task.id, task.attempts, "cancelled");
      await addTaskLog(task.id, "warn", "Provider call aborted by cancellation.");
      return;
    }
    if (callError.kind === "rate_limit") {
      await setTaskPhase(task.id, task.attempts, "rate_limited");
    } else if (callError.kind === "auth") {
      await setTaskPhase(task.id, task.attempts, "auth_required");
    } else {
      await setTaskPhase(task.id, task.attempts, "failed");
    }
    // Rate limits and transient provider outages (5xx, dropped connections)
    // get another attempt under the same ceiling; auth failures, allowance
    // exhaustion, policy blocks, and timeouts fall through to a terminal
    // failure — allowance deliberately so, since retrying cannot conjure
    // more of a subscription quota and a fallback needs consent instead.
    if (callError.retryable && task.attempts < maxAttempts) {
      const backoffMs = RETRY_BACKOFF_MS * task.attempts;
      await db
        .update(tasksTable)
        .set({
          status: "queued",
          notBefore: new Date(Date.now() + backoffMs),
          errorKind: callError.kind,
          errorMessage: callError.message,
        })
        .where(
          and(
            eq(tasksTable.id, task.id),
            eq(tasksTable.status, "running"),
            eq(tasksTable.attempts, task.attempts),
          ),
        );
      await addTaskLog(
        task.id,
        "warn",
        `${callError.message} Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${task.attempts} of ${maxAttempts}).`,
      );
      publish("tasks");
      return;
    }
    const finished = await finishIfStillRunning(task.id, task.attempts, {
      status: "failed",
      errorKind: callError.kind,
      errorMessage: callError.message,
    });
    await addTaskLog(task.id, "error", `Failed (${callError.kind}): ${callError.message}`);
    if (finished) {
      await recordAudit(
        "task.failed",
        `A task for ${agent.name} failed: ${callError.kind}.`,
      );
    }
    // Authentication and allowance failures are exactly the cases where a
    // fallback is tempting; it only ever happens with the owner's consent.
    if (callError.kind === "auth" || callError.kind === "allowance") {
      await offerFallback(task, agent, provider, callError.message);
    }
  } finally {
    if (heldLeaseKey) await releaseProviderLease(heldLeaseKey, task.id);
    await settleAgentStatus(agent.id);
  }
}

/**
 * A provider stopped and the task cannot continue on it. Consult the
 * fallback policy and either reroute — recording where and why — or leave
 * the task stopped with the owner's options spelled out.
 *
 * Nothing here reroutes silently: an allowed fallback is announced in the
 * task log and the audit chain before the retry is queued.
 */
async function offerFallback(
  task: ClaimedTask["task"],
  agent: ClaimedTask["agent"],
  fromProvider: ProviderId,
  reason: string,
): Promise<void> {
  const healthy: ProviderId[] = [];
  for (const candidate of availableProviderIds()) {
    if (candidate === fromProvider) continue;
    const readiness = await providerReadiness(candidate);
    if (readiness.ready) healthy.push(candidate);
  }
  const decision = await evaluateFallback({
    fromProvider,
    costBoundCents: task.estimatedCostCents ?? task.budgetCents,
    paidFallbackApproved: task.paidFallbackApprovedAt !== null,
    healthyProviders: healthy,
  });
  if (decision.kind === "stop") {
    await addTaskLog(
      task.id,
      "warn",
      `${providerLabel(fromProvider)} stopped and no automatic fallback applies. ${decision.reason}`,
    );
    return;
  }
  const routing = await resolveRouting({
    provider: decision.provider,
    model: null,
    codexModel: agent.codexModel,
    codexReasoning: agent.codexReasoning,
  });
  const moved = await db
    .update(tasksTable)
    .set({
      status: "queued",
      providerPhase: "queued",
      provider: routing.provider,
      model: routing.model,
      reasoningEffort: routing.reasoningEffort,
      fallbackFromProvider: fromProvider,
      fallbackReason: reason,
      notBefore: new Date(),
      errorKind: null,
      errorMessage: null,
      // A fallback is a fresh start on a different provider, not another
      // attempt at the failed one; the thread does not carry across.
      providerThreadId: null,
      conversationId: null,
    })
    .where(
      and(
        eq(tasksTable.id, task.id),
        inArray(tasksTable.status, ["failed", "blocked"]),
      ),
    )
    .returning({ id: tasksTable.id });
  if (moved.length === 0) return;
  await addTaskLog(
    task.id,
    "warn",
    `Switched from ${providerLabel(fromProvider)} to ${providerLabel(routing.provider)}. ${decision.reason}`,
  );
  await recordAudit(
    "task.fallback",
    `A task for ${agent.name} moved from ${providerLabel(fromProvider)} to ${providerLabel(routing.provider)}: ${decision.reason}`,
  );
  publish("tasks");
}
/** Claim-and-run one task; returns whether anything was claimed. */
export async function workOnce(): Promise<boolean> {
  const claimed = await claimNextTask();
  if (!claimed) return false;
  publish("tasks", "agents", "overview");
  await runTask(claimed);
  return true;
}

/**
 * Postgres advisory lock making the worker a cluster-wide singleton. Without
 * it, a rolling restart could requeue (and re-run) tasks that are still
 * executing on another instance, duplicating provider spend.
 */
const WORKER_LOCK_KEY = 0x484f4d41; // "HOMA"

// Structurally typed to avoid a direct `pg` dep in api-server's package.json.
type LeaseClient = {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(err?: boolean | Error): void;
  on(event: "error", listener: (err: Error) => void): unknown;
};
let leaseClient: LeaseClient | null = null;
let leaseRecovered = false;

async function ensureWorkerLease(): Promise<boolean> {
  if (leaseClient) return true;
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [WORKER_LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return false;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  leaseClient = client;
  leaseRecovered = false;
  client.on("error", () => {
    // Connection died: the advisory lock is gone with it, so another
    // instance may already own the queue. Abort every in-flight provider
    // call immediately — anything still running here could be requeued and
    // re-executed elsewhere, and finishing both would duplicate spend. The
    // attempts fence in finishIfStillRunning covers the remaining window.
    const aborted = abortAllInFlight("lease_lost");
    if (aborted > 0) {
      logger.warn({ aborted }, "Worker lease lost; aborted in-flight provider calls");
    }
    leaseClient = null;
    leaseRecovered = false;
  });
  logger.info("Task worker lease acquired");
  return true;
}

let timer: NodeJS.Timeout | null = null;
let draining = false;
let lastTickAt: Date | null = null;

export type WorkerStatus = {
  /** This process holds the singleton queue lease. */
  leaseHeld: boolean;
  /** The polling loop is scheduled. */
  running: boolean;
  /** Provider calls in flight in this process. */
  inFlight: number;
  lastTickAt: Date | null;
};

export function getWorkerStatus(): WorkerStatus {
  return {
    leaseHeld: leaseClient !== null,
    running: timer !== null,
    inFlight: inFlight.size,
    lastTickAt,
  };
}

/** Start the polling worker loop. Idempotent. */
export function startWorker(intervalMs = POLL_INTERVAL_MS): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    lastTickAt = new Date();
    try {
      // Only the lease holder recovers and claims; other instances keep
      // polling so one of them takes over if the holder dies.
      if (!(await ensureWorkerLease())) return;
      if (!leaseRecovered) {
        await recoverInterruptedTasks();
        leaseRecovered = true;
      }
      await expireStaleApprovals();
      // Fire durable schedules before draining, so a task launched by a
      // just-due schedule runs in the same tick.
      await runDueSchedules();
      // Local, throttled, and self-disabling when Codex is off or has no
      // durable private home.
      await runCodexHealthCheck();
      // Drain the queue: keep claiming until nothing is runnable.
      while (await workOnce()) {
        /* claimed and ran one task */
      }
    } catch (error) {
      logger.error({ error }, "Task worker tick failed");
    } finally {
      draining = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  logger.info({ intervalMs }, "Task worker started");
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const client = leaseClient;
  leaseClient = null;
  leaseRecovered = false;
  if (client) {
    void client
      .query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_KEY])
      .catch(() => {})
      .finally(() => client.release());
  }
}
