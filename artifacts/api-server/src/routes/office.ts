import { getAuth } from "@clerk/express";
import {
  CancelTaskParams,
  CancelTaskResponse,
  CreateAgentBody,
  CreateAgentResponse,
  CreateTaskBody,
  CreateTaskResponse,
  BootstrapCodexResponse,
  ConnectCodexBody,
  ConnectCodexResponse,
  DisconnectCodexResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
  GetApprovalSettingsResponse,
  DecideTaskFallbackBody,
  DecideTaskFallbackParams,
  DecideTaskFallbackResponse,
  DeleteAgentParams,
  DuplicateAgentParams,
  DuplicateAgentResponse,
  EstimateTaskBody,
  EstimateTaskResponse,
  GetAgentParams,
  GetAgentResponse,
  GetOfficeOverviewResponse,
  GetProviderSettingsResponse,
  GetProvidersResponse,
  GetRuntimeHealthResponse,
  GetTaskParams,
  RecoverQueueResponse,
  GetTaskResponse,
  ListAgentsResponse,
  ListApprovalsResponse,
  ListProviderModelsParams,
  ListProviderModelsResponse,
  ListRetiredAgentsResponse,
  ListTasksResponse,
  PauseAgentBody,
  PauseAgentParams,
  PauseAgentResponse,
  RecordTaskUsageBody,
  RecordTaskUsageParams,
  RecordTaskUsageResponse,
  RetireAgentParams,
  RetireAgentResponse,
  RetryTaskParams,
  RetryTaskResponse,
  SearchAuditQueryParams,
  SearchAuditResponse,
  VerifyAuditResponse,
  DeleteProviderCredentialParams,
  DeleteProviderCredentialResponse,
  SetProviderCredentialBody,
  SetProviderCredentialParams,
  SetProviderCredentialResponse,
  SetAgentArchivedBody,
  SetAgentArchivedParams,
  SetAgentArchivedResponse,
  SetEmergencyStopBody,
  SetEmergencyStopResponse,
  TestCodexConnectionResponse,
  UpdateAgentBody,
  UpdateAgentParams,
  UpdateAgentResponse,
  UpdateApprovalSettingsBody,
  UpdateApprovalSettingsResponse,
  UpdateProviderSettingsBody,
  UpdateProviderSettingsResponse,
} from "@workspace/api-zod";
import {
  agentAppGrantsTable,
  agentsTable,
  appActionsTable,
  approvalsTable,
  auditEventsTable,
  db,
  taskLogsTable,
  tasksTable,
  teamsTable,
  type AppAccessLevel,
  type ConnectedAppId,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  getWorkspaceSetting,
  requireWorkspace,
  setWorkspaceSetting,
} from "../workspace";
import {
  PROVIDER_IDS,
  ProviderSettingsError,
  RoutingError,
  clearProviderCaches,
  computeUsageCostCents,
  estimateTask,
  getModelCatalog,
  getProviderHealth,
  getProviderSettings,
  isConfigured,
  providerLabel,
  resolveRouting,
  updateProviderSettings,
  type ProviderId,
} from "../providers";
import { testCodexConnection } from "../codex/execute";
import {
  deleteProviderCredential,
  ProviderCredentialError,
  saveProviderCredential,
} from "../provider-credentials";
import { claudeSetupTokenProblem } from "../claude-oauth";
import {
  bootstrapCodexHome,
  connectCodexCredential,
  disconnectCodexCredential,
} from "../codex/runtime";
import { CodexCredentialError } from "../codex/credential-store";
import { codexReasoningLevels } from "../codex/config";
import { listProviderLeases } from "../provider-leases";
import { recordAudit, verifyAuditChain } from "../audit";
import { agentPromptContext, dispatchTask } from "../dispatch";
import { publish } from "../events";
import { effectivePermissions } from "../policy";
import {
  DEFAULT_RUNTIME,
  isQueueProcessingStalled,
  listRuntimeHealth,
  queueHealth,
} from "../runtime";
import { abortRunningTask, getWorkerStatus, recoverQueueNow } from "../worker";
import {
  QUEUE_OWNERSHIP_KEY,
  getOwnershipSnapshot,
} from "../worker-ownership";
import {
  listRecentAgentActions,
  listTaskActions,
} from "../connected-apps/actions";
import { listCustomApiPackageIds } from "../connected-apps/custom-apis";
import {
  ApprovalDecisionError,
  decideApproval,
  toApprovalJson,
} from "../approvals";
import {
  ApprovalReviewerSettingsError,
  getApprovalReviewerSettings,
  updateApprovalReviewerSettings,
} from "../approval-reviewer";
import { findRegistryEntry } from "../capabilities/registry";
import connectedAppsRouter from "./connected-apps";
import capabilitiesRouter from "./capabilities";
import documentationRouter from "./documentation";
import eventsRouter from "./events";
import memoryRouter from "./memory";
import notificationsRouter from "./notifications";
import reportsRouter from "./reports";
import schedulesRouter from "./schedules";
import skillsRouter from "./skills";
import teamsRouter from "./teams";
import telegramRouter from "./telegram";
import voiceRouter from "./voice";

const router: IRouter = Router();

/**
 * Every signed-in user gets (or resumes) their own personal workspace; all
 * routes below are scoped to `req.workspaceId`. Legacy single-owner data is
 * adopted via OWNER_EMAIL inside requireWorkspace's workspace resolution.
 */
router.use(requireWorkspace);
// Memory, knowledge, and team routes share the workspace gate above.
router.use(memoryRouter);
router.use(documentationRouter);
router.use(skillsRouter);
router.use(teamsRouter);
router.use(telegramRouter);
router.use(voiceRouter);
router.use(schedulesRouter);
router.use(notificationsRouter);
router.use(reportsRouter);
router.use(eventsRouter);
router.use(connectedAppsRouter);
router.use(capabilitiesRouter);

