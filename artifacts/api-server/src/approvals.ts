import {
  agentsTable,
  approvalsTable,
  db,
  taskLogsTable,
  tasksTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { settleActionForApproval } from "./connected-apps/actions";
import { publish } from "./events";

export type ApprovalDecision = "approved" | "rejected";

export class ApprovalDecisionError extends Error {
  constructor(
    readonly kind: "not_pending",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

export function toApprovalJson(
  approval: typeof approvalsTable.$inferSelect,
  agentName: string,
  taskObjective: string | null,
  reviewerAgentName: string | null = null,
) {
  return {
    id: approval.id,
    agentName,
    taskId: approval.taskId,
    taskObjective,
    kind: approval.kind,
    action: approval.action,
    details: approval.details,
    status: approval.status,
    reviewerAgentId: approval.reviewerAgentId,
    reviewerAgentName,
    autoReviewStatus: approval.autoReviewStatus,
    autoReviewReason: approval.autoReviewReason,
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
  };
}

/**
 * Decide one pending approval inside its owning workspace. The approval,
 * task transition, linked connected-app action, and audit record commit in
 * one transaction; callers cannot supply or infer a different workspace.
 */
export async function decideApproval(input: {
  workspaceId: string;
  approvalId: string;
  decision: ApprovalDecision;
  /** Automatic reviewers may approve only; omission means the owner acted. */
  reviewer?: { agentId: string; name: string; reason: string };
}) {
  if (input.reviewer && input.decision !== "approved") {
    throw new Error("An automatic reviewer cannot reject an approval.");
  }
  const outcome = await db.transaction(async (tx) => {
    const [approval] = await tx
      .update(approvalsTable)
      .set({
        status: input.decision,
        decidedAt: new Date(),
        ...(input.reviewer
          ? {
              reviewerAgentId: input.reviewer.agentId,
              autoReviewStatus: "approved",
              autoReviewReason: input.reviewer.reason,
              autoReviewedAt: new Date(),
            }
          : {
              // A manual decision always wins a concurrent automatic review
              // and must not remain labelled as queued/reviewing afterward.
              autoReviewStatus: null,
              autoReviewStartedAt: null,
            }),
      })
      .where(
        and(
          eq(approvalsTable.id, input.approvalId),
          eq(approvalsTable.status, "pending"),
          ...(input.reviewer
            ? [
                eq(approvalsTable.reviewerAgentId, input.reviewer.agentId),
                eq(approvalsTable.autoReviewStatus, "reviewing"),
              ]
            : []),
          sql`${approvalsTable.expiresAt} > now()`,
          sql`exists (select 1 from ${agentsTable} where ${agentsTable.id} = ${approvalsTable.agentId} and ${agentsTable.workspaceId} = ${input.workspaceId})`,
        ),
      )
      .returning();
    if (!approval) return null;
    const [agent] = await tx
      .select({ name: agentsTable.name })
      .from(agentsTable)
      .where(eq(agentsTable.id, approval.agentId))
      .limit(1);
    let taskObjective: string | null = null;
    // A continuation approval gates one more bounded connected-app segment
    // of an already-running task, so its decisions read differently: the
    // requeue is a resume, and a rejection is a clean end with the work
    // completed so far — not a failure of the original request.
    const isContinuation = approval.kind === "task_continuation";
    if (approval.taskId) {
      if (input.decision === "approved") {
        const [task] = await tx
          .update(tasksTable)
          .set({ status: "queued", notBefore: null })
          .where(
            and(
              eq(tasksTable.id, approval.taskId),
              eq(tasksTable.status, "waiting_approval"),
            ),
          )
          .returning({ objective: tasksTable.objective });
        taskObjective = task?.objective ?? null;
        if (task) {
          await tx.insert(taskLogsTable).values({
            taskId: approval.taskId,
            level: "info",
            message: isContinuation
              ? input.reviewer
                ? `Continuation auto-approved by ${input.reviewer.name}; requeued for another bounded connected-app segment.`
                : "Continuation approved by the owner; requeued for another bounded connected-app segment."
              : input.reviewer
                ? `Auto-approved by ${input.reviewer.name}; requeued to run.`
                : "Approved by the owner; requeued to run.",
          });
        }
      } else {
        const [task] = await tx
          .update(tasksTable)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            errorKind: isContinuation
              ? "continuation_rejected"
              : "approval_rejected",
            errorMessage: isContinuation
              ? "The owner declined another connected-app segment; the task ended with the work completed so far."
              : "The owner rejected this task's approval request.",
          })
          .where(
            and(
              eq(tasksTable.id, approval.taskId),
              eq(tasksTable.status, "waiting_approval"),
            ),
          )
          .returning({ objective: tasksTable.objective });
        taskObjective = task?.objective ?? null;
        if (task) {
          await tx.insert(taskLogsTable).values({
            taskId: approval.taskId,
            level: "warn",
            message: isContinuation
              ? "Continuation rejected by the owner; the task ended with the work completed so far."
              : "Rejected by the owner; task cancelled.",
          });
        }
      }
    }
    const settledAction = await settleActionForApproval(
      tx,
      approval.id,
      input.decision === "approved" ? "approved" : "rejected",
    );
    await recordAudit(
      input.workspaceId,
      `approval.${input.decision}`,
      `${approval.action} was ${input.decision} by ${
        input.reviewer
          ? `automatic reviewer ${input.reviewer.name}. Reason: ${input.reviewer.reason}`
          : "the owner."
      }${
        settledAction
          ? ` Linked connected-app action (${settledAction.targetSummary}) is now ${settledAction.status}.`
          : ""
      }`,
      tx,
    );
    return toApprovalJson(
      approval,
      agent?.name ?? "Unknown agent",
      taskObjective,
      input.reviewer?.name ?? null,
    );
  });
  if (!outcome) {
    throw new ApprovalDecisionError(
      "not_pending",
      "Pending approval not found",
    );
  }
  publish(input.workspaceId, "approvals", "tasks", "overview");
  return outcome;
}
