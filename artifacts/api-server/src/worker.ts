import {
  agentsTable,
  auditEventsTable,
  db,
  pool,
  systemStateTable,
  taskLogsTable,
  tasksTable,
} from "@workspace/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  MAX_OUTPUT_TOKENS,
  ProviderCallError,
  callProvider,
} from "./execution";
import {
  computeUsageCostCents,
  estimatePromptTokens,
  getModelPricing,
  isConfigured,
  type ProviderId,
} from "./providers";
import { buildTaskContext, saveTaskOutcomeMemory } from "./memory-context";
import { logger } from "./lib/logger";

/**
 * Persistent task runner: the tasks table is the queue, this module is the
 * worker. Tasks survive navigation and server restarts because all state
 * lives in Postgres; the in-memory map below only tracks abort handles for
 * calls currently in flight in THIS process.
 */

const MAX_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const inFlight = new Map<string, AbortController>();

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

  const recovered = await db
    .update(tasksTable)
    .set({ status: "queued", notBefore: null, startedAt: null })
    .where(eq(tasksTable.status, "running"))
    .returning({ id: tasksTable.id });
  for (const task of recovered) {
    await addTaskLog(
      task.id,
      "warn",
      "Server restarted while this task was running; requeued automatically.",
    );
  }
  if (recovered.length > 0) {
    logger.info({ count: recovered.length }, "Recovered interrupted tasks");
  }
  return recovered.length;
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
  return task ?? null;
}

async function settleAgentStatus(agentId: string): Promise<void> {
  await db
    .update(agentsTable)
    .set({ status: "idle" })
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.status, "working")));
}

