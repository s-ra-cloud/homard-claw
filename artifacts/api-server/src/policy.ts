import {
  agentsTable,
  approvalsTable,
  db,
  tasksTable,
  type AgentPermissions,
} from "@workspace/db";
import { and, count, eq, gte, ne, sum } from "drizzle-orm";

/**
 * Server-side action policy. The worker evaluates every claimed task
 * against the agent's autonomy level and effective permissions BEFORE any
 * provider call, so no UI shortcut or crafted prompt can skip the checks.
 *
 * Autonomy levels:
 * - supervised:  every task waits for explicit owner approval.
 * - limited:     tasks run on their own unless the estimated cost crosses
 *                the approval threshold or the cost is unknown.
 * - autonomous:  tasks run without approval, still inside hard limits.
 *
 * Hard limits (per-task cap, daily budget, daily task count, provider
 * allow-list) always deny — approval cannot override them.
 */

export const AUTONOMY_LEVELS = ["supervised", "limited", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Baseline permissions per security preset; overrides refine them. */
export const PERMISSION_PROFILES: Record<string, AgentPermissions> = {
  observer: {
    maxTaskBudgetCents: 5,
    dailyBudgetCents: 25,
    maxTasksPerDay: 10,
    approvalThresholdCents: 0,
    allowedProviders: null,
  },
  assistant: {
    maxTaskBudgetCents: 50,
    dailyBudgetCents: 250,
    maxTasksPerDay: 50,
    approvalThresholdCents: 20,
    allowedProviders: null,
  },
  operator: {
    maxTaskBudgetCents: 250,
    dailyBudgetCents: 1000,
    maxTasksPerDay: 200,
    approvalThresholdCents: 100,
    allowedProviders: null,
  },
};

type AgentRow = typeof agentsTable.$inferSelect;
type TaskRow = typeof tasksTable.$inferSelect;

export function effectivePermissions(
  agent: Pick<AgentRow, "securityPreset" | "permissionOverrides">,
): AgentPermissions {
  const base =
    PERMISSION_PROFILES[agent.securityPreset] ?? PERMISSION_PROFILES.assistant!;
  const overrides = agent.permissionOverrides ?? {};
  return {
    maxTaskBudgetCents:
      overrides.maxTaskBudgetCents !== undefined
        ? overrides.maxTaskBudgetCents
        : base.maxTaskBudgetCents,
    dailyBudgetCents:
      overrides.dailyBudgetCents !== undefined
        ? overrides.dailyBudgetCents
        : base.dailyBudgetCents,
    maxTasksPerDay:
      overrides.maxTasksPerDay !== undefined
        ? overrides.maxTasksPerDay
        : base.maxTasksPerDay,
    approvalThresholdCents:
      overrides.approvalThresholdCents !== undefined
        ? overrides.approvalThresholdCents
        : base.approvalThresholdCents,
    allowedProviders:
      overrides.allowedProviders !== undefined
        ? overrides.allowedProviders
        : base.allowedProviders,
  };
}

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "needs_approval"; reason: string };

/** Metered spend recorded for the agent since the start of the UTC day. */
export async function meteredSpendTodayCents(agentId: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ spent: sum(tasksTable.actualCostCents) })
    .from(tasksTable)
    .where(
      and(eq(tasksTable.agentId, agentId), gte(tasksTable.finishedAt, dayStart)),
    );
  return Number(row?.spent ?? 0);
}

