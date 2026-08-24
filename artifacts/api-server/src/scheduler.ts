import {
  agentsTable,
  db,
  schedulesTable,
  systemStateTable,
  tasksTable,
  type ScheduleRecord,
} from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { dispatchTask } from "./dispatch";
import { publish } from "./events";
import { notifyScheduleIssue } from "./notifications";
import { computeNextRunAt } from "./recurrence";
import { logger } from "./lib/logger";
import {
  codexFeatureEnabled,
  codexHealthCheckMinutes,
} from "./codex/config";
import { codexRuntimeState } from "./codex/runtime";
import { addTaskLog } from "./worker";
import type { ProviderId } from "./providers";

/**
 * Durable schedule firing, in two phases so a crash can never silently
 * lose (or double-run) an occurrence:
 *
 * 1. CLAIM — under a row lock, stamp `claimedAt` on a due schedule. The
 *    due `nextRunAt` is left untouched, so if the process dies before the
 *    task exists the occurrence is still due after restart.
 * 2. FINALIZE — after dispatch, advance `nextRunAt` strictly past the
 *    claim time, record lastRunAt/lastTaskId, and clear the claim.
 *
 * A claim younger than CLAIM_TIMEOUT_MS is skipped (dispatch in flight).
 * An older claim is recovered by evidence: if a task row linked to the
 * schedule was created after the claim, the launch happened and we only
 * finalize; otherwise the claim is re-taken and dispatched again.
 *
 * Catch-up policy: a schedule missed during downtime fires once when the
 * worker returns; `computeNextRunAt` is strictly-after-now, never one task
 * per missed occurrence.
 */

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

function specOf(schedule: ScheduleRecord) {
  return {
    cadence: schedule.cadence as "once" | "daily" | "weekly" | "monthly",
    timezone: schedule.timezone,
    runAt: schedule.runAt,
    timeOfDay: schedule.timeOfDay,
    daysOfWeek: schedule.daysOfWeek,
    dayOfMonth: schedule.dayOfMonth,
  };
}

/**
 * Advance past the fired occurrence and clear the claim. Re-reads the row
 * under a lock so an owner edit made during the dispatch (new cadence,
 * new time, pause) wins: the next occurrence is computed from the row as
 * it is NOW, not from the snapshot taken at claim time.
 */
async function finalizeRun(
  scheduleId: string,
  firedAt: Date,
  lastTaskId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, scheduleId))
      .limit(1)
      .for("update");
    // Deleted mid-dispatch: the task (if any) survives; nothing to advance.
    if (!current) return;
    const nextRunAt = computeNextRunAt(specOf(current), firedAt);
    await tx
      .update(schedulesTable)
      .set({
        nextRunAt,
        lastRunAt: firedAt,
        ...(lastTaskId ? { lastTaskId } : {}),
        // A recurring schedule keeps its enabled flag (a pause during the
        // launch must survive); a finished `once` turns itself off.
        ...(nextRunAt === null ? { enabled: false } : {}),
        claimedAt: null,
      })
      .where(eq(schedulesTable.id, scheduleId));
  });
}

async function dispatchClaimed(claimed: ScheduleRecord, firedAt: Date): Promise<boolean> {
  try {
    const outcome = await dispatchTask({
      agentId: claimed.agentId,
      objective: claimed.objective,
      priority: claimed.priority,
      budgetCents: claimed.budgetCents,
      providerOverride: (claimed.providerOverride as ProviderId | null) ?? undefined,
      modelOverride: claimed.modelOverride ?? undefined,
      scheduleId: claimed.id,
    });
    if (outcome.status === 201) {
      await finalizeRun(claimed.id, firedAt, outcome.task.id);
      await addTaskLog(outcome.task.id, "info", `Launched by schedule "${claimed.name}".`);
      return true;
    }
    if (outcome.status === 409) {
      // The agent retired or was archived: the schedule can never fire
      // again, so turn it off and tell the owner instead of erroring on
      // every occurrence forever.
      await db
        .update(schedulesTable)
        .set({ enabled: false, claimedAt: null })
        .where(eq(schedulesTable.id, claimed.id));
      await notifyScheduleIssue(
        claimed.name,
        claimed.agentId,
        "Its agent is retired or archived, so the schedule was turned off.",
      );
      return false;
    }
    // 404/425: this occurrence is skipped explicitly; the schedule advances
    // so it fires again at the next occurrence rather than looping forever.
    await finalizeRun(claimed.id, firedAt, null);
    await notifyScheduleIssue(
      claimed.name,
      claimed.agentId,
      outcome.status === 404
        ? "Its agent no longer exists, so this occurrence was skipped."
        : "The agent's configuration was changing; this occurrence was skipped and the schedule will fire again next time.",
    );
    return false;
  } catch (error) {
    // Leave the claim in place: recovery will check whether the task row
    // exists and either finalize or refire — never both.
    logger.error({ error, scheduleId: claimed.id }, "Schedule dispatch failed");
    return false;
  }
}

export type RunDueSchedulesOptions = {
  /** Test-only scope: only consider these schedule ids. */
  scheduleIds?: string[];
  /**
   * Test-only escape hatch. In production the scheduler defers schedules
   * whose agent is paused (the occurrence stays due and catches up once on
   * resume); tests pause their agents so the live dev worker cannot touch
   * their rows, and opt back in here.
   */
  includePausedAgents?: boolean;
};

/**
 * Fire due schedules. Runs inside the worker tick, so only the singleton
 * lease holder executes it; the row-locked claim additionally makes even
 * concurrent calls safe.
 */
