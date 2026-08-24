import { clerkClient, getAuth } from "@clerk/express";
import {
  CancelTaskParams,
  CancelTaskResponse,
  CreateAgentBody,
  CreateAgentResponse,
  CreateTaskBody,
  CreateTaskResponse,
  BootstrapCodexResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
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
  SetAgentArchivedBody,
  SetAgentArchivedParams,
  SetAgentArchivedResponse,
  SetEmergencyStopBody,
  SetEmergencyStopResponse,
  TestCodexConnectionResponse,
  UpdateAgentBody,
  UpdateAgentParams,
  UpdateAgentResponse,
  UpdateProviderSettingsBody,
  UpdateProviderSettingsResponse,
} from "@workspace/api-zod";
import {
  agentsTable,
  approvalsTable,
  auditEventsTable,
  db,
  systemStateTable,
  taskLogsTable,
  tasksTable,
  teamsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
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
import { bootstrapCodexHome } from "../codex/runtime";
import { codexReasoningLevels } from "../codex/config";
import { listProviderLeases } from "../provider-leases";
import { recordAudit, verifyAuditChain } from "../audit";
import { agentPromptContext, dispatchTask } from "../dispatch";
import { publish } from "../events";
import { effectivePermissions } from "../policy";
import {
  DEFAULT_RUNTIME,
  listRuntimeHealth,
  queueHealth,
} from "../runtime";
import { abortRunningTask, getWorkerStatus } from "../worker";
import eventsRouter from "./events";
import memoryRouter from "./memory";
import notificationsRouter from "./notifications";
import reportsRouter from "./reports";
import schedulesRouter from "./schedules";
import teamsRouter from "./teams";
import voiceRouter from "./voice";

const router: IRouter = Router();

/**
 * The office is claimed by the first account that signs in, and the claim is
 * stored as a Clerk user id. Clerk keeps separate user stores for development
 * and production, so a published office whose owner row was seeded from
 * development holds an id no production account can ever match — the owner is
 * locked out of their own app with no way back in.
 *
 * OWNER_EMAIL is the identity that survives that move: whenever the signed-in
 * account's verified email matches it, ownership follows to that account's id.
 * Unset, the original first-come claim still applies.
 */
const configuredOwnerEmail = (): string | null =>
  process.env.OWNER_EMAIL?.trim().toLowerCase() || null;

/**
 * Only refusals are remembered, and only briefly: an account that does not own
 * the office keeps being turned away without a Clerk call per request. A match
 * is never cached, so handing over the office always rests on a fresh lookup —
 * a stale positive would keep authorising an address the owner has since
 * changed or lost.
 */
const DENIAL_TTL_MS = 60_000;
const DENIAL_LIMIT = 500;
const denials = new Map<string, { email: string | null; at: number }>();

/** The signed-in account's verified primary email, straight from Clerk. */
async function verifiedEmail(
  req: Request,
  userId: string,
): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const address = user.primaryEmailAddress ?? user.emailAddresses?.[0];
    // An unverified address proves nothing: anyone could sign up claiming the
    // owner's email and take the office with it.
    if (address?.verification?.status !== "verified") return null;
    return address.emailAddress?.trim().toLowerCase() ?? null;
  } catch (error) {
    // A Clerk outage must not hand the office to the wrong account, so a failed
    // lookup simply means no match.
    req.log.warn({ userId, err: error }, "Could not resolve signed-in email");
    return null;
  }
}

function rememberDenial(userId: string, email: string | null): void {
  if (denials.size >= DENIAL_LIMIT) denials.clear();
  denials.set(userId, { email, at: Date.now() });
}

async function currentOwner(): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  return row?.value;
}

