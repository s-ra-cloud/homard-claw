import { getAuth } from "@clerk/express";
import {
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
  GetAgentParams,
  GetAgentResponse,
  GetOfficeOverviewResponse,
  GetProvidersResponse,
  ListAgentsResponse,
  ListApprovalsResponse,
  ListRetiredAgentsResponse,
  ListTasksResponse,
  PauseAgentBody,
  PauseAgentParams,
  PauseAgentResponse,
  RetireAgentParams,
  RetireAgentResponse,
  SetAgentArchivedBody,
  SetAgentArchivedParams,
  SetAgentArchivedResponse,
  SetEmergencyStopBody,
  SetEmergencyStopResponse,
  UpdateAgentBody,
  UpdateAgentParams,
  UpdateAgentResponse,
} from "@workspace/api-zod";
import {
  agentsTable,
  approvalsTable,
  auditEventsTable,
  db,
  systemStateTable,
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
  const [[agentCount], [activeCount], [approvalCount], [stop], events] =
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
    ]);

  res.json(
    GetOfficeOverviewResponse.parse({
      agents: agentCount?.count ?? 0,
      activeTasks: activeCount?.count ?? 0,
      pendingApprovals: approvalCount?.count ?? 0,
      emergencyStop: stop?.value === "true",
      monthlyCostCents: 0,
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
    if (archived) {
      await tx
        .update(tasksTable)
        .set({ status: "paused" })
        .where(
          and(
            eq(tasksTable.agentId, agent.id),
            inArray(tasksTable.status, [
              "queued",
              "running",
              "waiting_approval",
            ]),
          ),
        );
    }
    await tx.insert(auditEventsTable).values({
      kind: archived ? "agent.archived" : "agent.restored",
      summary: archived
        ? `${agent.name} was archived and stepped away from the office.`
        : `${agent.name} was restored to the active roster.`,
    });
    return { status: 200 as const, agent };
  });
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
    await tx.delete(tasksTable).where(eq(tasksTable.agentId, agent.id));
    await tx.delete(agentsTable).where(eq(agentsTable.id, agent.id));
    await tx.insert(auditEventsTable).values({
      kind: "agent.deleted",
      summary: `${agent.name} and their task history were permanently deleted.`,
    });
    return { status: 204 as const };
  });
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
    await tx
      .update(tasksTable)
      .set({ status: "paused" })
      .where(
        and(
          eq(tasksTable.agentId, agent.id),
          inArray(tasksTable.status, ["queued", "running", "waiting_approval"]),
        ),
      );
    await tx.insert(auditEventsTable).values({
      kind: "agent.retired",
      summary: `${agent.name} retired to the island after honorable service.`,
    });
    return { status: 200 as const, agent };
  });
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
      id: tasksTable.id,
      agentId: tasksTable.agentId,
      agentName: agentsTable.name,
      objective: tasksTable.objective,
      status: tasksTable.status,
      provider: tasksTable.provider,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
    .orderBy(desc(tasksTable.createdAt));
  res.json(
    ListTasksResponse.parse(
      rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    // Lock the agent row so a concurrent retirement cannot slip in between
    // the check and the task insert.
    const [agent] = await tx
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, parsed.data.agentId))
      .limit(1)
      .for("update");
    if (!agent) return { status: 404 as const };
    if (agent.retired || agent.archived) return { status: 409 as const };
    const [stop] = await tx
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "emergency_stop"))
      .limit(1);
    const provider = parsed.data.providerOverride ?? agent.provider;
    const configured =
      provider === "claude_max"
        ? Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
        : Boolean(process.env.OPENROUTER_API_KEY);
    const status =
      stop?.value === "true" || agent.paused || !configured
        ? "paused"
        : "queued";
    const [task] = await tx
      .insert(tasksTable)
      .values({
        agentId: agent.id,
        objective: parsed.data.objective,
        provider,
        status,
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      kind: "task.created",
      summary: configured
        ? `A task was queued for ${agent.name}.`
        : `A task for ${agent.name} was paused because ${provider} is not configured.`,
    });
    return { status: 201 as const, task, agentName: agent.name };
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
  res.status(201).json(
    CreateTaskResponse.parse({
      ...outcome.task,
      agentName: outcome.agentName,
      createdAt: outcome.task.createdAt.toISOString(),
    }),
  );
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
    await db
      .update(tasksTable)
      .set({ status: "paused" })
      .where(inArray(tasksTable.status, ["queued", "running"]));
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
  const claudeConfigured = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const openRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  res.json(
    GetProvidersResponse.parse([
      {
        provider: "claude_max",
        configured: claudeConfigured,
        healthy: claudeConfigured,
        message: claudeConfigured
          ? "Credential available; live health check pending."
          : "Add CLAUDE_CODE_OAUTH_TOKEN to enable execution.",
      },
      {
        provider: "openrouter",
        configured: openRouterConfigured,
        healthy: openRouterConfigured,
        message: openRouterConfigured
          ? "Credential available; live health check pending."
          : "Add OPENROUTER_API_KEY to enable execution.",
      },
    ]),
  );
});

export default router;