/** Execute one claimed task attempt end to end. */
export async function runTask({ task, agent }: ClaimedTask): Promise<void> {
  const provider = task.provider as ProviderId;
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

  const system = context.promptSection
    ? `${buildSystemPrompt(agent)}\n\n${context.promptSection}`
    : buildSystemPrompt(agent);

  try {
    if (!isConfigured(provider)) {
      const message = `${provider === "claude_max" ? "Claude" : "OpenRouter"} is not configured; add the credential and retry.`;
      await finishIfStillRunning(task.id, task.attempts, {
        status: "blocked",
        errorKind: "not_configured",
        errorMessage: message,
      });
      await addTaskLog(task.id, "error", message);
      return;
    }

    // Hard budget gate: the budget is a spending cap, so it must hold for
    // the worst case, not the estimate. Block when pricing is unknown, block
    // when the prompt alone would exceed the cap, and clamp the completion
    // to the tokens the remaining budget can actually pay for.
    let maxOutputTokens = MAX_OUTPUT_TOKENS;
    if (task.budgetCents != null && provider !== "claude_max") {
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
          `Pricing for ${task.model ?? "this model"} is unknown, so the ${task.budgetCents.toFixed(2)}¢ budget cannot be enforced. Remove the budget or choose a model with known pricing, then retry.`,
        );
        return;
      }
      const promptTokens = estimatePromptTokens(
        system.length + task.objective.length,
      );
      const promptCostCents =
        (promptTokens * pricing.promptCentsPerMTok) / 1_000_000;
      const remainingCents = task.budgetCents - promptCostCents;
      const affordableOutputTokens =
        pricing.completionCentsPerMTok > 0
          ? Math.floor((remainingCents * 1_000_000) / pricing.completionCentsPerMTok)
          : MAX_OUTPUT_TOKENS;
      if (remainingCents <= 0 || affordableOutputTokens < 1) {
        await block(
          `The prompt alone (~${promptTokens} tokens, ~${promptCostCents.toFixed(4)}¢) leaves no room for output within the ${task.budgetCents.toFixed(2)}¢ budget. Raise the budget and retry.`,
        );
        return;
      }
      if (affordableOutputTokens < maxOutputTokens) {
        maxOutputTokens = affordableOutputTokens;
        await addTaskLog(
          task.id,
          "info",
          `Output capped at ${maxOutputTokens} tokens to stay within the ${task.budgetCents.toFixed(2)}¢ budget.`,
        );
      }
    }

    const controller = new AbortController();
    inFlight.set(task.id, controller);
    const timeout = setTimeout(() => controller.abort("timeout"), CALL_TIMEOUT_MS);
    let result;
    try {
      result = await callProvider({
        provider,
        model: task.model ?? "",
        system,
        prompt: task.objective,
        maxOutputTokens,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      inFlight.delete(task.id);
    }

    const costCents = await computeUsageCostCents(
      provider,
      task.model,
      result.inputTokens,
      result.outputTokens,
    );
    const usage = {
      actualInputTokens: result.inputTokens,
      actualOutputTokens: result.outputTokens,
      actualCostCents: costCents,
    };
    const finished = await finishIfStillRunning(task.id, task.attempts, {
      ...usage,
      status: "completed",
      output: result.output,
    });
    if (finished) {
      await addTaskLog(
        task.id,
        "info",
        `Completed: ${result.inputTokens} in / ${result.outputTokens} out tokens${costCents != null ? `, ${costCents.toFixed(4)}¢` : ""}.`,
      );
      await db.insert(auditEventsTable).values({
        kind: "task.completed",
        summary: `${agent.name} completed a task.`,
      });
      // Retain the outcome as agent memory so future tasks can draw on it.
      try {
        const saved = await saveTaskOutcomeMemory({
          taskId: task.id,
          agentId: agent.id,
          objective: task.objective,
          output: result.output,
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
      await addTaskLog(
        task.id,
        "warn",
        "The provider call finished after the task was cancelled; usage was recorded and the result discarded.",
      );
    }
  } catch (error) {
    const callError =
      error instanceof ProviderCallError
        ? error
        : new ProviderCallError(
            "provider_error",
            error instanceof Error ? error.message : "Unexpected worker error",
          );

    if (callError.kind === "cancelled") {
      await addTaskLog(task.id, "warn", "Provider call aborted by cancellation.");
      return;
    }
    if (callError.retryable && task.attempts < MAX_ATTEMPTS) {
      const backoffMs = RATE_LIMIT_BACKOFF_MS * task.attempts;
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
        `${callError.message} Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${task.attempts} of ${MAX_ATTEMPTS}).`,
      );
      return;
    }
    const finished = await finishIfStillRunning(task.id, task.attempts, {
      status: "failed",
      errorKind: callError.kind,
      errorMessage: callError.message,
    });
    await addTaskLog(task.id, "error", `Failed (${callError.kind}): ${callError.message}`);
    if (finished) {
      await db.insert(auditEventsTable).values({
        kind: "task.failed",
        summary: `A task for ${agent.name} failed: ${callError.kind}.`,
      });
    }
  } finally {
    await settleAgentStatus(agent.id);
  }
}

/** Claim-and-run one task; returns whether anything was claimed. */
export async function workOnce(): Promise<boolean> {
  const claimed = await claimNextTask();
  if (!claimed) return false;
  await runTask(claimed);
  return true;
}

/**
 * Postgres advisory lock making the worker a cluster-wide singleton. Without
 * it, a rolling restart could requeue (and re-run) tasks that are still
 * executing on another instance, duplicating provider spend.
 */
const WORKER_LOCK_KEY = 0x484f4d41; // "HOMA"

let leaseClient: import("@workspace/db").PoolClient | null = null;
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

/** Start the polling worker loop. Idempotent. */
export function startWorker(intervalMs = POLL_INTERVAL_MS): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      // Only the lease holder recovers and claims; other instances keep
      // polling so one of them takes over if the holder dies.
      if (!(await ensureWorkerLease())) return;
      if (!leaseRecovered) {
        await recoverInterruptedTasks();
        leaseRecovered = true;
      }
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