router.get("/runtime/health", async (req: Request, res: Response) => {
  const [runtimes, queue, globalQueue, stop, owner] = await Promise.all([
    listRuntimeHealth(req.workspaceId!),
    queueHealth(req.workspaceId!),
    // Used only to avoid calling this worker stalled while it is executing
    // another workspace's task. Never expose these aggregate counts.
    queueHealth(),
    getWorkspaceSetting(req.workspaceId!, "emergency_stop"),
    getOwnershipSnapshot(QUEUE_OWNERSHIP_KEY),
  ]);
  const worker = getWorkerStatus();
  const processingStalled =
    !owner?.stale &&
    isQueueProcessingStalled(queue, globalQueue.running);
  res.json(
    GetRuntimeHealthResponse.parse({
      activeRuntime: DEFAULT_RUNTIME,
      runtimes,
      queue,
      worker: {
        // active: this instance drives the queue. standby: it polls and
        // takes over once the current owner's row goes stale.
        state: worker.state,
        leaseHeld: worker.leaseHeld,
        running: worker.running,
        inFlight: worker.inFlight,
        emergencyStop: stop === "true",
        lastTickAt: worker.lastTickAt ? worker.lastTickAt.toISOString() : null,
        instanceId: worker.instanceId,
        generation: worker.generation,
        lastRenewalAt: worker.lastRenewalAt
          ? worker.lastRenewalAt.toISOString()
          : null,
        renewalFailures: worker.renewalFailures,
        ownershipLosses: worker.ownershipLosses,
        takeovers: worker.takeovers,
         processingStalled,
        // The durable ownership row itself — whichever instance serves this
        // request. `stale: true` means heartbeats stopped (or no owner
        // exists) and the next healthy poller will take over.
        ownership: {
          holder: owner?.holder ?? null,
          generation: owner?.generation ?? null,
          heartbeatAt: owner ? owner.heartbeatAt.toISOString() : null,
          expiresAt: owner ? owner.expiresAt.toISOString() : null,
          heartbeatAgeSeconds: owner
            ? Math.max(
                0,
                Math.round((Date.now() - owner.heartbeatAt.getTime()) / 1000),
              )
            : null,
          stale: owner ? owner.stale : true,
        },
      },
    }),
  );
});

/**
 * Owner escape hatch for a queue that looks stuck. Safe by construction:
 * a fresh (healthy) worker elsewhere is reported, never displaced; only a
 * stale or missing ownership row is taken over, under a new generation
 * that fences the old holder, and only that takeover requeues orphaned
 * work. Repeating the click is a no-op once the queue is healthy again.
 */
router.post("/runtime/recover-queue", async (req, res): Promise<void> => {
  const result = await recoverQueueNow(req.workspaceId!);
  const message =
    result.outcome === "stalled_elsewhere"
      ? "The worker is still heartbeating but has stopped claiming runnable tasks. It was not forcibly replaced because that could duplicate in-flight external actions. Republish this app on Reserved VM to restart it safely."
      : result.outcome === "healthy_elsewhere"
      ? "The queue worker is healthy on another server instance; nothing was reset."
      : result.outcome === "already_active"
        ? "This server already runs the queue and its heartbeat is fresh; nothing was reset."
        : result.recoveredTasks > 0
          ? `Took over the stalled queue worker and requeued ${result.recoveredTasks} of your orphaned task${result.recoveredTasks === 1 ? "" : "s"}.`
          : "Took over the stalled queue worker; none of your tasks needed requeuing.";
  await recordAudit(
    req.workspaceId!,
    result.ownershipChanged ? "queue.recovered" : "queue.recovery_noop",
    `The owner pressed Recover queue. ${message}`,
  );
  if (result.ownershipChanged) {
    publish(req.workspaceId!, "tasks", "overview");
  }
  res.json(RecoverQueueResponse.parse({ ...result, message }));
});

type AppGrantJson = { app: string; accessLevel: AppAccessLevel };

/**
 * Last entry wins when a payload repeats an app; order is normalized.
 * Grants may target any vetted capability package (built-in app or
 * installed package) or one of THIS workspace's own custom APIs; anything
 * else is dropped — a grant to an unknown package could never authorize
 * anything anyway, and a grant to another workspace's custom API must
 * never be persisted.
 */
function dedupeGrants(
  grants: readonly AppGrantJson[],
  workspaceCustomApps: ReadonlySet<string>,
): AppGrantJson[] {
  const byApp = new Map<string, AppAccessLevel>();
  for (const grant of grants) {
    if (!findRegistryEntry(grant.app) && !workspaceCustomApps.has(grant.app)) {
      continue;
    }
    byApp.set(grant.app, grant.accessLevel);
  }
  return [...byApp.entries()]
    .map(([app, accessLevel]) => ({ app, accessLevel }))
    .sort((a, b) => a.app.localeCompare(b.app));
}

function grantAuditSuffix(grants: readonly AppGrantJson[]): string {
  if (grants.length === 0) return "";
  return ` Connected apps granted: ${grants.map((g) => `${g.app} (${g.accessLevel})`).join(", ")}.`;
}

/** Connected-app grants for a set of agents, grouped by agent id. */
async function grantsByAgent(
  agentIds: string[],
): Promise<Map<string, AppGrantJson[]>> {
  const map = new Map<string, AppGrantJson[]>();
  if (agentIds.length === 0) return map;
  const rows = await db
    .select()
    .from(agentAppGrantsTable)
    .where(inArray(agentAppGrantsTable.agentId, agentIds));
  for (const row of rows) {
    const list = map.get(row.agentId) ?? [];
    list.push({
      app: row.app,
      accessLevel: row.accessLevel as AppAccessLevel,
    });
    map.set(row.agentId, list);
  }
  return map;
}

function toAgent(
  agent: typeof agentsTable.$inferSelect,
  appGrants: AppGrantJson[] = [],
) {
  return {
    appGrants,
    id: agent.id,
    name: agent.name,
    title: agent.title,
    mission: agent.mission,
    specialization: agent.specialization,
    personality: agent.personality,
    goals: agent.goals,
    instructions: agent.instructions,
    provider: agent.provider,
    model: agent.model,
    codexModel: agent.codexModel,
    codexReasoning: agent.codexReasoning,
    voiceStyle: agent.voiceStyle,
    status: agent.status,
    securityPreset: agent.securityPreset,
    autonomy: agent.autonomy,
    permissions: effectivePermissions(agent),
    permissionOverrides: agent.permissionOverrides ?? null,
    sensitiveDataSandbox: agent.sensitiveDataSandbox,
    avatar: agent.avatar,
    archived: agent.archived,
    archivedAt: agent.archivedAt ? agent.archivedAt.toISOString() : null,
    createdAt: agent.createdAt.toISOString(),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toTaskJson(
  task: typeof tasksTable.$inferSelect,
  agentName: string,
  /** Delegation attribution, when the caller resolved the related names. */
  lineage?: { teamName?: string | null; delegatedByAgentName?: string | null },
) {
  // The handoff text may contain a delegator's private memories. Keep it
  // server-side; the owner can audit the non-secret source provenance.
  const { handoffContext: _handoffContext, ...publicTask } = task;
  return {
    ...publicTask,
    // Binary inputs stay server-side for the agent; never send multi-megabyte
    // base64 payloads back through every task-list refresh.
    files: task.files.map((file) => ({
      name: file.name,
      content:
        file.encoding === "base64"
          ? `[${file.mimeType ?? "binary file"} attachment]`
          : file.content,
    })),
    agentName,
    teamName: lineage?.teamName ?? null,
    delegatedByAgentName: lineage?.delegatedByAgentName ?? null,
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
    paidFallbackApprovedAt: task.paidFallbackApprovedAt
      ? task.paidFallbackApprovedAt.toISOString()
      : null,
    createdAt: task.createdAt.toISOString(),
  };
}

/** Serialize a durable app_actions row for the API contract. */
function toAppActionJson(
  action: typeof appActionsTable.$inferSelect & {
    taskObjective?: string | null;
  },
) {
  return {
    id: action.id,
    taskId: action.taskId,
    agentId: action.agentId,
    app: action.app,
    operation: action.operation,
    targetSummary: action.targetSummary,
    status: action.status,
    approvalId: action.approvalId,
    resultSummary: action.resultSummary,
    errorMessage: action.errorMessage,
    taskObjective: action.taskObjective ?? null,
    decidedAt: action.decidedAt ? action.decidedAt.toISOString() : null,
    executedAt: action.executedAt ? action.executedAt.toISOString() : null,
    createdAt: action.createdAt.toISOString(),
  };
}

/** Statuses the owner may cancel from; everything else is already final. */
const CANCELLABLE_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
];
/** Statuses eligible for a fresh retry attempt. */
const RETRYABLE_STATUSES = ["failed", "cancelled", "blocked"];

/** Case-insensitive name collision check across the workspace's agents, any lifecycle state. */
async function findNameConflict(
  tx: Tx | typeof db,
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, workspaceId),
        sql`lower(${agentsTable.name}) = lower(${name})`,
      ),
    )
    .limit(2);
  return rows.some((row) => row.id !== excludeId);
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError), so the Postgres error
  // code lives on the cause chain, not the thrown error itself.
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

