/**
 * Owner lifecycle events for custom APIs that must ripple into the durable
 * action pipeline. Kept separate from custom-apis.ts so the capability
 * loader (service.ts → custom-apis.ts) never transitively imports the
 * action module that imports it back.
 */

import {
  agentsTable,
  appActionsTable,
  approvalsTable,
  db,
  tasksTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { recordAudit } from "../audit";
import { settleActionForApproval } from "./actions";

/**
 * Expire every pending approval (and its linked action row) that targets
 * one custom API package in this workspace. Called whenever the owner
 * changes, disables, or deletes the definition: an approval granted
 * against the previous definition must never execute under the new one.
 */
export async function expirePendingCustomApiApprovals(
  workspaceId: string,
  packageId: string,
  reason: string,
): Promise<number> {
  const pending = await db
    .select({
      actionId: appActionsTable.id,
      approvalId: appActionsTable.approvalId,
      taskId: appActionsTable.taskId,
      targetSummary: appActionsTable.targetSummary,
    })
    .from(appActionsTable)
    .innerJoin(agentsTable, eq(appActionsTable.agentId, agentsTable.id))
    .where(
      and(
        eq(appActionsTable.app, packageId),
        eq(agentsTable.workspaceId, workspaceId),
        inArray(appActionsTable.status, ["waiting_approval", "approved"]),
      ),
    );
  if (pending.length === 0) return 0;
  let expired = 0;
  for (const row of pending) {
    await db.transaction(async (tx) => {
      let settledViaApproval = false;
      if (row.approvalId) {
        await tx
          .update(approvalsTable)
          .set({ status: "expired" })
          .where(
            and(
              eq(approvalsTable.id, row.approvalId),
              eq(approvalsTable.status, "pending"),
            ),
          );
        const settled = await settleActionForApproval(
          tx,
          row.approvalId,
          "expired",
        );
        settledViaApproval = settled !== null;
      }
      if (!settledViaApproval) {
        // Already approved (or no approval row): expire the action row
        // directly so a claim can never move it to executing under the
        // changed definition.
        await tx
          .update(appActionsTable)
          .set({
            status: "expired",
            errorMessage: reason,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(appActionsTable.id, row.actionId),
              inArray(appActionsTable.status, ["waiting_approval", "approved"]),
            ),
          );
      }
      // A task parked on this approval would otherwise wait forever.
      await tx
        .update(tasksTable)
        .set({
          status: "blocked",
          errorKind: "approval_expired",
          errorMessage: reason,
        })
        .where(
          and(
            eq(tasksTable.id, row.taskId),
            eq(tasksTable.status, "waiting_approval"),
          ),
        );
      await recordAudit(
        workspaceId,
        "app_action.expired",
        `A pending custom-API action (${row.targetSummary}) was invalidated: ${reason}`,
        tx,
      );
    });
    expired += 1;
  }
  return expired;
}