export async function runDueSchedules(
  now = new Date(),
  opts: RunDueSchedulesOptions = {},
): Promise<number> {
  // While the emergency stop is engaged, nothing fires. Due schedules keep
  // their past nextRunAt, so each catches up with a single run on resume.
  const [stop] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "emergency_stop"))
    .limit(1);
  if (stop?.value === "true") return 0;

  const staleClaimBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const dueConditions = [
    eq(schedulesTable.enabled, true),
    isNotNull(schedulesTable.nextRunAt),
    lte(schedulesTable.nextRunAt, now),
    // Skip fresh claims: their dispatch is (or was very recently) in
    // flight. Stale claims are picked up for recovery.
    or(
      sql`${schedulesTable.claimedAt} is null`,
      lte(schedulesTable.claimedAt, staleClaimBefore),
    ),
    // A paused agent means "hold my work": its schedules stay due but do
    // not fire; on resume, the next tick catches up with a single run.
    ...(opts.includePausedAgents
      ? []
      : [sql`${agentsTable.status} <> 'paused'`]),
    ...(opts.scheduleIds ? [inArray(schedulesTable.id, opts.scheduleIds)] : []),
  ];
  const due = await db
    .select({ id: schedulesTable.id })
    .from(schedulesTable)
    .innerJoin(agentsTable, eq(schedulesTable.agentId, agentsTable.id))
    .where(and(...dueConditions))
    .limit(20);

  let fired = 0;
  for (const { id } of due) {
    // Phase 1 — claim under a row lock, re-checking dueness inside the
    // transaction so a concurrent claim/edit cannot double-fire.
    const claim = await db.transaction(
      async (
        tx,
      ): Promise<
        | { kind: "dispatch"; schedule: ScheduleRecord }
        | { kind: "recovered"; schedule: ScheduleRecord; taskId: string; claimedAt: Date }
        | null
      > => {
        const [schedule] = await tx
          .select()
          .from(schedulesTable)
          .where(
            and(
              eq(schedulesTable.id, id),
              eq(schedulesTable.enabled, true),
              isNotNull(schedulesTable.nextRunAt),
              lte(schedulesTable.nextRunAt, now),
              or(
                sql`${schedulesTable.claimedAt} is null`,
                lte(schedulesTable.claimedAt, staleClaimBefore),
              ),
            ),
          )
          .limit(1)
          .for("update", { skipLocked: true });
        if (!schedule) return null;
        if (!opts.includePausedAgents) {
          // Re-check the pause inside the lock: an owner pausing the agent
          // between the due query and the claim must win.
          const [agent] = await tx
            .select({ status: agentsTable.status })
            .from(agentsTable)
            .where(eq(agentsTable.id, schedule.agentId))
            .limit(1);
          if (agent?.status === "paused") return null;
        }
        if (schedule.claimedAt) {
          // Stale claim: did the crashed run get its task out the door?
          const [evidence] = await tx
            .select({ id: tasksTable.id })
            .from(tasksTable)
            .where(
              and(
                eq(tasksTable.scheduleId, schedule.id),
                gte(tasksTable.createdAt, schedule.claimedAt),
              ),
            )
            .limit(1);
          if (evidence) {
            return {
              kind: "recovered",
              schedule,
              taskId: evidence.id,
              claimedAt: schedule.claimedAt,
            };
          }
        }
        await tx
          .update(schedulesTable)
          .set({ claimedAt: now })
          .where(eq(schedulesTable.id, schedule.id));
        return { kind: "dispatch", schedule };
      },
    );
    if (!claim) continue;

    if (claim.kind === "recovered") {
      // The task exists; the crash only lost the bookkeeping. Finish it.
      await finalizeRun(claim.schedule.id, claim.claimedAt, claim.taskId);
      continue;
    }
    // Phase 2 — dispatch outside the row lock (routing/estimation may hit
    // the network), then finalize.
    if (await dispatchClaimed(claim.schedule, now)) fired += 1;
  }
  if (fired > 0) publish("schedules");
  return fired;
}

/**
 * Low-frequency Codex credential health check.
 *
 * This runs from the worker tick (so only the singleton lease holder does
 * it) and only when Codex is switched on *and* backed by a persistent
 * private runtime — on ephemeral storage there is no credential worth
 * watching, and the noise would be constant. It is purely local: it reads
 * `auth.json`'s metadata, never contacts OpenAI, and so cannot spend any
 * of the owner's allowance.
 *
 * Its only job is to notice a session that has stopped refreshing before
 * a task does, and say so once per transition rather than every tick.
 */
let lastCodexHealthAt = 0;
let lastCodexHealthy: boolean | null = null;

/** Test hook: forget the throttle and the last reported state. */
export function resetCodexHealthCheck(): void {
  lastCodexHealthAt = 0;
  lastCodexHealthy = null;
}

export async function runCodexHealthCheck(now = Date.now()): Promise<boolean> {
  if (!codexFeatureEnabled()) return false;
  const intervalMs = codexHealthCheckMinutes() * 60_000;
  if (now - lastCodexHealthAt < intervalMs) return false;
  lastCodexHealthAt = now;

  const state = await codexRuntimeState();
  // Nobody has connected a ChatGPT session, so there is no credential whose
  // health could decay — reporting it as unhealthy would be noise, not news.
  if (!state.authPresent) return false;
  const healthy = state.ready;
  if (healthy === lastCodexHealthy) return true;
  lastCodexHealthy = healthy;
  if (healthy) {
    logger.info({ provider: "codex_chatgpt" }, "Codex credential is healthy");
  } else {
    // `detail` is already owner-facing and redacted at the source.
    logger.warn(
      { provider: "codex_chatgpt", detail: state.detail },
      "Codex credential needs attention",
    );
  }
  return true;
}