router.get("/office/overview", async (req, res): Promise<void> => {
  const wsId = req.workspaceId!;
  const [[agentCount], [activeCount], [approvalCount], stop, events, [spend]] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.workspaceId, wsId),
            eq(agentsTable.retired, false),
            eq(agentsTable.archived, false),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasksTable)
        .where(
          and(
            eq(tasksTable.workspaceId, wsId),
            inArray(tasksTable.status, ["queued", "running"]),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalsTable)
        .innerJoin(agentsTable, eq(approvalsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.workspaceId, wsId),
            eq(approvalsTable.status, "pending"),
          ),
        ),
      getWorkspaceSetting(wsId, "emergency_stop"),
      db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.workspaceId, wsId))
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(8),
      db
        .select({
          cents: sql<number>`coalesce(sum(${tasksTable.actualCostCents}), 0)::float`,
        })
        .from(tasksTable)
        .where(
          and(
            eq(tasksTable.workspaceId, wsId),
            sql`${tasksTable.createdAt} >= date_trunc('month', now())`,
          ),
        ),
    ]);

  res.json(
    GetOfficeOverviewResponse.parse({
      agents: agentCount?.count ?? 0,
      activeTasks: activeCount?.count ?? 0,
      pendingApprovals: approvalCount?.count ?? 0,
      emergencyStop: stop === "true",
      monthlyCostCents: Math.round((spend?.cents ?? 0) * 100) / 100,
      recentEvents: events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    }),
  );
});

router.get("/agents", async (req, res): Promise<void> => {
  const agents = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, req.workspaceId!),
        eq(agentsTable.retired, false),
      ),
    )
    .orderBy(agentsTable.name);
  const grants = await grantsByAgent(agents.map((agent) => agent.id));
  res.json(
    ListAgentsResponse.parse(
      agents.map((agent) => toAgent(agent, grants.get(agent.id) ?? [])),
    ),
  );
});

router.post("/agents", async (req, res): Promise<void> => {
  const parsed = CreateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Defaults to the house "Marlow" shell used by the office art direction.
  const avatar = parsed.data.avatar ?? {
    shellColor: "#d8452f",
    deskStyle: "oak",
    accessory: "glasses",
    expression: "focused",
  };
  if (await findNameConflict(db, req.workspaceId!, parsed.data.name)) {
    res
      .status(409)
      .json({ error: `An agent named "${parsed.data.name}" already exists` });
    return;
  }
  // Grants ride along on the create payload but live in their own table;
  // they must never be spread into the agents insert.
  const { appGrants, ...agentFields } = parsed.data;
  const customApps = await listCustomApiPackageIds(req.workspaceId!);
  try {
    const outcome = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agentsTable)
        .values({
          ...agentFields,
          workspaceId: req.workspaceId!,
          avatar,
          status: "idle",
        })
        .returning();
      const grants = dedupeGrants(appGrants ?? [], customApps);
      if (grants.length > 0) {
        await tx.insert(agentAppGrantsTable).values(
          grants.map((grant) => ({
            agentId: agent.id,
            app: grant.app,
            accessLevel: grant.accessLevel,
          })),
        );
      }
      await recordAudit(
        req.workspaceId!,
        "agent.created",
        `${agent.name} joined the office as ${agent.title}.${grantAuditSuffix(grants)}`,
        tx,
      );
      return { agent, grants };
    });
    res
      .status(201)
      .json(CreateAgentResponse.parse(toAgent(outcome.agent, outcome.grants)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res
        .status(409)
        .json({ error: `An agent named "${parsed.data.name}" already exists` });
      return;
    }
    throw error;
  }
});

router.get("/agents/:agentId", async (req, res): Promise<void> => {
  const params = GetAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent id" });
    return;
  }
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.id, params.data.agentId),
        eq(agentsTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const [tasks, agentGrants, recentActions] = await Promise.all([
    db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.agentId, agent.id))
      .orderBy(desc(tasksTable.createdAt))
      .limit(50),
    grantsByAgent([agent.id]),
    listRecentAgentActions(agent.id, 20),
  ]);
  res.json(
    GetAgentResponse.parse({
      agent: toAgent(agent, agentGrants.get(agent.id) ?? []),
      tasks: tasks.map((task) => ({
        ...task,
        agentName: agent.name,
        createdAt: task.createdAt.toISOString(),
      })),
      recentActions: recentActions.map((action) => toAppActionJson(action)),
    }),
  );
});

