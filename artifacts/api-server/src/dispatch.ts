import {
  agentsTable,
  db,
  taskLogsTable,
  tasksTable,
  workspaceSettingsTable,
} from "@workspace/db";
import type { TaskFile } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "./audit";
import { publish } from "./events";
import { notifyTaskEvent } from "./notifications";
import {
  RoutingError,
  estimateTask,
  isConfigured,
  providerLabel,
  resolveRouting,
  type ProviderId,
} from "./providers";
import { latestConversation } from "./provider-conversations";

/** Prompt-relevant agent configuration used for token estimation. */
export function agentPromptContext(agent: {
  mission: string;
  specialization: string | null;
  personality: string | null;
  goals: string | null;
  instructions: string | null;
}): string {
  return [
    agent.mission,
    agent.specialization,
    agent.personality,
    agent.goals,
    agent.instructions,
  ]
    .filter(Boolean)
    .join("\n");
}

export type DispatchInput = {
  agentId: string;
  /**
   * When set, the agent must belong to this workspace; a mismatched or
   * foreign agent id resolves to 404 so callers cannot dispatch across
   * tenant boundaries with a guessed id.
   */
  workspaceId?: string;
  objective: string;
  attachments?: TaskFile[];
  priority?: string;
  budgetCents?: number | null;
  providerOverride?: ProviderId;
  modelOverride?: string;
  /** Codex reasoning effort override; ignored by other providers. */
  reasoningOverride?: string;
  /** Continue the agent's existing provider thread instead of a new one. */
  continueConversation?: boolean;
  /** Set when a durable schedule launched this task. */
  scheduleId?: string | null;
};

export type DispatchOutcome =
  | { status: 404 }
  | { status: 409 }
  /** The requested provider/model/reasoning combination is not allowed. */
  | { status: 422; message: string }
  | { status: 425 } // routing went stale twice; caller should surface a retry
  | { status: 201; task: typeof tasksTable.$inferSelect; agentName: string };

/**
 * Create a task for an agent through the one canonical path: resolve
 * routing and pricing OUTSIDE the transaction (the model catalog may hit
 * the network and must not run under a row lock), then lock the agent row
 * so a concurrent retirement cannot slip between the check and the insert.
 * Used by both the dispatch route and the schedule runner so scheduled
 * tasks get identical policy, estimation, and blocking behavior.
 */
export async function dispatchTask(input: DispatchInput): Promise<DispatchOutcome> {
  let outcome: DispatchOutcome = { status: 425 };
  for (let attempt = 0; attempt < 2 && outcome.status === 425; attempt += 1) {
    const [preview] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, input.agentId))
      .limit(1);
    if (
      !preview ||
      (input.workspaceId !== undefined &&
        preview.workspaceId !== input.workspaceId)
    ) {
      outcome = { status: 404 };
      break;
    }
    if (preview.retired || preview.archived) {
      outcome = { status: 409 };
      break;
    }
    let routing;
    try {
      routing = await resolveRouting(
        preview.workspaceId ?? "",
        preview,
        input.providerOverride,
        input.modelOverride,
        input.reasoningOverride,
      );
    } catch (error) {
      if (error instanceof RoutingError) {
        outcome = { status: 422, message: error.message };
        break;
      }
      throw error;
    }
    const estimate = await estimateTask(
      agentPromptContext(preview),
      input.objective,
      routing,
    );
    // Thread continuity is opt-in. When asked for, the task is pinned to
    // the agent's most recent resumable conversation on this provider; the
    // worker creates a fresh one when this is null.
    const conversationId = input.continueConversation
      ? ((await latestConversation(preview.id, routing.provider))?.id ?? null)
      : null;
    outcome = await db.transaction(async (tx): Promise<DispatchOutcome> => {
      const [agent] = await tx
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, input.agentId))
        .limit(1)
        .for("update");
      if (!agent) return { status: 404 };
      if (agent.retired || agent.archived) return { status: 409 };
      if (
        agent.provider !== preview.provider ||
        agent.model !== preview.model
      ) {
        // Routing config changed between preview and lock; retry.
        return { status: 425 };
      }
      const [stop] = agent.workspaceId
        ? await tx
            .select()
            .from(workspaceSettingsTable)
            .where(
              and(
                eq(workspaceSettingsTable.workspaceId, agent.workspaceId),
                eq(workspaceSettingsTable.key, "emergency_stop"),
              ),
            )
            .limit(1)
        : [undefined];
      const configured = await isConfigured(
        agent.workspaceId ?? "",
        routing.provider,
      );
      // Unconfigured providers and the emergency stop block explicitly, with
      // a reason the owner can act on; a paused agent's tasks simply wait in
      // the queue until the agent resumes.
      const blockReason =
        stop?.value === "true"
          ? { errorKind: "emergency_stop", errorMessage: "The emergency stop is engaged." }
          : !configured
            ? {
                errorKind: "not_configured",
                errorMessage: `${providerLabel(routing.provider)} is not configured; add the credential and retry.`,
              }
            : null;
      const [task] = await tx
        .insert(tasksTable)
        .values({
          // The task's durable owner: always the agent's workspace, never
          // anything the client could supply.
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          objective: input.objective,
          files: input.attachments ?? [],
          priority: input.priority ?? "normal",
          budgetCents: input.budgetCents ?? null,
          provider: routing.provider,
          model: routing.model,
          reasoningEffort: routing.reasoningEffort,
          conversationId,
          estimatedTokens: estimate.estimatedTokens,
          estimatedCostCents: estimate.costKnown
            ? estimate.estimatedCostCents
            : null,
          scheduleId: input.scheduleId ?? null,
          status: blockReason ? "blocked" : "queued",
          ...(blockReason ?? {}),
        })
        .returning();
      await tx.insert(taskLogsTable).values({
        taskId: task.id,
        level: blockReason ? "warn" : "info",
        message: blockReason
          ? `Task created but blocked: ${blockReason.errorMessage}`
          : `Task created and queued for ${agent.name} (priority ${task.priority}).`,
      });
      if (agent.workspaceId) {
        await recordAudit(
          agent.workspaceId,
          "task.created",
          blockReason
            ? `A task for ${agent.name} was blocked: ${blockReason.errorMessage}`
            : `A task was queued for ${agent.name}.`,
          tx,
        );
      }
      return { status: 201, task, agentName: agent.name };
    });
  }
  if (outcome.status === 201) {
    if (outcome.task.workspaceId)
      publish(outcome.task.workspaceId, "tasks", "overview");
    // A task blocked at creation never reaches the worker's transition
    // hooks, so its notification must be emitted here.
    if (outcome.task.status === "blocked") {
      await notifyTaskEvent("task_blocked", outcome.task, outcome.task.errorMessage);
    }
  }
  return outcome;
}