async function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  await db
    .insert(systemStateTable)
    .values({ key: "owner_clerk_id", value: userId })
    .onConflictDoNothing();
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner?.value === userId) {
    next();
    return;
  }

  const ownerEmail = configuredOwnerEmail();
  let email: string | null = null;
  if (ownerEmail) {
    const denied = denials.get(userId);
    if (denied && Date.now() - denied.at < DENIAL_TTL_MS) {
      email = denied.email;
    } else {
      email = await verifiedEmail(req, userId);
      if (email !== ownerEmail) rememberDenial(userId, email);
    }
  }

  if (ownerEmail && email === ownerEmail) {
    // Compare and set against the owner this request actually read, so two
    // simultaneous hand-overs cannot interleave into a half-applied one.
    const moved = await db
      .update(systemStateTable)
      .set({ value: userId })
      .where(
        and(
          eq(systemStateTable.key, "owner_clerk_id"),
          eq(systemStateTable.value, owner?.value ?? ""),
        ),
      )
      .returning({ value: systemStateTable.value });
    const settled = moved[0]?.value ?? (await currentOwner());
    if (settled === userId) {
      req.log.warn({ userId }, "Office ownership moved to the configured owner");
      next();
      return;
    }
  }

  req.log.warn({ userId }, "Blocked non-owner access");
  res.status(403).json({
    error: email
      ? `This office already has an owner. You are signed in as ${email}.`
      : "This office already has an owner",
  });
}

router.use(requireOwner);
// Memory, knowledge, and team routes share the owner gate above.
router.use(memoryRouter);
router.use(teamsRouter);
router.use(voiceRouter);
router.use(schedulesRouter);
router.use(notificationsRouter);
router.use(reportsRouter);
router.use(eventsRouter);

router.get("/runtime/health", async (_req: Request, res: Response) => {
  const [runtimes, queue, stop] = await Promise.all([
    listRuntimeHealth(),
    queueHealth(),
    db
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "emergency_stop"))
      .limit(1),
  ]);
  const worker = getWorkerStatus();
  res.json(
    GetRuntimeHealthResponse.parse({
      activeRuntime: DEFAULT_RUNTIME,
      runtimes,
      queue,
      worker: {
        leaseHeld: worker.leaseHeld,
        running: worker.running,
        inFlight: worker.inFlight,
        emergencyStop: stop[0]?.value === "true",
        lastTickAt: worker.lastTickAt ? worker.lastTickAt.toISOString() : null,
      },
    }),
  );
});

function toAgent(agent: typeof agentsTable.$inferSelect) {
  return {
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
  return {
    ...task,
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

/** Statuses the owner may cancel from; everything else is already final. */
const CANCELLABLE_STATUSES = ["queued", "running", "waiting_approval", "blocked"];
/** Statuses eligible for a fresh retry attempt. */
const RETRYABLE_STATUSES = ["failed", "cancelled", "blocked"];


/** Case-insensitive name collision check across every agent, any lifecycle state. */
async function findNameConflict(
  tx: Tx | typeof db,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(sql`lower(${agentsTable.name}) = lower(${name})`)
    .limit(2);
  return rows.some((row) => row.id !== excludeId);
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError), so the Postgres error
  // code lives on the cause chain, not the thrown error itself.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

router.get("/office/overview", async (_req, res): Promise<void> => {
  const [[agentCount], [activeCount], [approvalCount], [stop], events, [spend]] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentsTable)
        .where(
          and(eq(agentsTable.retired, false), eq(agentsTable.archived, false)),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasksTable)
        .where(inArray(tasksTable.status, ["queued", "running"])),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalsTable)
        .where(eq(approvalsTable.status, "pending")),
      db
        .select()
        .from(systemStateTable)
        .where(eq(systemStateTable.key, "emergency_stop"))
        .limit(1),
      db
        .select()
        .from(auditEventsTable)
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(8),
      db
        .select({
          cents: sql<number>`coalesce(sum(${tasksTable.actualCostCents}), 0)::float`,
        })
        .from(tasksTable)
        .where(
          sql`${tasksTable.createdAt} >= date_trunc('month', now())`,
        ),
    ]);

  res.json(
    GetOfficeOverviewResponse.parse({
      agents: agentCount?.count ?? 0,
      activeTasks: activeCount?.count ?? 0,
      pendingApprovals: approvalCount?.count ?? 0,
      emergencyStop: stop?.value === "true",
      monthlyCostCents: Math.round((spend?.cents ?? 0) * 100) / 100,
      recentEvents: events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    }),
  );
});