router.patch("/agents/:agentId", async (req, res): Promise<void> => {
  const params = UpdateAgentParams.safeParse(req.params);
  const body = UpdateAgentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid update request" });
    return;
  }
  const { appGrants, ...fieldUpdates } = body.data;
  const updates = Object.fromEntries(
    Object.entries(fieldUpdates).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(updates).length === 0 && appGrants === undefined) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const customApps = await listCustomApiPackageIds(req.workspaceId!);
  try {
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.id, params.data.agentId),
            eq(agentsTable.workspaceId, req.workspaceId!),
          ),
        )
        .limit(1)
        .for("update");
      if (!existing) return { status: 404 as const };
      if (existing.retired) return { status: 409 as const, retired: true };
      if (
        typeof updates.name === "string" &&
        (await findNameConflict(
          tx,
          req.workspaceId!,
          updates.name,
          existing.id,
        ))
      ) {
        return { status: 409 as const, retired: false, name: updates.name };
      }
      let agent = existing;
      if (Object.keys(updates).length > 0) {
        [agent] = await tx
          .update(agentsTable)
          .set(updates)
          .where(eq(agentsTable.id, existing.id))
          .returning();
      }
      // Grants are replaced wholesale when supplied: the payload is the
      // complete, owner-approved set, so anything absent is a revocation
      // that takes effect on the agent's very next action.
      let grants: AppGrantJson[];
      if (appGrants !== undefined) {
        grants = dedupeGrants(appGrants, customApps);
        await tx
          .delete(agentAppGrantsTable)
          .where(eq(agentAppGrantsTable.agentId, existing.id));
        if (grants.length > 0) {
          await tx.insert(agentAppGrantsTable).values(
            grants.map((grant) => ({
              agentId: existing.id,
              app: grant.app,
              accessLevel: grant.accessLevel,
            })),
          );
        }
      } else {
        grants = (
          await tx
            .select()
            .from(agentAppGrantsTable)
            .where(eq(agentAppGrantsTable.agentId, existing.id))
        ).map((row) => ({
          app: row.app,
          accessLevel: row.accessLevel as AppAccessLevel,
        }));
      }
      await recordAudit(
        req.workspaceId!,
        "agent.updated",
        `${agent.name}'s profile was updated.${
          appGrants !== undefined
            ? ` Connected apps set to: ${grants.length > 0 ? grants.map((g) => `${g.app} (${g.accessLevel})`).join(", ") : "none"}.`
            : ""
        }`,
        tx,
      );
      return { status: 200 as const, agent, grants };
    });
    if (outcome.status === 404) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (outcome.status === 409) {
      res.status(409).json({
        error: outcome.retired
          ? "Retired agents cannot be edited"
          : `An agent named "${outcome.name}" already exists`,
      });
      return;
    }
    res.json(UpdateAgentResponse.parse(toAgent(outcome.agent, outcome.grants)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That agent name is already in use" });
      return;
    }
    throw error;
  }
});

async function duplicateAgentOnce(workspaceId: string, agentId: string) {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!source) return { status: 404 as const };
    if (source.retired) return { status: 409 as const };
    // "Name Copy", then "Name Copy 2", "Name Copy 3", ... within the 60-char
    // name budget enforced by the API contract.
    const base = `${source.name.slice(0, 48).trimEnd()} Copy`;
    let candidate = base;
    for (
      let n = 2;
      await findNameConflict(tx, workspaceId, candidate);
      n += 1
    ) {
      if (n > 50) return { status: 409 as const };
      candidate = `${base} ${n}`;
    }
    const [agent] = await tx
      .insert(agentsTable)
      .values({
        workspaceId,
        name: candidate,
        title: source.title,
        mission: source.mission,
        specialization: source.specialization,
        personality: source.personality,
        goals: source.goals,
        instructions: source.instructions,
        provider: source.provider,
        model: source.model,
        voiceStyle: source.voiceStyle,
        securityPreset: source.securityPreset,
        autonomy: source.autonomy,
        permissionOverrides: source.permissionOverrides,
        avatar: source.avatar,
        status: "idle",
      })
      .returning();
    // Deliberately NOT copied: connected-app grants and the sensitive-data
    // sandbox flag (the insert above omits sensitiveDataSandbox, so the copy
    // defaults to false). External account access is granted per agent by
    // the owner, never inherited through duplication — and a copy without
    // grants has nothing sensitive to sandbox until the owner sets it up.
    await recordAudit(
      workspaceId,
      "agent.duplicated",
      `${agent.name} was recruited as a copy of ${source.name}. Connected-app access was not copied.`,
      tx,
    );
    return { status: 201 as const, agent };
  });
}

router.post("/agents/:agentId/duplicate", async (req, res): Promise<void> => {
  const params = DuplicateAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent id" });
    return;
  }
  // Concurrent duplicates can race on the same "Copy N" name; the unique
  // index rejects the loser, so retry with a freshly computed candidate.
  let outcome: Awaited<ReturnType<typeof duplicateAgentOnce>> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      outcome = await duplicateAgentOnce(req.workspaceId!, params.data.agentId);
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error;
    }
  }
  if (!outcome) {
    res.status(409).json({ error: "Could not find a free name for the copy" });
    return;
  }
  if (outcome.status === 404) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({ error: "Retired agents cannot be duplicated" });
    return;
  }
  res.status(201).json(DuplicateAgentResponse.parse(toAgent(outcome.agent)));
});

router.post("/agents/:agentId/archive", async (req, res): Promise<void> => {
  const params = SetAgentArchivedParams.safeParse(req.params);
  const body = SetAgentArchivedBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid archive request" });
    return;
  }
  const archived = body.data.archived;
  const outcome = await db.transaction(async (tx) => {
    const [agent] = await tx
      .update(agentsTable)
      .set(
        archived
          ? {
              archived: true,
              archivedAt: new Date(),
              paused: true,
              status: "paused",
            }
          : {
              archived: false,
              archivedAt: null,
              paused: false,
              status: "idle",
            },
      )
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, !archived),
        ),
      )
      .returning();
    if (!agent) {
      const [existing] = await tx
        .select({ id: agentsTable.id, retired: agentsTable.retired })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.id, params.data.agentId),
            eq(agentsTable.workspaceId, req.workspaceId!),
          ),
        )
        .limit(1);
      if (!existing) return { status: 404 as const };
      if (existing.retired) return { status: 409 as const };
      // Already in the requested state; return it unchanged.
      const [current] = await tx
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, params.data.agentId))
        .limit(1);
      return { status: 200 as const, agent: current! };
    }
    let interrupted: { id: string }[] = [];
    if (archived) {
      interrupted = await tx
        .update(tasksTable)
        .set({
          status: "blocked",
          errorKind: "agent_archived",
          errorMessage: `${agent.name} was archived; restore the agent and retry.`,
        })
        .where(
          and(
            eq(tasksTable.agentId, agent.id),
            inArray(tasksTable.status, [
              "queued",
              "running",
              "waiting_approval",
            ]),
          ),
        )
        .returning({ id: tasksTable.id });
    }
    await recordAudit(
      req.workspaceId!,
      archived ? "agent.archived" : "agent.restored",
      archived
        ? `${agent.name} was archived and stepped away from the office.`
        : `${agent.name} was restored to the active roster.`,
      tx,
    );
    return { status: 200 as const, agent, interrupted };
  });
  if (outcome.status === 200 && "interrupted" in outcome) {
    for (const task of outcome.interrupted ?? []) abortRunningTask(task.id);
  }
  if (outcome.status === 404) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({ error: "Retired agents cannot be archived" });
    return;
  }
  const archivedGrants = await grantsByAgent([outcome.agent.id]);
  res.json(
    SetAgentArchivedResponse.parse(
      toAgent(outcome.agent, archivedGrants.get(outcome.agent.id) ?? []),
    ),
  );
});

