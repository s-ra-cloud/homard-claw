import {
  agentsTable,
  approvalsTable,
  db,
  tasksTable,
  teamMembersTable,
  teamsTable,
  type AgentPermissions,
} from "@workspace/db";
import { and, count, eq, gte, ne, sum } from "drizzle-orm";
import {
  getProviderSettings,
  isMeteredProvider,
  providerLabel,
  type ProviderId,
} from "./providers";

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
    maxRunSeconds: 120,
    maxOutputTokens: 1024,
    maxAttempts: 2,
    // Observers report; they never hand work to anyone else.
    maxDelegationDepth: 0,
    maxSubtasksPerTask: 0,
  },
  assistant: {
    maxTaskBudgetCents: 50,
    dailyBudgetCents: 250,
    maxTasksPerDay: 50,
    approvalThresholdCents: 20,
    allowedProviders: null,
    maxRunSeconds: 180,
    maxOutputTokens: 4096,
    maxAttempts: 3,
    maxDelegationDepth: 1,
    maxSubtasksPerTask: 3,
  },
  operator: {
    maxTaskBudgetCents: 250,
    dailyBudgetCents: 1000,
    maxTasksPerDay: 200,
    approvalThresholdCents: 100,
    allowedProviders: null,
    maxRunSeconds: 300,
    maxOutputTokens: 4096,
    maxAttempts: 3,
    maxDelegationDepth: 2,
    maxSubtasksPerTask: 5,
  },
};

type AgentRow = typeof agentsTable.$inferSelect;
type TaskRow = typeof tasksTable.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    maxRunSeconds:
      overrides.maxRunSeconds !== undefined
        ? overrides.maxRunSeconds
        : base.maxRunSeconds,
    maxOutputTokens:
      overrides.maxOutputTokens !== undefined
        ? overrides.maxOutputTokens
        : base.maxOutputTokens,
    maxAttempts:
      overrides.maxAttempts !== undefined
        ? overrides.maxAttempts
        : base.maxAttempts,
    maxDelegationDepth:
      overrides.maxDelegationDepth !== undefined
        ? overrides.maxDelegationDepth
        : base.maxDelegationDepth,
    maxSubtasksPerTask:
      overrides.maxSubtasksPerTask !== undefined
        ? overrides.maxSubtasksPerTask
        : base.maxSubtasksPerTask,
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
  // Subscription providers (Claude Code, Codex via ChatGPT Plus) draw on a
  // plan allowance rather than billing per token, so the cost-based rules
  // below simply do not apply to them.
  const metered = isMeteredProvider(provider);
  const costBound = task.estimatedCostCents ?? task.budgetCents;

  if (
    perms.allowedProviders !== null &&
    !perms.allowedProviders.includes(provider)
  ) {
    return {
      kind: "deny",
      reason: `${agent.name} is not permitted to use the ${providerLabel(provider)} provider.`,
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

export type DelegationDecision =
  | { kind: "allow"; teamId: string; depth: number }
  | { kind: "deny"; reason: string };

/**
 * Decide whether one agent may hand work to another.
 *
 * Delegation is authorized by team structure, never by the request: the
 * delegating agent must lead a team, the target must be a member of that
 * same team, and the resulting chain must stay inside the lead's
 * delegation-depth and sub-task (iteration) limits. Everything here is
 * evaluated server-side, so a crafted API call cannot widen the circle.
 */
export async function evaluateDelegation({
  lead,
  targetAgentId,
  parentTask,
  tx,
}: {
  lead: AgentRow;
  targetAgentId: string;
  parentTask: TaskRow;
  /**
   * Transaction the caller has already locked the parent task in. Passing
   * it keeps authorization, the quota count, and the child insert in one
   * atomic step, so concurrent hand-offs cannot both see free capacity.
   */
  tx: Tx;
}): Promise<DelegationDecision> {
  const conn = tx;
  const perms = effectivePermissions(lead);
  const depth = parentTask.depth + 1;

  if (perms.maxDelegationDepth === null || perms.maxDelegationDepth < 1) {
    return {
      kind: "deny",
      reason: `${lead.name} is not allowed to delegate work.`,
    };
  }
  if (depth > perms.maxDelegationDepth) {
    return {
      kind: "deny",
      reason: `This would create a delegation chain ${depth} level(s) deep, beyond ${lead.name}'s limit of ${perms.maxDelegationDepth}.`,
    };
  }
  if (targetAgentId === lead.id) {
    return { kind: "deny", reason: `${lead.name} cannot delegate to itself.` };
  }
  // The sensitive-data sandbox severs delegation in both directions: a
  // sandboxed lead cannot push what it read outward through teammates, and
  // a sandboxed target cannot be steered by content another agent absorbed.
  if (lead.sensitiveDataSandbox) {
    return {
      kind: "deny",
      reason: `${lead.name} is in the sensitive data sandbox and cannot delegate work to other agents.`,
    };
  }

  // The lead must actually lead a team that contains the target.
  const [team] = await conn
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .innerJoin(teamMembersTable, eq(teamMembersTable.teamId, teamsTable.id))
    .where(
      and(
        eq(teamsTable.leadAgentId, lead.id),
        eq(teamMembersTable.agentId, targetAgentId),
        ...(parentTask.teamId ? [eq(teamsTable.id, parentTask.teamId)] : []),
      ),
    )
    .limit(1);
  if (!team) {
    return {
      kind: "deny",
      reason: `${lead.name} may only delegate to members of a team it leads.`,
    };
  }

  const [target] = await conn
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, targetAgentId))
    .limit(1);
  if (!target) return { kind: "deny", reason: "That teammate no longer exists." };
  if (target.retired || target.archived) {
    return {
      kind: "deny",
      reason: `${target.name} is no longer working in the office.`,
    };
  }
  if (target.sensitiveDataSandbox) {
    return {
      kind: "deny",
      reason: `${target.name} is in the sensitive data sandbox and cannot receive delegated work.`,
    };
  }

  if (perms.maxSubtasksPerTask !== null) {
    const [row] = await conn
      .select({ children: count() })
      .from(tasksTable)
      .where(eq(tasksTable.parentTaskId, parentTask.id));
    if ((row?.children ?? 0) >= perms.maxSubtasksPerTask) {
      return {
        kind: "deny",
        reason: `This task already delegated ${row?.children ?? 0} sub-task(s), reaching ${lead.name}'s limit of ${perms.maxSubtasksPerTask}.`,
      };
    }
  }

  return { kind: "allow", teamId: team.id, depth };
}

