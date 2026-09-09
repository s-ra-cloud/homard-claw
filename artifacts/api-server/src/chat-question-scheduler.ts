import {
  agentMessagesTable,
  agentsTable,
  chatQuestionSchedulesTable,
  db,
  workspaceSettingsTable,
  type ChatQuestionScheduleRecord,
} from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { publish } from "./events";
import { notifyScheduleIssue } from "./notifications";
import { computeNextRunAt } from "./recurrence";
import { logger } from "./lib/logger";
import { pushTelegramNotification } from "./telegram/service";

/**
 * Durable firing for chat-question schedules, mirroring the task scheduler's
 * claim/finalize discipline (see `.agents/memory/durable-scheduling.md`) as
 * a sibling table/module so task-schedule behavior is never touched:
 *
 * 1. CLAIM — under a row lock, stamp `claimedAt` on a due schedule. The due
 *    `nextRunAt` is left untouched, so a crash before the message exists
 *    leaves the occurrence still due after restart.
 * 2. FINALIZE — after the question is sent, advance `nextRunAt` strictly
 *    past the claim time, record lastRunAt/lastMessageId, and clear the
 *    claim.
 *
 * A claim younger than CLAIM_TIMEOUT_MS is skipped (send in flight). An
 * older claim is recovered by evidence: if a chat message linked to the
 * schedule was created after the claim, the send happened and we only
 * finalize; otherwise the claim is re-taken and sent again.
 *
 * Unlike a task schedule, firing never dispatches work — it only inserts
 * one agent-authored message into the Talk chat (and best-effort mirrors it
 * to Telegram if linked). The owner's next message in that same chat is
 * their answer; no separate "awaiting" bookkeeping is required.
 */

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

function specOf(schedule: ChatQuestionScheduleRecord) {
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
 * under a lock so an owner edit made during the send (new cadence, new
 * time, pause) wins: the next occurrence is computed from the row as it is
 * NOW, not from the snapshot taken at claim time.
 */
async function finalizeRun(
  scheduleId: string,
  firedAt: Date,
  lastMessageId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, scheduleId))
      .limit(1)
      .for("update");
    // Deleted mid-send: the message (if any) survives; nothing to advance.
    if (!current) return;
    const nextRunAt = computeNextRunAt(specOf(current), firedAt);
    await tx
      .update(chatQuestionSchedulesTable)
      .set({
        nextRunAt,
        lastRunAt: firedAt,
        ...(lastMessageId ? { lastMessageId } : {}),
        // A recurring schedule keeps its enabled flag (a pause during the
        // send must survive); a finished `once` turns itself off.
        ...(nextRunAt === null ? { enabled: false } : {}),
        claimedAt: null,
      })
      .where(eq(chatQuestionSchedulesTable.id, scheduleId));
  });
}

async function dispatchClaimed(
  claimed: ChatQuestionScheduleRecord,
  firedAt: Date,
): Promise<boolean> {
  const [agent] = await db
    .select({
      name: agentsTable.name,
      status: agentsTable.status,
      retired: agentsTable.retired,
      archived: agentsTable.archived,
    })
    .from(agentsTable)
    .where(eq(agentsTable.id, claimed.agentId))
    .limit(1);
  if (!agent) {
    // The agent no longer exists: skip this occurrence explicitly rather
    // than looping forever on a schedule that can never send again.
    await finalizeRun(claimed.id, firedAt, null);
    await notifyScheduleIssue(
      claimed.workspaceId,
      claimed.name,
      claimed.agentId,
      "Its Crustabot no longer exists, so this occurrence was skipped.",
    );
    return false;
  }
  if (agent.retired || agent.archived) {
    await db
      .update(chatQuestionSchedulesTable)
      .set({ enabled: false, claimedAt: null })
      .where(eq(chatQuestionSchedulesTable.id, claimed.id));
    await notifyScheduleIssue(
      claimed.workspaceId,
      claimed.name,
      claimed.agentId,
      "Its Crustabot is retired or archived, so the schedule was turned off.",
    );
    return false;
  }
  try {
    const [message] = await db
      .insert(agentMessagesTable)
      .values({
        fromAgentId: claimed.agentId,
        toAgentId: null,
        kind: "chat_question",
        body: claimed.question,
        chatQuestionScheduleId: claimed.id,
      })
      .returning({ id: agentMessagesTable.id });
    await finalizeRun(claimed.id, firedAt, message.id);
    if (claimed.workspaceId) {
      try {
        await pushTelegramNotification({
          workspaceId: claimed.workspaceId,
          kind: "chat_question",
          title: `${agent.name} has a question`,
          body: claimed.question,
        });
      } catch (error) {
        logger.warn(
          { error, scheduleId: claimed.id },
          "Could not push Telegram chat question",
        );
      }
    }
    return true;
  } catch (error) {
    // Leave the claim in place: recovery will check whether the message row
    // exists and either finalize or resend — never both.
    logger.error(
      { error, scheduleId: claimed.id },
      "Chat question send failed",
    );
    return false;
  }
}

