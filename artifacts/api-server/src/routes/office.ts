import { getAuth } from "@clerk/express";
import {
  CancelTaskParams,
  CancelTaskResponse,
  CreateAgentBody,
  CreateAgentResponse,
  CreateTaskBody,
  CreateTaskResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
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
  SetAgentArchivedBody,
  SetAgentArchivedParams,
  SetAgentArchivedResponse,
  SetEmergencyStopBody,
  SetEmergencyStopResponse,
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
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  PROVIDER_IDS,
  computeUsageCostCents,
  estimateTask,
  getModelCatalog,
  getProviderHealth,
  getProviderSettings,
  isConfigured,
  resolveRouting,
  updateProviderSettings,
  type ProviderId,
} from "../providers";
import { abortRunningTask } from "../worker";
import memoryRouter from "./memory";

const router: IRouter = Router();

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
  if (owner?.value !== userId) {
    req.log.warn({ userId }, "Blocked non-owner access");
    res.status(403).json({ error: "This office already has an owner" });
    return;
  }
  next();
}

router.use(requireOwner);
// Memory and knowledge routes share the owner gate above.
router.use(memoryRouter);

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
    voiceStyle: agent.voiceStyle,
    status: agent.status,
    securityPreset: agent.securityPreset,
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
) {
  return {
    ...task,
    agentName,
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
    createdAt: task.createdAt.toISOString(),
  };
}

/** Statuses the owner may cancel from; everything else is already final. */
const CANCELLABLE_STATUSES = ["queued", "running", "waiting_approval", "blocked"];
/** Statuses eligible for a fresh retry attempt. */
const RETRYABLE_STATUSES = ["failed", "cancelled", "blocked"];

/** Prompt-relevant agent configuration used for token estimation. */
function agentPromptContext(agent: {
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
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
    await db.insert(auditEventsTable).values({
      kind: "agent.created",
      summary: `${agent.name} joined the office as ${agent.title}.`,
    });
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
      await tx.insert(auditEventsTable).values({
        kind: "agent.updated",
        summary: `${agent.name}'s profile was updated.`,
      });
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
        avatar: source.avatar,
        status: "idle",
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      kind: "agent.duplicated",
      summary: `${agent.name} was recruited as a copy of ${source.name}.`,
    });
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
    await tx.insert(auditEventsTable).values({
      kind: archived ? "agent.archived" : "agent.restored",
      summary: archived
        ? `${agent.name} was archived and stepped away from the office.`
        : `${agent.name} was restored to the active roster.`,
    });
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
    await tx.insert(auditEventsTable).values({
      kind: "agent.deleted",
      summary: `${agent.name} and their task history were permanently deleted.`,
    });
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
  await db.insert(auditEventsTable).values({
    kind: body.data.paused ? "agent.paused" : "agent.resumed",
    summary: `${agent.name} was ${body.data.paused ? "paused" : "resumed"}.`,
  });
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
    await tx.insert(auditEventsTable).values({
      kind: "agent.retired",
      summary: `${agent.name} retired to the island after honorable service.`,
    });
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
  type CreateOutcome =
    | { status: 404 }
    | { status: 409 }
    | { status: 425 } // internal marker: routing went stale, retry
    | {
        status: 201;
        task: typeof tasksTable.$inferSelect;
        agentName: string;
      };
  // Resolve routing and pricing before opening the transaction: pricing may
  // hit the provider's (cached) model catalog and must not run while a row
  // lock is held. If the agent's routing configuration changes concurrently,
  // the transaction detects it against the locked row and we re-resolve.
  let outcome: CreateOutcome = { status: 425 };
  for (let attempt = 0; attempt < 2 && outcome.status === 425; attempt += 1) {
    const [preview] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, parsed.data.agentId))
      .limit(1);
    if (!preview) {
      outcome = { status: 404 };
      break;
    }
    if (preview.retired || preview.archived) {
      outcome = { status: 409 };
      break;
    }
    const routing = await resolveRouting(
      preview,
      parsed.data.providerOverride as ProviderId | undefined,
      parsed.data.modelOverride,
    );
    const estimate = await estimateTask(
      agentPromptContext(preview),
      parsed.data.objective,
      routing,
    );
    outcome = await db.transaction(async (tx): Promise<CreateOutcome> => {
      // Lock the agent row so a concurrent retirement cannot slip in between
      // the check and the task insert.
      const [agent] = await tx
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, parsed.data.agentId))
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
      const [stop] = await tx
        .select()
        .from(systemStateTable)
        .where(eq(systemStateTable.key, "emergency_stop"))
        .limit(1);
      const configured = isConfigured(routing.provider);
      // Unconfigured providers and the emergency stop block explicitly, with
      // a reason the owner can act on; a paused agent's tasks simply wait in
      // the queue until the agent resumes.
      const blockReason =
        stop?.value === "true"
          ? { errorKind: "emergency_stop", errorMessage: "The emergency stop is engaged." }
          : !configured
            ? {
                errorKind: "not_configured",
                errorMessage: `${routing.provider === "claude_max" ? "Claude" : "OpenRouter"} is not configured; add the credential and retry.`,
              }
            : null;
      const [task] = await tx
        .insert(tasksTable)
        .values({
          agentId: agent.id,
          objective: parsed.data.objective,
          priority: parsed.data.priority ?? "normal",
          budgetCents: parsed.data.budgetCents ?? null,
          provider: routing.provider,
          model: routing.model,
          estimatedTokens: estimate.estimatedTokens,
          estimatedCostCents: estimate.costKnown
            ? estimate.estimatedCostCents
            : null,
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
      await tx.insert(auditEventsTable).values({
        kind: "task.created",
        summary: blockReason
          ? `A task for ${agent.name} was blocked: ${blockReason.errorMessage}`
          : `A task was queued for ${agent.name}.`,
      });
      return { status: 201, task, agentName: agent.name };
    });
  }
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
  const [row] = await db
    .select({ task: tasksTable, agentName: agentsTable.name })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
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
      task: toTaskJson(row.task, row.agentName),
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
    await tx.insert(taskLogsTable).values({
      taskId: task.id,
      level: "warn",
      message: "Cancelled by the owner.",
    });
    await tx.insert(auditEventsTable).values({
      kind: "task.cancelled",
      summary: `A task for ${row.agentName} was cancelled.`,
    });
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
    await tx.insert(auditEventsTable).values({
      kind: "task.retried",
      summary: `A task for ${row.agentName} was requeued.`,
    });
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
  res.json(RetryTaskResponse.parse(toTaskJson(outcome.task, outcome.agentName)));
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
  await db.insert(auditEventsTable).values({
    kind: parsed.data.active ? "system.stopped" : "system.resumed",
    summary: parsed.data.active
      ? "Global emergency stop was engaged."
      : "Global emergency stop was released.",
  });
  res.json(SetEmergencyStopResponse.parse(parsed.data));
});