const centsLabel = (cents: number): string =>
  cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${cents.toFixed(2)}¢`;

/**
 * Decide whether a claimed task may run. Cost-based rules only apply to
 * metered providers; claude_max usage is covered by the subscription, so
 * only task-count limits, provider allow-lists, and supervised autonomy
 * gate it. A prior approved approval for this exact task satisfies the
 * approval requirement but never bypasses hard denials.
 *
 * Cost bound: the policy prices a task by its estimate when one exists,
 * falling back to its explicit budget (the worker hard-clamps actual
 * spend to the budget, so it is a real bound). A metered task with
 * NEITHER has no verifiable cost bound, so it always needs the owner's
 * sign-off — even for autonomous agents — because the hard caps below
 * cannot be checked against it.
 */
export async function evaluateTaskPolicy(
  agent: AgentRow,
  task: TaskRow,
): Promise<PolicyDecision> {
  const perms = effectivePermissions(agent);
  const provider = task.provider;
  const metered = provider !== "claude_max";
  const costBound = task.estimatedCostCents ?? task.budgetCents;

  if (
    perms.allowedProviders !== null &&
    !perms.allowedProviders.includes(provider)
  ) {
    return {
      kind: "deny",
      reason: `${agent.name} is not permitted to use the ${provider} provider.`,
    };
  }

  // Daily counters run on UTC days so they are stable across restarts.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  if (perms.maxTasksPerDay !== null) {
    const [row] = await db
      .select({ started: count() })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.agentId, agent.id),
          ne(tasksTable.id, task.id),
          gte(tasksTable.startedAt, dayStart),
        ),
      );
    if ((row?.started ?? 0) >= perms.maxTasksPerDay) {
      return {
        kind: "deny",
        reason: `${agent.name} reached the daily limit of ${perms.maxTasksPerDay} task run(s). The limit resets at midnight UTC.`,
      };
    }
  }
  if (metered && perms.dailyBudgetCents !== null) {
    const spent = await meteredSpendTodayCents(agent.id);
    if (spent >= perms.dailyBudgetCents) {
      return {
        kind: "deny",
        reason: `${agent.name} spent ${centsLabel(spent)} today, reaching the ${centsLabel(perms.dailyBudgetCents)} daily budget. The budget resets at midnight UTC.`,
      };
    }
    // The task's own cost must fit in the remaining headroom — otherwise
    // running it would take today's spend over the cap. The single worker
    // runs tasks serially, so spend-then-check cannot race with itself.
    if (costBound !== null && spent + costBound > perms.dailyBudgetCents) {
      return {
        kind: "deny",
        reason: `This task could cost ${centsLabel(costBound)}, but ${agent.name} has only ${centsLabel(perms.dailyBudgetCents - spent)} left of the ${centsLabel(perms.dailyBudgetCents)} daily budget.`,
      };
    }
  }
  if (
    metered &&
    perms.maxTaskBudgetCents !== null &&
    costBound !== null &&
    costBound > perms.maxTaskBudgetCents
  ) {
    return {
      kind: "deny",
      reason: `This task could cost ${centsLabel(costBound)}, exceeding ${agent.name}'s per-task cap of ${centsLabel(perms.maxTaskBudgetCents)}.`,
    };
  }

  // An explicit owner approval for this task satisfies any approval
  // requirement below (hard denials above were already re-checked).
  const [approved] = await db
    .select({ id: approvalsTable.id })
    .from(approvalsTable)
    .where(
      and(
        eq(approvalsTable.taskId, task.id),
        eq(approvalsTable.status, "approved"),
      ),
    )
    .limit(1);
  if (approved) return { kind: "allow" };

  if (agent.autonomy === "supervised") {
    return {
      kind: "needs_approval",
      reason: `${agent.name} is supervised: every task needs your sign-off before it runs.`,
    };
  }
  // No estimate and no budget on a metered provider: the hard caps above
  // could not be checked, so no autonomy level may run this unseen.
  if (metered && costBound === null) {
    return {
      kind: "needs_approval",
      reason:
        "This task has no cost estimate and no budget, so its spending cannot be bounded. It needs your sign-off before it runs.",
    };
  }
  if (
    agent.autonomy === "limited" &&
    metered &&
    perms.approvalThresholdCents !== null &&
    costBound !== null &&
    costBound > perms.approvalThresholdCents
  ) {
    return {
      kind: "needs_approval",
      reason: `This task could cost ${centsLabel(costBound)}, above the ${centsLabel(perms.approvalThresholdCents)} approval threshold.`,
    };
  }
  return { kind: "allow" };
}