router.delete("/agents/:agentId", async (req, res): Promise<void> => {
  const params = DeleteAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent id" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1)
      .for("update");
    if (!agent) return { status: 404 as const };
    // Retirement to the Island is permanent by design; retired agents are
    // never erased.
    if (agent.retired) return { status: 409 as const };
    await tx.delete(approvalsTable).where(eq(approvalsTable.agentId, agent.id));
    // Collect active tasks first so any in-flight provider calls can be
    // aborted after the delete commits; otherwise the worker would keep
    // spending against rows that no longer exist.
    const active = await tx
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(eq(tasksTable.agentId, agent.id), eq(tasksTable.status, "running")),
      );
    await tx.delete(tasksTable).where(eq(tasksTable.agentId, agent.id));
    await tx.delete(agentsTable).where(eq(agentsTable.id, agent.id));
    await recordAudit(
      req.workspaceId!,
      "agent.deleted",
      `${agent.name} and their task history were permanently deleted.`,
      tx,
    );
    return { status: 204 as const, active };
  });
  if (outcome.status === 204 && "active" in outcome) {
    for (const task of outcome.active ?? []) abortRunningTask(task.id);
  }
  if (outcome.status === 404) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({
      error:
        "Retired agents rest on the Island permanently and cannot be deleted",
    });
    return;
  }
  res.status(204).end();
});

router.post("/agents/:agentId/pause", async (req, res): Promise<void> => {
  const params = PauseAgentParams.safeParse(req.params);
  const body = PauseAgentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid pause request" });
    return;
  }
  const [agent] = await db
    .update(agentsTable)
    .set({
      paused: body.data.paused,
      status: body.data.paused ? "paused" : "idle",
    })
    .where(
      and(
        eq(agentsTable.id, params.data.agentId),
        eq(agentsTable.workspaceId, req.workspaceId!),
        eq(agentsTable.retired, false),
        eq(agentsTable.archived, false),
      ),
    )
    .returning();
  if (!agent) {
    const [existing] = await db
      .select({ archived: agentsTable.archived, retired: agentsTable.retired })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (existing && (existing.archived || existing.retired)) {
      res.status(409).json({
        error: existing.retired
          ? "Retired agents cannot be paused or resumed"
          : "Archived agents cannot be paused or resumed. Restore them first.",
      });
      return;
    }
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  await recordAudit(
    req.workspaceId!,
    body.data.paused ? "agent.paused" : "agent.resumed",
    `${agent.name} was ${body.data.paused ? "paused" : "resumed"}.`,
  );
  const pausedGrants = await grantsByAgent([agent.id]);
  res.json(
    PauseAgentResponse.parse(toAgent(agent, pausedGrants.get(agent.id) ?? [])),
  );
});

function toRetiredAgent(agent: typeof agentsTable.$inferSelect) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    mission: agent.mission,
    provider: agent.provider,
    model: agent.model,
    securityPreset: agent.securityPreset,
    avatar: agent.avatar,
    createdAt: agent.createdAt.toISOString(),
    retiredAt: (agent.retiredAt ?? agent.createdAt).toISOString(),
  };
}

router.post("/agents/:agentId/retire", async (req, res): Promise<void> => {
  const params = RetireAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid retire request" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    // Conditional update makes the transition atomic: only one concurrent
    // request can flip retired from false to true.
    const [agent] = await tx
      .update(agentsTable)
      .set({
        retired: true,
        retiredAt: new Date(),
        paused: true,
        status: "paused",
      })
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
          eq(agentsTable.retired, false),
        ),
      )
      .returning();
    if (!agent) {
      const [existing] = await tx
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.id, params.data.agentId),
            eq(agentsTable.workspaceId, req.workspaceId!),
          ),
        )
        .limit(1);
      if (existing) return { status: 409 as const };
      return { status: 404 as const };
    }
    const interrupted = await tx
      .update(tasksTable)
      .set({
        status: "blocked",
        errorKind: "agent_retired",
        errorMessage: `${agent.name} retired; reassign this work to an active agent.`,
      })
      .where(
        and(
          eq(tasksTable.agentId, agent.id),
          inArray(tasksTable.status, ["queued", "running", "waiting_approval"]),
        ),
      )
      .returning({ id: tasksTable.id });
    await recordAudit(
      req.workspaceId!,
      "agent.retired",
      `${agent.name} retired to the island after honorable service.`,
      tx,
    );
    return { status: 200 as const, agent, interrupted };
  });
  if (outcome.status === 200 && "interrupted" in outcome) {
    for (const task of outcome.interrupted) abortRunningTask(task.id);
  }
  if (outcome.status === 404) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({ error: "Agent is already retired" });
    return;
  }
  res.json(RetireAgentResponse.parse(toRetiredAgent(outcome.agent)));
});

router.get("/island/agents", async (req, res): Promise<void> => {
  const agents = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, req.workspaceId!),
        eq(agentsTable.retired, true),
      ),
    )
    .orderBy(desc(agentsTable.retiredAt));
  res.json(ListRetiredAgentsResponse.parse(agents.map(toRetiredAgent)));
});

router.get("/tasks", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      task: tasksTable,
      agentName: agentsTable.name,
    })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
    .where(eq(tasksTable.workspaceId, req.workspaceId!))
    .orderBy(desc(tasksTable.createdAt));
  res.json(
    ListTasksResponse.parse(
      rows.map((row) => toTaskJson(row.task, row.agentName)),
    ),
  );
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const outcome = await dispatchTask({
    agentId: parsed.data.agentId,
    workspaceId: req.workspaceId!,
    objective: parsed.data.objective,
    attachments: parsed.data.attachments,
    priority: parsed.data.priority,
    budgetCents: parsed.data.budgetCents ?? null,
    providerOverride: parsed.data.providerOverride as ProviderId | undefined,
    modelOverride: parsed.data.modelOverride,
    reasoningOverride: parsed.data.reasoningOverride,
    continueConversation: parsed.data.continueConversation,
    talkMode: parsed.data.talkMode,
  });
  if (outcome.status === 404) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({
      error: "This agent is retired or archived and cannot take new work",
    });
    return;
  }
  if (outcome.status === 422) {
    res.status(422).json({ error: outcome.message });
    return;
  }
  if (outcome.status === 425) {
    res.status(503).json({
      error: "Agent configuration is changing; please retry the dispatch",
    });
    return;
  }
  res
    .status(201)
    .json(
      CreateTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)),
    );
});

router.get("/tasks/:taskId", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }
  const delegator = sql`delegator`;
  const [row] = await db
    .select({
      task: tasksTable,
      agentName: agentsTable.name,
      teamName: teamsTable.name,
      delegatedByAgentName: sql<string | null>`${delegator}.name`,
    })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
    .leftJoin(teamsTable, eq(tasksTable.teamId, teamsTable.id))
    .leftJoin(
      sql`${agentsTable} as delegator`,
      sql`${tasksTable.delegatedByAgentId} = ${delegator}.id`,
    )
    .where(
      and(
        eq(tasksTable.id, params.data.taskId),
        eq(tasksTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const [logs, actions, pendingApprovals] = await Promise.all([
    db
      .select()
      .from(taskLogsTable)
      .where(eq(taskLogsTable.taskId, row.task.id))
      .orderBy(taskLogsTable.createdAt),
    listTaskActions(row.task.id),
    // The undecided approval this task is waiting on, if any. Its `kind`
    // lets clients tell a round-limit continuation pause apart from an
    // action-level or policy-gate approval.
    db
      .select()
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.taskId, row.task.id),
          eq(approvalsTable.status, "pending"),
        ),
      )
      .orderBy(desc(approvalsTable.createdAt))
      .limit(1),
  ]);
  const pendingApproval = pendingApprovals[0] ?? null;
  res.json(
    GetTaskResponse.parse({
      task: toTaskJson(row.task, row.agentName, {
        teamName: row.teamName,
        delegatedByAgentName: row.delegatedByAgentName,
      }),
      logs: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
      })),
      actions: actions.map((action) => toAppActionJson(action)),
      pendingApproval: pendingApproval
        ? toApprovalJson(pendingApproval, row.agentName, row.task.objective)
        : null,
    }),
  );
});