router.get("/approvals", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: approvalsTable.id,
      agentName: agentsTable.name,
      action: approvalsTable.action,
      details: approvalsTable.details,
      status: approvalsTable.status,
      createdAt: approvalsTable.createdAt,
      expiresAt: approvalsTable.expiresAt,
    })
    .from(approvalsTable)
    .innerJoin(agentsTable, eq(approvalsTable.agentId, agentsTable.id))
    .orderBy(desc(approvalsTable.createdAt));
  res.json(
    ListApprovalsResponse.parse(
      rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
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
  const [approval] = await db
    .update(approvalsTable)
    .set({ status: body.data.decision })
    .where(
      and(
        eq(approvalsTable.id, params.data.approvalId),
        eq(approvalsTable.status, "pending"),
      ),
    )
    .returning();
  if (!approval) {
    res.status(404).json({ error: "Pending approval not found" });
    return;
  }
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, approval.agentId))
    .limit(1);
  await db.insert(auditEventsTable).values({
    kind: `approval.${body.data.decision}`,
    summary: `${approval.action} was ${body.data.decision}.`,
  });
  res.json(
    DecideApprovalResponse.parse({
      ...approval,
      agentName: agent?.name ?? "Unknown agent",
      createdAt: approval.createdAt.toISOString(),
      expiresAt: approval.expiresAt.toISOString(),
    }),
  );
});

router.get("/providers", async (_req, res): Promise<void> => {
  const statuses = await Promise.all(
    PROVIDER_IDS.map((provider) => getProviderHealth(provider)),
  );
  res.json(GetProvidersResponse.parse(statuses));
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
  const settings = await updateProviderSettings({
    defaultProvider: parsed.data.defaultProvider as ProviderId | undefined,
    claudeModel: parsed.data.claudeModel,
    openrouterModel: parsed.data.openrouterModel,
  });
  await db.insert(auditEventsTable).values({
    kind: "providers.settings_updated",
    summary: `Provider routing defaults were updated (default: ${settings.defaultProvider}).`,
  });
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