export type RunDueChatQuestionSchedulesOptions = {
  /** Test-only scope: only consider these schedule ids. */
  scheduleIds?: string[];
  /**
   * Test-only escape hatch, mirroring the task scheduler's option: tests
   * pause their agents so the live dev worker cannot touch their rows, and
   * opt back in here.
   */
  includePausedAgents?: boolean;
};

/**
 * Send due chat-question schedules. Runs inside the worker tick, so only
 * the singleton lease holder executes it; the row-locked claim additionally
 * makes even concurrent calls safe.
 */
export async function runDueChatQuestionSchedules(
  now = new Date(),
  opts: RunDueChatQuestionSchedulesOptions = {},
): Promise<number> {
  const staleClaimBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const dueConditions = [
    eq(chatQuestionSchedulesTable.enabled, true),
    // While a workspace's emergency stop is engaged, none of ITS chat
    // question schedules fire either.
    sql`not exists (
      select 1 from ${workspaceSettingsTable}
      where ${workspaceSettingsTable.workspaceId} = ${chatQuestionSchedulesTable.workspaceId}
        and ${workspaceSettingsTable.key} = 'emergency_stop'
        and ${workspaceSettingsTable.value} = 'true'
    )`,
    isNotNull(chatQuestionSchedulesTable.nextRunAt),
    lte(chatQuestionSchedulesTable.nextRunAt, now),
    or(
      sql`${chatQuestionSchedulesTable.claimedAt} is null`,
      lte(chatQuestionSchedulesTable.claimedAt, staleClaimBefore),
    ),
    ...(opts.includePausedAgents
      ? []
      : [sql`${agentsTable.status} <> 'paused'`]),
    ...(opts.scheduleIds
      ? [inArray(chatQuestionSchedulesTable.id, opts.scheduleIds)]
      : []),
  ];
  const due = await db
    .select({ id: chatQuestionSchedulesTable.id })
    .from(chatQuestionSchedulesTable)
    .innerJoin(agentsTable, eq(chatQuestionSchedulesTable.agentId, agentsTable.id))
    .where(and(...dueConditions))
    .limit(20);

  let fired = 0;
  const firedWorkspaces = new Set<string>();
  for (const { id } of due) {
    const claim = await db.transaction(
      async (
        tx,
      ): Promise<
        | { kind: "dispatch"; schedule: ChatQuestionScheduleRecord }
        | {
            kind: "recovered";
            schedule: ChatQuestionScheduleRecord;
            messageId: string;
            claimedAt: Date;
          }
        | null
      > => {
        const [schedule] = await tx
          .select()
          .from(chatQuestionSchedulesTable)
          .where(
            and(
              eq(chatQuestionSchedulesTable.id, id),
              eq(chatQuestionSchedulesTable.enabled, true),
              isNotNull(chatQuestionSchedulesTable.nextRunAt),
              lte(chatQuestionSchedulesTable.nextRunAt, now),
              or(
                sql`${chatQuestionSchedulesTable.claimedAt} is null`,
                lte(chatQuestionSchedulesTable.claimedAt, staleClaimBefore),
              ),
            ),
          )
          .limit(1)
          .for("update", { skipLocked: true });
        if (!schedule) return null;
        if (!opts.includePausedAgents) {
          const [agent] = await tx
            .select({ status: agentsTable.status })
            .from(agentsTable)
            .where(eq(agentsTable.id, schedule.agentId))
            .limit(1);
          if (agent?.status === "paused") return null;
        }
        if (schedule.claimedAt) {
          const [evidence] = await tx
            .select({ id: agentMessagesTable.id })
            .from(agentMessagesTable)
            .where(
              and(
                eq(agentMessagesTable.chatQuestionScheduleId, schedule.id),
                gte(agentMessagesTable.createdAt, schedule.claimedAt),
              ),
            )
            .limit(1);
          if (evidence) {
            return {
              kind: "recovered",
              schedule,
              messageId: evidence.id,
              claimedAt: schedule.claimedAt,
            };
          }
        }
        await tx
          .update(chatQuestionSchedulesTable)
          .set({ claimedAt: now })
          .where(eq(chatQuestionSchedulesTable.id, schedule.id));
        return { kind: "dispatch", schedule };
      },
    );
    if (!claim) continue;

    if (claim.kind === "recovered") {
      await finalizeRun(claim.schedule.id, claim.claimedAt, claim.messageId);
      continue;
    }
    if (await dispatchClaimed(claim.schedule, now)) {
      fired += 1;
      if (claim.schedule.workspaceId)
        firedWorkspaces.add(claim.schedule.workspaceId);
    }
  }
  for (const workspaceId of firedWorkspaces)
    publish(workspaceId, "chat-question-schedules");
  return fired;
}