// ---------------------------------------------------------------------------
// Provider fallback
// ---------------------------------------------------------------------------

export type FallbackDecision =
  | { kind: "allow"; provider: ProviderId; reason: string }
  | { kind: "stop"; reason: string; candidates: ProviderId[] };

/**
 * Decide whether a stopped task may continue on a different provider.
 *
 * A fallback is never silent and never automatic-by-default:
 *
 * - Falling back onto another SUBSCRIPTION provider costs no money, but it
 *   still only happens when the owner put that provider in the configured
 *   fallback order.
 * - Falling back onto a METERED provider spends real money, so it requires
 *   either an explicit per-task approval the owner just gave, or a standing
 *   consent policy whose spend limit the task's own cost bound fits inside.
 *   The limit is re-checked here at fallback time, not only when the policy
 *   was saved.
 *
 * When nothing qualifies the task stops with the candidate list, so the
 * owner can wait, cancel, or authorize a paid run themselves.
 */
export async function evaluateFallback(input: {
  /** Workspace whose fallback policy applies (the task's durable owner). */
  workspaceId: string;
  fromProvider: ProviderId;
  /** Cents the fallback run could cost, when knowable. */
  costBoundCents: number | null;
  /** True when the owner explicitly approved a paid fallback for this task. */
  paidFallbackApproved: boolean;
  /** Providers currently able to accept the work. */
  healthyProviders: ProviderId[];
}): Promise<FallbackDecision> {
  const settings = await getProviderSettings(input.workspaceId);
  const candidates = settings.fallbackOrder.filter(
    (provider) =>
      provider !== input.fromProvider && input.healthyProviders.includes(provider),
  );
  if (candidates.length === 0) {
    return {
      kind: "stop",
      reason:
        "No fallback provider is configured and available, so the task is stopped instead of being rerouted.",
      candidates: [],
    };
  }

  for (const provider of candidates) {
    if (!isMeteredProvider(provider)) {
      return {
        kind: "allow",
        provider,
        reason: `Continuing on ${providerLabel(provider)}, the next configured fallback; it is subscription-backed, so no purchased usage is involved.`,
      };
    }
    if (input.paidFallbackApproved) {
      return {
        kind: "allow",
        provider,
        reason: `You approved a paid fallback for this task, so it continues on ${providerLabel(provider)}.`,
      };
    }
    if (!settings.paidFallbackConsent) continue;
    if (settings.paidFallbackLimitCents === null) continue;
    if (input.costBoundCents === null) continue;
    if (input.costBoundCents > settings.paidFallbackLimitCents) continue;
    return {
      kind: "allow",
      provider,
      reason: `Your standing paid-fallback policy allows up to ${centsLabel(settings.paidFallbackLimitCents)} per task, and this run is bounded at ${centsLabel(input.costBoundCents)}, so it continues on ${providerLabel(provider)}.`,
    };
  }

  return {
    kind: "stop",
    reason:
      "The only available fallbacks are paid providers, and no per-task approval or standing consent-and-limit policy covers this run. The task is stopped so you can wait, cancel, or authorize a paid run.",
    candidates,
  };
}