router.post("/tasks/:taskId/cancel", async (req, res): Promise<void> => {
  const params = CancelTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ task: tasksTable, agentName: agentsTable.name })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.id, params.data.taskId),
          eq(tasksTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1)
      .for("update", { of: tasksTable });
    if (!row) return { status: 404 as const };
    if (!CANCELLABLE_STATUSES.includes(row.task.status)) {
      return { status: 409 as const, current: row.task.status };
    }
    const [task] = await tx
      .update(tasksTable)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(tasksTable.id, row.task.id))
      .returning();
    // A cancelled task's approval request must die with it, or it could be
    // approved later and resurrect work the owner explicitly stopped.
    await tx
      .update(approvalsTable)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(
        and(
          eq(approvalsTable.taskId, task.id),
          eq(approvalsTable.status, "pending"),
        ),
      );
    await tx.insert(taskLogsTable).values({
      taskId: task.id,
      level: "warn",
      message: "Cancelled by the owner.",
    });
    await recordAudit(
      req.workspaceId!,
      "task.cancelled",
      `A task for ${row.agentName} was cancelled.`,
      tx,
    );
    return { status: 200 as const, task, agentName: row.agentName };
  });
  if (outcome.status === 404) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({
      error: `A ${outcome.current} task can no longer be cancelled`,
    });
    return;
  }
  // Abort any in-flight provider call after the status is committed, so the
  // worker's conditional finish sees "cancelled" and discards the result.
  abortRunningTask(outcome.task.id);
  publish(req.workspaceId!, "tasks", "approvals", "overview");
  res.json(
    CancelTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)),
  );
});

router.post("/tasks/:taskId/retry", async (req, res): Promise<void> => {
  const params = RetryTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ task: tasksTable, agentName: agentsTable.name })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.id, params.data.taskId),
          eq(tasksTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1)
      .for("update", { of: tasksTable });
    if (!row) return { status: 404 as const };
    if (!RETRYABLE_STATUSES.includes(row.task.status)) {
      return { status: 409 as const, current: row.task.status };
    }
    const [task] = await tx
      .update(tasksTable)
      .set({
        status: "queued",
        attempts: 0,
        notBefore: null,
        errorKind: null,
        errorMessage: null,
        output: null,
        startedAt: null,
        finishedAt: null,
        // A retry is a fresh run, not a continuation: the usage ledger
        // starts over with the rest of the run state.
        continuationSegments: 0,
      })
      .where(eq(tasksTable.id, row.task.id))
      .returning();
    await tx.insert(taskLogsTable).values({
      taskId: task.id,
      level: "info",
      message: "Retried by the owner; requeued for a fresh attempt.",
    });
    await recordAudit(
      req.workspaceId!,
      "task.retried",
      `A task for ${row.agentName} was requeued.`,
      tx,
    );
    return { status: 200 as const, task, agentName: row.agentName };
  });
  if (outcome.status === 404) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({
      error: `Only failed, blocked, or cancelled tasks can be retried (this one is ${outcome.current})`,
    });
    return;
  }
  publish(req.workspaceId!, "tasks", "overview");
  res.json(
    RetryTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)),
  );
});

/**
 * Owner decision for a task that stopped because its provider could not
 * continue — an expired ChatGPT session, an exhausted allowance, or an
 * outage. The three choices are exactly the ones the office offers: wait
 * (requeue on the same provider), cancel, or explicitly authorize a paid
 * fallback for this one task.
 *
 * Nothing here reroutes by itself. `approve_paid_fallback` only records
 * the owner's consent and requeues; the worker still re-evaluates the
 * fallback policy at execution time, so a consent recorded now cannot be
 * used to escape a limit tightened since.
 */
router.post("/tasks/:taskId/fallback", async (req, res): Promise<void> => {
  const params = DecideTaskFallbackParams.safeParse(req.params);
  const body = DecideTaskFallbackBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid fallback decision" });
    return;
  }
  const action = body.data.action;
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ task: tasksTable, agentName: agentsTable.name })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.id, params.data.taskId),
          eq(tasksTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1)
      .for("update", { of: tasksTable });
    if (!row) return { status: 404 as const };
    if (!RETRYABLE_STATUSES.includes(row.task.status)) {
      return { status: 409 as const, current: row.task.status };
    }
    const changes =
      action === "cancel"
        ? {
            status: "cancelled" as const,
            finishedAt: new Date(),
          }
        : {
            status: "queued" as const,
            providerPhase: "queued" as const,
            attempts: 0,
            notBefore: null,
            errorKind: null,
            errorMessage: null,
            startedAt: null,
            finishedAt: null,
            ...(action === "approve_paid_fallback"
              ? { paidFallbackApprovedAt: new Date() }
              : {}),
          };
    const [task] = await tx
      .update(tasksTable)
      .set(changes)
      .where(eq(tasksTable.id, row.task.id))
      .returning();
    const message =
      action === "cancel"
        ? "Stopped by the owner after the provider could not continue."
        : action === "wait"
          ? `Requeued to wait for ${providerLabel(row.task.provider)} to recover.`
          : "The owner authorized a paid fallback for this task; it will be re-checked against the spend policy before it runs.";
    await tx.insert(taskLogsTable).values({
      taskId: task.id,
      level: "info",
      message,
    });
    await recordAudit(
      req.workspaceId!,
      action === "approve_paid_fallback"
        ? "task.paid_fallback_approved"
        : "task.fallback_decision",
      `${row.agentName}'s stopped task: ${message}`,
      tx,
    );
    return { status: 200 as const, task, agentName: row.agentName };
  });
  if (outcome.status === 404) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (outcome.status === 409) {
    res.status(409).json({
      error: `Only a stopped task can take a fallback decision (this one is ${outcome.current})`,
    });
    return;
  }
  publish(req.workspaceId!, "tasks", "overview");
  res.json(
    DecideTaskFallbackResponse.parse(
      toTaskJson(outcome.task, outcome.agentName),
    ),
  );
});