router.get("/agents", async (_req, res): Promise<void> => {
  const agents = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.retired, false))
    .orderBy(agentsTable.name);
  res.json(ListAgentsResponse.parse(agents.map(toAgent)));
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
  if (await findNameConflict(db, parsed.data.name)) {
    res
      .status(409)
      .json({ error: `An agent named "${parsed.data.name}" already exists` });
    return;
  }
  try {
    const [agent] = await db
      .insert(agentsTable)
      .values({ ...parsed.data, avatar, status: "idle" })
      .returning();
    await recordAudit(
      "agent.created",
      `${agent.name} joined the office as ${agent.title}.`,
    );
    res.status(201).json(CreateAgentResponse.parse(toAgent(agent)));
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
    .where(eq(agentsTable.id, params.data.agentId))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.agentId, agent.id))
    .orderBy(desc(tasksTable.createdAt))
    .limit(50);
  res.json(
    GetAgentResponse.parse({
      agent: toAgent(agent),
      tasks: tasks.map((task) => ({
        ...task,
        agentName: agent.name,
        createdAt: task.createdAt.toISOString(),
      })),
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
  const updates = Object.fromEntries(
    Object.entries(body.data).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  try {
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, params.data.agentId))
        .limit(1)
        .for("update");
      if (!existing) return { status: 404 as const };
      if (existing.retired) return { status: 409 as const, retired: true };
      if (
        typeof updates.name === "string" &&
        (await findNameConflict(tx, updates.name, existing.id))
      ) {
        return { status: 409 as const, retired: false, name: updates.name };
      }
      const [agent] = await tx
        .update(agentsTable)
        .set(updates)
        .where(eq(agentsTable.id, existing.id))
        .returning();
      await recordAudit(
      "agent.updated",
      `${agent.name}'s profile was updated.`,
      tx,
    );
      return { status: 200 as const, agent };
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
    res.json(UpdateAgentResponse.parse(toAgent(outcome.agent)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That agent name is already in use" });
      return;
    }
    throw error;
  }
});

async function duplicateAgentOnce(agentId: string) {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    if (!source) return { status: 404 as const };
    if (source.retired) return { status: 409 as const };
    // "Name Copy", then "Name Copy 2", "Name Copy 3", ... within the 60-char
    // name budget enforced by the API contract.
    const base = `${source.name.slice(0, 48).trimEnd()} Copy`;
    let candidate = base;
    for (let n = 2; await findNameConflict(tx, candidate); n += 1) {
      if (n > 50) return { status: 409 as const };
      candidate = `${base} ${n}`;
    }
    const [agent] = await tx
      .insert(agentsTable)
      .values({
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
    await recordAudit(
      "agent.duplicated",
      `${agent.name} was recruited as a copy of ${source.name}.`,
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
      outcome = await duplicateAgentOnce(params.data.agentId);
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
          : { archived: false, archivedAt: null, paused: false, status: "idle" },
      )
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, !archived),
        ),
      )
      .returning();
    if (!agent) {
      const [existing] = await tx
        .select({ id: agentsTable.id, retired: agentsTable.retired })
        .from(agentsTable)
        .where(eq(agentsTable.id, params.data.agentId))
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
  res.json(SetAgentArchivedResponse.parse(toAgent(outcome.agent)));
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
      .where(eq(agentsTable.id, params.data.agentId))
      .limit(1)
      .for("update");
    if (!agent) return { status: 404 as const };
    // Retirement to the Island is permanent by design; retired agents are
    // never erased.
    if (agent.retired) return { status: 409 as const };
    await tx
      .delete(approvalsTable)
      .where(eq(approvalsTable.agentId, agent.id));
    // Collect active tasks first so any in-flight provider calls can be
    // aborted after the delete commits; otherwise the worker would keep
    // spending against rows that no longer exist.
    const active = await tx
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.agentId, agent.id),
          eq(tasksTable.status, "running"),
        ),
      );
    await tx.delete(tasksTable).where(eq(tasksTable.agentId, agent.id));
    await tx.delete(agentsTable).where(eq(agentsTable.id, agent.id));
    await recordAudit(
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
      error: "Retired agents rest on the Island permanently and cannot be deleted",
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
        eq(agentsTable.retired, false),
        eq(agentsTable.archived, false),
      ),
    )
    .returning();
  if (!agent) {
    const [existing] = await db
      .select({ archived: agentsTable.archived, retired: agentsTable.retired })
      .from(agentsTable)
      .where(eq(agentsTable.id, params.data.agentId))
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
      body.data.paused ? "agent.paused" : "agent.resumed",
      `${agent.name} was ${body.data.paused ? "paused" : "resumed"}.`,
    );
  res.json(PauseAgentResponse.parse(toAgent(agent)));
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
          eq(agentsTable.retired, false),
        ),
      )
      .returning();
    if (!agent) {
      const [existing] = await tx
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.id, params.data.agentId))
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

