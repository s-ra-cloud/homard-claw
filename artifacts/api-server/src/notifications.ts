import {
  agentsTable,
  db,
  notificationsTable,
  schedulesTable,
  tasksTable,
  type NotifyPrefs,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { publish } from "./events";
import { logger } from "./lib/logger";

/**
 * In-app notification emission for task lifecycle events.
 *
 * Worker transitions call `notifyTaskEvent`; schedule-launched tasks honor
 * their schedule's notify preferences, ad-hoc tasks always notify. Emission
 * is best-effort: a notification insert failing must never fail the task
 * transition that triggered it.
 */

export type TaskNotifyKind =
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "approval_needed";

const PREF_FOR_KIND: Record<TaskNotifyKind, keyof NotifyPrefs> = {
  task_completed: "onCompleted",
  task_failed: "onFailed",
  task_blocked: "onBlocked",
  approval_needed: "onApprovalNeeded",
};

const TITLE_FOR_KIND: Record<TaskNotifyKind, string> = {
  task_completed: "Task completed",
  task_failed: "Task failed",
  task_blocked: "Task blocked",
  approval_needed: "Approval needed",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Record an in-app notification for a task lifecycle event and announce it
 * on the live bus. Looks up the agent name and (when the task came from a
 * schedule) the schedule's notify preferences.
 */
export async function notifyTaskEvent(
  kind: TaskNotifyKind,
  task: Pick<
    typeof tasksTable.$inferSelect,
    "id" | "agentId" | "scheduleId" | "objective" | "workspaceId"
  >,
  detail?: string | null,
): Promise<void> {
  try {
    if (task.scheduleId) {
      const [schedule] = await db
        .select({ notify: schedulesTable.notify })
        .from(schedulesTable)
        .where(eq(schedulesTable.id, task.scheduleId))
        .limit(1);
      // A deleted schedule falls back to notifying; silence needs an opt-out.
      if (schedule && !schedule.notify[PREF_FOR_KIND[kind]]) return;
    }
    const [agent] = await db
      .select({ name: agentsTable.name })
      .from(agentsTable)
      .where(eq(agentsTable.id, task.agentId))
      .limit(1);
    const who = agent?.name ?? "An agent";
    const body = detail
      ? `${who} — "${clip(task.objective, 140)}": ${clip(detail, 300)}`
      : `${who} — "${clip(task.objective, 140)}"`;
    await db.insert(notificationsTable).values({
      workspaceId: task.workspaceId,
      kind,
      title: TITLE_FOR_KIND[kind],
      body,
      taskId: task.id,
      agentId: task.agentId,
    });
    if (task.workspaceId) publish(task.workspaceId, "notifications");
  } catch (error) {
    logger.warn({ error, taskId: task.id, kind }, "Could not record notification");
  }
}

/** A schedule-level problem the owner should know about (e.g. dispatch failed). */
export async function notifyScheduleIssue(
  workspaceId: string | null,
  scheduleName: string,
  agentId: string | null,
  detail: string,
): Promise<void> {
  try {
    await db.insert(notificationsTable).values({
      workspaceId,
      kind: "schedule_error",
      title: "Schedule needs attention",
      body: `"${clip(scheduleName, 80)}": ${clip(detail, 300)}`,
      agentId,
    });
    if (workspaceId) publish(workspaceId, "notifications");
  } catch (error) {
    logger.warn({ error, scheduleName }, "Could not record schedule notification");
  }
}