router.post("/tasks/estimate", async (req, res): Promise<void> => {
  const parsed = EstimateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.id, parsed.data.agentId),
        eq(agentsTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const routing = await resolveRouting(
    req.workspaceId!,
    agent,
    parsed.data.providerOverride as ProviderId | undefined,
    parsed.data.modelOverride,
  );
  const estimate = await estimateTask(
    agentPromptContext(agent),
    parsed.data.objective,
    routing,
  );
  res.json(EstimateTaskResponse.parse(estimate));
});

router.post("/tasks/:taskId/usage", async (req, res): Promise<void> => {
  const params = RecordTaskUsageParams.safeParse(req.params);
  const body = RecordTaskUsageBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid usage record" });
    return;
  }
  const [existing] = await db
    .select({ task: tasksTable, agentName: agentsTable.name })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
    .where(
      and(
        eq(tasksTable.id, params.data.taskId),
        eq(tasksTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const costCents =
    body.data.costCents ??
    (await computeUsageCostCents(
      existing.task.provider as ProviderId,
      existing.task.model,
      body.data.inputTokens,
      body.data.outputTokens,
    ));
  const [task] = await db
    .update(tasksTable)
    .set({
      actualInputTokens: Math.round(body.data.inputTokens),
      actualOutputTokens: Math.round(body.data.outputTokens),
      actualCostCents: costCents,
    })
    .where(eq(tasksTable.id, existing.task.id))
    .returning();
  res.json(RecordTaskUsageResponse.parse(toTaskJson(task, existing.agentName)));
});

router.post("/emergency-stop", async (req, res): Promise<void> => {
  const parsed = SetEmergencyStopBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const wsId = req.workspaceId!;
  await setWorkspaceSetting(wsId, "emergency_stop", String(parsed.data.active));
  if (parsed.data.active) {
    const interrupted = await db
      .update(tasksTable)
      .set({
        status: "blocked",
        errorKind: "emergency_stop",
        errorMessage: "The emergency stop was engaged; retry once released.",
      })
      .where(
        and(
          eq(tasksTable.workspaceId, wsId),
          inArray(tasksTable.status, ["queued", "running"]),
        ),
      )
      .returning({ id: tasksTable.id });
    for (const task of interrupted) abortRunningTask(task.id);
  }
  await recordAudit(
    wsId,
    parsed.data.active ? "system.stopped" : "system.resumed",
    parsed.data.active
      ? "This workspace's emergency stop was engaged."
      : "This workspace's emergency stop was released.",
  );
  publish(wsId, "tasks", "agents", "overview");
  res.json(SetEmergencyStopResponse.parse(parsed.data));
});

router.get("/approvals", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      approval: approvalsTable,
      agentName: agentsTable.name,
      taskObjective: tasksTable.objective,
    })
    .from(approvalsTable)
    .innerJoin(agentsTable, eq(approvalsTable.agentId, agentsTable.id))
    .leftJoin(tasksTable, eq(approvalsTable.taskId, tasksTable.id))
    .where(eq(agentsTable.workspaceId, req.workspaceId!))
    .orderBy(desc(approvalsTable.createdAt));
  const reviewerIds = [
    ...new Set(
      rows
        .map((row) => row.approval.reviewerAgentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const reviewerRows =
    reviewerIds.length > 0
      ? await db
          .select({ id: agentsTable.id, name: agentsTable.name })
          .from(agentsTable)
          .where(
            and(
              eq(agentsTable.workspaceId, req.workspaceId!),
              inArray(agentsTable.id, reviewerIds),
            ),
          )
      : [];
  const reviewerNames = new Map(
    reviewerRows.map((reviewer) => [reviewer.id, reviewer.name]),
  );
  res.json(
    ListApprovalsResponse.parse(
      rows.map((row) =>
        toApprovalJson(
          row.approval,
          row.agentName,
          row.taskObjective,
          row.approval.reviewerAgentId
            ? (reviewerNames.get(row.approval.reviewerAgentId) ?? null)
            : null,
        ),
      ),
    ),
  );
});

router.get("/approvals/settings", async (req, res): Promise<void> => {
  res.json(
    GetApprovalSettingsResponse.parse(
      await getApprovalReviewerSettings(req.workspaceId!),
    ),
  );
});

router.put("/approvals/settings", async (req, res): Promise<void> => {
  const body = UpdateApprovalSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Choose a valid approval reviewer." });
    return;
  }
  try {
    const settings = await updateApprovalReviewerSettings(
      req.workspaceId!,
      body.data.reviewerAgentId,
    );
    res.json(UpdateApprovalSettingsResponse.parse(settings));
  } catch (error) {
    if (error instanceof ApprovalReviewerSettingsError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.patch("/approvals/:approvalId", async (req, res): Promise<void> => {
  const params = DecideApprovalParams.safeParse(req.params);
  const body = DecideApprovalBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid approval decision" });
    return;
  }
  try {
    const outcome = await decideApproval({
      workspaceId: req.workspaceId!,
      approvalId: params.data.approvalId,
      decision: body.data.decision,
    });
    res.json(DecideApprovalResponse.parse(outcome));
  } catch (error) {
    if (error instanceof ApprovalDecisionError) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/audit", async (req, res): Promise<void> => {
  const query = SearchAuditQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid audit query" });
    return;
  }
  const limit = Math.min(Math.max(Math.trunc(query.data.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(query.data.offset ?? 0), 0);
  const term = query.data.q?.trim();
  const conditions = [
    eq(auditEventsTable.workspaceId, req.workspaceId!),
    term
      ? or(
          sql`${auditEventsTable.summary} ilike ${`%${term}%`}`,
          sql`${auditEventsTable.kind} ilike ${`%${term}%`}`,
        )
      : undefined,
    query.data.kind
      ? sql`${auditEventsTable.kind} like ${`${query.data.kind}%`}`
      : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [events, [total]] = await Promise.all([
    db
      .select()
      .from(auditEventsTable)
      .where(where)
      .orderBy(desc(auditEventsTable.seq))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEventsTable)
      .where(where),
  ]);
  res.json(
    SearchAuditResponse.parse({
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        summary: event.summary,
        chained: event.hash !== null,
        createdAt: event.createdAt.toISOString(),
      })),
      total: total?.count ?? 0,
    }),
  );
});

router.get("/audit/verify", async (req, res): Promise<void> => {
  res.json(VerifyAuditResponse.parse(await verifyAuditChain(req.workspaceId!)));
});

router.get("/providers", async (req, res): Promise<void> => {
  // Every known provider is reported, including one whose flag is off:
  // hiding it entirely would leave an agent that still references it
  // looking mysteriously broken. `enabled: false` tells the UI to hide it.
  const statuses = await Promise.all(
    PROVIDER_IDS.map((provider) =>
      getProviderHealth(req.workspaceId!, provider),
    ),
  );
  res.json(GetProvidersResponse.parse(statuses));
});

/**
 * Local-only Codex connection check for the signed-in account. It inspects
 * that account's stored sign-in, its recorded auth mode, and SDK
 * availability — it never starts a thread, so it cannot spend anyone's
 * ChatGPT allowance or leave a stray session behind.
 */
router.post("/providers/codex/test", async (req, res): Promise<void> => {
  clearProviderCaches();
  const result = await testCodexConnection(getAuth(req)?.userId);
  await recordAudit(
    req.workspaceId!,
    "providers.codex_tested",
    `The Codex connection was checked locally: ${result.ok ? "ready" : "not ready"}.`,
  );
  res.json(TestCodexConnectionResponse.parse(result));
});

/**
 * Connect the signed-in account's own ChatGPT Codex session.
 *
 * The pasted auth.json is encrypted and stored against that account, so
 * their agents run on their allowance. The value is never logged, never
 * echoed back, and never included in an audit entry — only the outcome is.
 */
router.post("/providers/codex/credential", async (req, res): Promise<void> => {
  const userId = getAuth(req)?.userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to connect a Codex account." });
    return;
  }
  const parsed = ConnectCodexBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let outcome;
  try {
    outcome = await connectCodexCredential(userId, parsed.data.authJson);
  } catch (error) {
    if (error instanceof CodexCredentialError) {
      res.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }
  clearProviderCaches();
  await recordAudit(
    req.workspaceId!,
    "providers.codex_connected",
    `A ChatGPT Codex sign-in was connected for this account: ${outcome.action}.`,
  );
  req.log.info({ action: outcome.action }, "Codex credential connected");
  res.json(ConnectCodexResponse.parse(outcome));
});

router.delete(
  "/providers/codex/credential",
  async (req, res): Promise<void> => {
    const userId = getAuth(req)?.userId;
    if (!userId) {
      res.status(401).json({ error: "Sign in to manage a Codex account." });
      return;
    }
    const removed = await disconnectCodexCredential(userId);
    clearProviderCaches();
    await recordAudit(
      req.workspaceId!,
      "providers.codex_disconnected",
      removed
        ? "The stored ChatGPT Codex sign-in was removed for this account."
        : "A Codex disconnect was requested, but this account had no sign-in stored.",
    );
    res.json(
      DisconnectCodexResponse.parse({
        action: removed ? "disconnected" : "skipped",
        detail: removed
          ? "Disconnected. The stored sign-in and its working copy were deleted; Codex runs stop until an account is connected again."
          : "There was no Codex sign-in stored for this account.",
      }),
    );
  },
);

/**
 * Seed this account's sign-in from CODEX_AUTH_JSON, for operators who
 * configure one rather than pasting it in. Refuses to overwrite a stored
 * sign-in so a session Codex has since refreshed is never rolled back.
 */
router.post("/providers/codex/bootstrap", async (req, res): Promise<void> => {
  const outcome = await bootstrapCodexHome(getAuth(req)?.userId);
  clearProviderCaches();
  await recordAudit(
    req.workspaceId!,
    "providers.codex_bootstrapped",
    `Codex credential bootstrap: ${outcome.action}.`,
  );
  req.log.info({ action: outcome.action }, "Codex bootstrap");
  res.json(BootstrapCodexResponse.parse(outcome));
});

/**
 * Store this workspace's own Claude Code token or OpenRouter API key.
 * The value is encrypted per workspace, never logged, never echoed back,
 * and never mentioned in audit entries — only the outcome is.
 *
 * ORDERING: these `:provider` routes are registered AFTER every literal
 * `/providers/codex/...` route on purpose. Express matches in registration
 * order, so putting a `:provider` pattern first would swallow
 * `DELETE /providers/codex/credential` and reject "codex" as an unknown
 * provider (a real production bug). Keep literal provider routes above
 * parameterized ones.
 */
router.put(
  "/providers/:provider/credential",
  async (req, res): Promise<void> => {
    const params = SetProviderCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Unknown provider" });
      return;
    }
    const provider = params.data.provider as "claude_max" | "openrouter";
    const parsed = SetProviderCredentialBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "A credential of at least 8 characters is required.",
      });
      return;
    }
    if (provider === "claude_max") {
      // Reject the wrong kind of secret before it is stored, with precise
      // remediation. The guidance never quotes the submitted value.
      const problem = claudeSetupTokenProblem(parsed.data.credential);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
    }
    try {
      await saveProviderCredential(
        req.workspaceId!,
        provider,
        parsed.data.credential,
      );
    } catch (error) {
      if (error instanceof ProviderCredentialError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    clearProviderCaches();
    await recordAudit(
      req.workspaceId!,
      "providers.credential_set",
      `A ${providerLabel(provider)} credential was stored for this workspace.`,
    );
    res.json(
      SetProviderCredentialResponse.parse(
        await getProviderHealth(req.workspaceId!, provider),
      ),
    );
  },
);

router.delete(
  "/providers/:provider/credential",
  async (req, res): Promise<void> => {
    const params = DeleteProviderCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Unknown provider" });
      return;
    }
    const provider = params.data.provider as "claude_max" | "openrouter";
    const removed = await deleteProviderCredential(req.workspaceId!, provider);
    clearProviderCaches();
    await recordAudit(
      req.workspaceId!,
      "providers.credential_removed",
      removed
        ? `The workspace's ${providerLabel(provider)} credential was removed.`
        : `A ${providerLabel(provider)} credential removal was requested, but none was stored.`,
    );
    res.json(
      DeleteProviderCredentialResponse.parse(
        await getProviderHealth(req.workspaceId!, provider),
      ),
    );
  },
);