router.get("/island/agents", async (_req, res): Promise<void> => {
  const agents = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.retired, true))
    .orderBy(desc(agentsTable.retiredAt));
  res.json(ListRetiredAgentsResponse.parse(agents.map(toRetiredAgent)));
});

router.get("/tasks", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      task: tasksTable,
      agentName: agentsTable.name,
    })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
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
    objective: parsed.data.objective,
    priority: parsed.data.priority,
    budgetCents: parsed.data.budgetCents ?? null,
    providerOverride: parsed.data.providerOverride as ProviderId | undefined,
    modelOverride: parsed.data.modelOverride,
    reasoningOverride: parsed.data.reasoningOverride,
    continueConversation: parsed.data.continueConversation,
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
    .json(CreateTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)));
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
    .where(eq(tasksTable.id, params.data.taskId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const logs = await db
    .select()
    .from(taskLogsTable)
    .where(eq(taskLogsTable.taskId, row.task.id))
    .orderBy(taskLogsTable.createdAt);
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
      .where(eq(tasksTable.id, params.data.taskId))
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
  publish("tasks", "approvals", "overview");
  res.json(CancelTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)));
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
      .where(eq(tasksTable.id, params.data.taskId))
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
      })
      .where(eq(tasksTable.id, row.task.id))
      .returning();
    await tx.insert(taskLogsTable).values({
      taskId: task.id,
      level: "info",
      message: "Retried by the owner; requeued for a fresh attempt.",
    });
    await recordAudit(
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
  publish("tasks", "overview");
  res.json(RetryTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)));
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
      .where(eq(tasksTable.id, params.data.taskId))
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
  publish("tasks", "overview");
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
    .where(eq(agentsTable.id, parsed.data.agentId))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const routing = await resolveRouting(
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
    .where(eq(tasksTable.id, params.data.taskId))
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
  await db
    .insert(systemStateTable)
    .values({ key: "emergency_stop", value: String(parsed.data.active) })
    .onConflictDoUpdate({
      target: systemStateTable.key,
      set: { value: String(parsed.data.active) },
    });
  if (parsed.data.active) {
    const interrupted = await db
      .update(tasksTable)
      .set({
        status: "blocked",
        errorKind: "emergency_stop",
        errorMessage: "The emergency stop was engaged; retry once released.",
      })
      .where(inArray(tasksTable.status, ["queued", "running"]))
      .returning({ id: tasksTable.id });
    for (const task of interrupted) abortRunningTask(task.id);
  }
  await recordAudit(
      parsed.data.active ? "system.stopped" : "system.resumed",
      parsed.data.active
      ? "Global emergency stop was engaged."
      : "Global emergency stop was released.",
    );
  publish("tasks", "agents", "overview");
  res.json(SetEmergencyStopResponse.parse(parsed.data));
});

function toApprovalJson(
  approval: typeof approvalsTable.$inferSelect,
  agentName: string,
  taskObjective: string | null,
) {
  return {
    id: approval.id,
    agentName,
    taskId: approval.taskId,
    taskObjective,
    action: approval.action,
    details: approval.details,
    status: approval.status,
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
  };
}

router.get("/approvals", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      approval: approvalsTable,
      agentName: agentsTable.name,
      taskObjective: tasksTable.objective,
    })
    .from(approvalsTable)
    .innerJoin(agentsTable, eq(approvalsTable.agentId, agentsTable.id))
    .leftJoin(tasksTable, eq(approvalsTable.taskId, tasksTable.id))
    .orderBy(desc(approvalsTable.createdAt));
  res.json(
    ListApprovalsResponse.parse(
      rows.map((row) =>
        toApprovalJson(row.approval, row.agentName, row.taskObjective),
      ),
    ),
  );
});

