/**
 * Tasks parked because a connected app refused its credential.
 *
 * When an owner-approved action is refused before execution (revoked
 * GitHub token, unresolvable credential) the action row is preserved under
 * its single-retry fence, and the TASK is parked here: re-queued with a
 * generous notBefore instead of burning its remaining attempts against a
 * connection that only the owner (or a server-config fix) can repair.
 *
 * The park is not a dead wait: the moment the workspace's connection is
 * repaired — an OAuth reconnect or a GitHub App (re)bind — resume clears
 * the delay so the preserved action runs immediately, hands-free. If the
 * delay elapses with the connection still broken, the single retry spends
 * the action's fence and the task fails honestly.
 */

import {
  db,
  githubAccountsTable,
  githubInstallationsTable,
  tasksTable,
} from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
import { publish } from "../events";
import { logger } from "../lib/logger";

/** errorKind marking a task re-queued to wait out a connected-app refusal. */
export const APP_AUTH_PARK_ERROR_KIND = "app_auth";

/**
 * How long a parked task waits before its single automatic retry when the
 * connection is NOT repaired in the meantime. Long enough for a human to
 * notice and reconnect; a successful reconnect short-circuits it entirely.
 */
export const APP_AUTH_PARK_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * Did the workspace's GitHub connection change after the given moment? A
 * reconnect (OAuth) or an App (re)bind touches the row's updatedAt, so this
 * is the durable "the credential was repaired since the refusal" signal —
 * usable even when the repair raced ahead of the task-park write.
 */
async function githubConnectionRepairedSince(
  workspaceId: string,
  since: Date,
): Promise<boolean> {
  const [oauth] = await db
    .select({ id: githubAccountsTable.workspaceId })
    .from(githubAccountsTable)
    .where(
      and(
        eq(githubAccountsTable.workspaceId, workspaceId),
        gt(githubAccountsTable.updatedAt, since),
      ),
    )
    .limit(1);
  if (oauth) return true;
  const [installation] = await db
    .select({ id: githubInstallationsTable.workspaceId })
    .from(githubInstallationsTable)
    .where(
      and(
        eq(githubInstallationsTable.workspaceId, workspaceId),
        gt(githubInstallationsTable.updatedAt, since),
      ),
    )
    .limit(1);
  return Boolean(installation);
}

/**
 * Re-queue a running task to wait for its connected-app credential to be
 * repaired. Guarded on (id, running, attempts) so a lost lease or a
 * concurrent finalize wins — parking never overwrites a settled task.
 *
 * Race closure: a reconnect callback that lands BETWEEN the action being
 * preserved and this task-park would find nothing to resume (the task is
 * still "running" at that instant) — so after parking, the connection is
 * re-checked against `refusedAt` and a repair that already happened
 * releases the park immediately. Either ordering therefore resumes the
 * task right away; the 30-minute delay only holds while the connection is
 * genuinely still broken.
 */
export async function parkTaskForAppAuthRecovery(input: {
  taskId: string;
  attempts: number;
  workspaceId: string | null;
  message: string;
  /** When the credential refusal was observed (captured BEFORE executing). */
  refusedAt: Date;
}): Promise<boolean> {
  const [row] = await db
    .update(tasksTable)
    .set({
      status: "queued",
      notBefore: new Date(Date.now() + APP_AUTH_PARK_RETRY_DELAY_MS),
      errorKind: APP_AUTH_PARK_ERROR_KIND,
      errorMessage: input.message,
      // The task is no longer in any provider phase: it is waiting.
      providerPhase: "queued",
    })
    .where(
      and(
        eq(tasksTable.id, input.taskId),
        eq(tasksTable.status, "running"),
        eq(tasksTable.attempts, input.attempts),
      ),
    )
    .returning({ id: tasksTable.id });
  if (!row) return false;
  if (
    input.workspaceId &&
    (await githubConnectionRepairedSince(input.workspaceId, input.refusedAt))
  ) {
    await resumeTasksParkedForAppAuth(input.workspaceId);
  }
  publish(input.workspaceId, "tasks");
  return true;
}

/**
 * The workspace's connection was just repaired (OAuth reconnect or GitHub
 * App bind): release every task it parked for credential recovery so the
 * preserved approved actions run now instead of at the end of the delay.
 * Scoped strictly to the one workspace — a reconnect can never nudge a
 * foreign tenant's queue.
 */
export async function resumeTasksParkedForAppAuth(
  workspaceId: string,
): Promise<number> {
  const rows = await db
    .update(tasksTable)
    .set({ notBefore: new Date() })
    .where(
      and(
        eq(tasksTable.workspaceId, workspaceId),
        eq(tasksTable.status, "queued"),
        eq(tasksTable.errorKind, APP_AUTH_PARK_ERROR_KIND),
        gt(tasksTable.notBefore, new Date()),
      ),
    )
    .returning({ id: tasksTable.id });
  if (rows.length > 0) {
    logger.info(
      {
        component: "connected_apps",
        workspaceId,
        resumedTasks: rows.length,
      },
      "Resumed task(s) parked for connected-app credential recovery",
    );
    publish(workspaceId, "tasks");
  }
  return rows.length;
}