router.get("/providers/settings", async (req, res): Promise<void> => {
  res.json(
    GetProviderSettingsResponse.parse(
      await getProviderSettings(req.workspaceId!),
    ),
  );
});

router.put("/providers/settings", async (req, res): Promise<void> => {
  const parsed = UpdateProviderSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let settings;
  try {
    settings = await updateProviderSettings(req.workspaceId!, {
      defaultProvider: parsed.data.defaultProvider as ProviderId | undefined,
      claudeModel: parsed.data.claudeModel,
      openrouterModel: parsed.data.openrouterModel,
      codexModel: parsed.data.codexModel,
      codexReasoning: parsed.data.codexReasoning,
      fallbackOrder: parsed.data.fallbackOrder as ProviderId[] | undefined,
      paidFallbackConsent: parsed.data.paidFallbackConsent,
      paidFallbackLimitCents: parsed.data.paidFallbackLimitCents,
    });
  } catch (error) {
    if (error instanceof ProviderSettingsError) {
      res.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }
  await recordAudit(
    req.workspaceId!,
    "providers.settings_updated",
    `Provider routing defaults were updated (default: ${providerLabel(settings.defaultProvider)}).`,
  );
  res.json(UpdateProviderSettingsResponse.parse(settings));
});

router.get("/providers/:provider/models", async (req, res): Promise<void> => {
  const params = ListProviderModelsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Unknown provider" });
    return;
  }
  const catalog = await getModelCatalog(
    req.workspaceId!,
    params.data.provider as ProviderId,
  );
  res.json(ListProviderModelsResponse.parse(catalog));
});

export default router;