router.patch("/approvals/:approvalId", async (req, res): Promise<void> => {
  const params = DecideApprovalParams.safeParse(req.params);
  const body = DecideApprovalBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid approval decision" });
    return;
  }
  // Decision and task transition commit atomically: an approved task
  // requeues (the worker re-checks policy and honors the approval), a
  // rejected task cancels. Expired approvals cannot be decided.
  const outcome = await db.transaction(async (tx) => {
    const [approval] = await tx
      .update(approvalsTable)
      .set({ status: body.data.decision, decidedAt: new Date() })
      .where(
        and(
          eq(approvalsTable.id, params.data.approvalId),
          eq(approvalsTable.status, "pending"),
          sql`${approvalsTable.expiresAt} > now()`,
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
    if (approval.taskId) {
      if (body.data.decision === "approved") {
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
            message: "Approved by the owner; requeued to run.",
          });
        }
      } else {
        const [task] = await tx
          .update(tasksTable)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            errorKind: "approval_rejected",
            errorMessage: "The owner rejected this task's approval request.",
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
            message: "Rejected by the owner; task cancelled.",
          });
        }
      }
    }
    await recordAudit(
      `approval.${body.data.decision}`,
      `${approval.action} was ${body.data.decision} by the owner.`,
      tx,
    );
    return { approval, agentName: agent?.name ?? "Unknown agent", taskObjective };
  });
  if (!outcome) {
    res.status(404).json({ error: "Pending approval not found" });
    return;
  }
  publish("approvals", "tasks", "overview");
  res.json(
    DecideApprovalResponse.parse(
      toApprovalJson(outcome.approval, outcome.agentName, outcome.taskObjective),
    ),
  );
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

router.get("/audit/verify", async (_req, res): Promise<void> => {
  res.json(VerifyAuditResponse.parse(await verifyAuditChain()));
});

router.get("/providers", async (_req, res): Promise<void> => {
  // Every known provider is reported, including one whose flag is off:
  // hiding it entirely would leave an agent that still references it
  // looking mysteriously broken. `enabled: false` tells the UI to hide it.
  const statuses = await Promise.all(
    PROVIDER_IDS.map((provider) => getProviderHealth(provider)),
  );
  res.json(GetProvidersResponse.parse(statuses));
});

/**
 * Owner-only, local-only Codex connection check. It inspects the private
 * CODEX_HOME, the recorded auth mode, and SDK availability — it never
 * starts a thread, so it cannot spend the ChatGPT allowance or leave a
 * stray session behind.
 */
router.post("/providers/codex/test", async (_req, res): Promise<void> => {
  clearProviderCaches();
  const result = await testCodexConnection();
  await recordAudit(
    "providers.codex_tested",
    `The Codex connection was checked locally: ${result.ok ? "ready" : "not ready"}.`,
  );
  res.json(TestCodexConnectionResponse.parse(result));
});

/**
 * One-time bootstrap of the private CODEX_HOME from CODEX_AUTH_JSON.
 * Refuses to overwrite an existing auth.json so a session the Codex CLI
 * has since refreshed is never clobbered by a stale secret.
 */
router.post("/providers/codex/bootstrap", async (req, res): Promise<void> => {
  const outcome = await bootstrapCodexHome();
  clearProviderCaches();
  await recordAudit(
    "providers.codex_bootstrapped",
    `Codex credential bootstrap: ${outcome.action}.`,
  );
  req.log.info({ action: outcome.action }, "Codex bootstrap");
  res.json(BootstrapCodexResponse.parse(outcome));
});

router.get("/providers/settings", async (_req, res): Promise<void> => {
  res.json(GetProviderSettingsResponse.parse(await getProviderSettings()));
});

router.put("/providers/settings", async (req, res): Promise<void> => {
  const parsed = UpdateProviderSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let settings;
  try {
    settings = await updateProviderSettings({
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
  const catalog = await getModelCatalog(params.data.provider as ProviderId);
  res.json(ListProviderModelsResponse.parse(catalog));
});

export default router;
