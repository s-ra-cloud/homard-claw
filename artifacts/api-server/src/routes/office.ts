import { getAuth } from "@clerk/express";
import {
  CreateAgentBody,
  CreateAgentResponse,
  CreateTaskBody,
  CreateTaskResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
  GetOfficeOverviewResponse,
  GetProvidersResponse,
  ListAgentsResponse,
  ListApprovalsResponse,
  ListTasksResponse,
  PauseAgentBody,
  PauseAgentParams,
  PauseAgentResponse,
  SetEmergencyStopBody,
  SetEmergencyStopResponse,
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
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    securityPreset: agent.securityPreset,
    avatar: agent.avatar,
    createdAt: agent.createdAt.toISOString(),
  };
}

router.get("/office/overview", async (_req, res): Promise<void> => {
  const [[agentCount], [activeCount], [approvalCount], [stop], events] =
    await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(agentsTable),
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
  const agents = await db.select().from(agentsTable).orderBy(agentsTable.name);
  res.json(ListAgentsResponse.parse(agents.map(toAgent)));
});

router.post("/agents", async (req, res): Promise<void> => {
  const parsed = CreateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const avatar = parsed.data.avatar ?? {
    shellColor: "#ef5b45",
    deskStyle: "oak",
    accessory: "notebook",
    expression: "focused",
  };
  const [agent] = await db
    .insert(agentsTable)
    .values({ ...parsed.data, avatar, status: "idle" })
    .returning();
  await db.insert(auditEventsTable).values({
    kind: "agent.created",
    summary: `${agent.name} joined the office as ${agent.title}.`,
  });
  res.status(201).json(CreateAgentResponse.parse(toAgent(agent)));
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
    .where(eq(agentsTable.id, params.data.agentId))
    .returning();
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  await db.insert(auditEventsTable).values({
    kind: body.data.paused ? "agent.paused" : "agent.resumed",
    summary: `${agent.name} was ${body.data.paused ? "paused" : "resumed"}.`,
  });
  res.json(PauseAgentResponse.parse(toAgent(agent)));
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
  const [[agent], [stop]] = await Promise.all([
    db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, parsed.data.agentId))
      .limit(1),
    db
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "emergency_stop"))
      .limit(1),
  ]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const provider = parsed.data.providerOverride ?? agent.provider;
  const configured =
    provider === "claude_max"
      ? Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
      : Boolean(process.env.OPENROUTER_API_KEY);
  const status =
    stop?.value === "true" || agent.paused || !configured ? "paused" : "queued";
  const [task] = await db
    .insert(tasksTable)
    .values({
      agentId: agent.id,
      objective: parsed.data.objective,
      provider,
      status,
    })
    .returning();
  await db.insert(auditEventsTable).values({
    kind: "task.created",
    summary: configured
      ? `A task was queued for ${agent.name}.`
      : `A task for ${agent.name} was paused because ${provider} is not configured.`,
  });
  res.status(201).json(
    CreateTaskResponse.parse({
      ...task,
      agentName: agent.name,
      createdAt: task.createdAt.toISOString(),
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
