import {
  AddTeamMemberBody,
  AddTeamMemberParams,
  AddTeamMemberResponse,
  CreateTeamBody,
  CreateTeamResponse,
  DelegateTaskBody,
  DelegateTaskParams,
  DelegateTaskResponse,
  DeleteTeamParams,
  GetTaskTreeParams,
  GetTaskTreeResponse,
  ListAgentMessagesQueryParams,
  ListAgentMessagesResponse,
  ListTeamsResponse,
  RemoveTeamMemberParams,
  RemoveTeamMemberResponse,
  UpdateTeamBody,
  UpdateTeamParams,
  UpdateTeamResponse,
} from "@workspace/api-zod";
import {
  agentMessagesTable,
  agentsTable,
  db,
  tasksTable,
  teamMembersTable,
  teamsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { recordAudit } from "../audit";
import { evaluateDelegation } from "../policy";
import { resolveRouting } from "../providers";

const router: IRouter = Router();

type TeamRow = typeof teamsTable.$inferSelect;
type AgentRow = typeof agentsTable.$inferSelect;

/** Only live work may spawn more work. */
const DELEGATABLE_STATUSES = ["queued", "running", "waiting_approval"];

/** Load teams with their members in two queries, newest first. */
async function loadTeams(workspaceId: string, teamId?: string) {
  const teams = await db
    .select()
    .from(teamsTable)
    .where(
      teamId
        ? and(eq(teamsTable.workspaceId, workspaceId), eq(teamsTable.id, teamId))
        : eq(teamsTable.workspaceId, workspaceId),
    )
    .orderBy(desc(teamsTable.createdAt));
  if (teams.length === 0) return [];

  const members = await db
    .select({
      teamId: teamMembersTable.teamId,
      agentId: agentsTable.id,
      name: agentsTable.name,
      title: agentsTable.title,
      avatar: agentsTable.avatar,
    })
    .from(teamMembersTable)
    .innerJoin(agentsTable, eq(teamMembersTable.agentId, agentsTable.id))
    .where(
      inArray(
        teamMembersTable.teamId,
        teams.map((team) => team.id),
      ),
    );

  const leadIds = teams
    .map((team) => team.leadAgentId)
    .filter((id): id is string => id !== null);
  const leads = leadIds.length
    ? await db
        .select({ id: agentsTable.id, name: agentsTable.name })
        .from(agentsTable)
        .where(inArray(agentsTable.id, leadIds))
    : [];
  const leadName = new Map(leads.map((lead) => [lead.id, lead.name]));

  return teams.map((team: TeamRow) => ({
    id: team.id,
    name: team.name,
    mission: team.mission,
    leadAgentId: team.leadAgentId,
    leadAgentName: team.leadAgentId
      ? (leadName.get(team.leadAgentId) ?? null)
      : null,
    members: members
      .filter((member) => member.teamId === team.id)
      .map((member) => ({
        agentId: member.agentId,
        name: member.name,
        title: member.title,
        isLead: member.agentId === team.leadAgentId,
        avatar: member.avatar,
      }))
      .sort((a, b) =>
        a.isLead === b.isLead ? a.name.localeCompare(b.name) : a.isLead ? -1 : 1,
      ),
    createdAt: team.createdAt.toISOString(),
  }));
}

async function nameTaken(
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(
      and(
        eq(teamsTable.workspaceId, workspaceId),
        sql`lower(${teamsTable.name}) = lower(${name})`,
      ),
    );
  return rows.some((row) => row.id !== excludeId);
}

router.get("/teams", async (req: Request, res: Response) => {
  res.json(ListTeamsResponse.parse(await loadTeams(req.workspaceId!)));
});

router.post("/teams", async (req: Request, res: Response) => {
  const wsId = req.workspaceId!;
  const body = CreateTeamBody.parse(req.body);
  if (await nameTaken(wsId, body.name)) {
    res.status(409).json({ error: "A team with that name already exists" });
    return;
  }

  const memberIds = Array.from(
    new Set([...(body.memberAgentIds ?? []), ...(body.leadAgentId ? [body.leadAgentId] : [])]),
  );
  if (memberIds.length > 0) {
    const found = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, wsId),
          inArray(agentsTable.id, memberIds),
        ),
      );
    if (found.length !== memberIds.length) {
      res.status(404).json({ error: "One of those agents does not exist" });
      return;
    }
  }

  const teamId = await db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teamsTable)
      .values({
        workspaceId: wsId,
        name: body.name,
        mission: body.mission ?? null,
        leadAgentId: body.leadAgentId ?? null,
      })
      .returning();
    if (memberIds.length > 0) {
      await tx
        .insert(teamMembersTable)
        .values(memberIds.map((agentId) => ({ teamId: team.id, agentId })));
    }
    await recordAudit(wsId, "team.created", `Team "${team.name}" was created.`, tx);
    return team.id;
  });

  const [team] = await loadTeams(wsId, teamId);
  res.status(201).json(CreateTeamResponse.parse(team));
});

router.patch("/teams/:teamId", async (req: Request, res: Response) => {
  const { teamId } = UpdateTeamParams.parse(req.params);
  const body = UpdateTeamBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(teamsTable)
    .where(
      and(
        eq(teamsTable.id, teamId),
        eq(teamsTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  if (body.name && (await nameTaken(req.workspaceId!, body.name, teamId))) {
    res.status(409).json({ error: "A team with that name already exists" });
    return;
  }
  // A lead must be on the team it leads, otherwise delegation
  // authorization would point outside the membership list.
  if (body.leadAgentId) {
    const [member] = await db
      .select({ agentId: teamMembersTable.agentId })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.teamId, teamId),
          eq(teamMembersTable.agentId, body.leadAgentId),
        ),
      )
      .limit(1);
    if (!member) {
      res
        .status(409)
        .json({ error: "Add that agent to the team before making it the lead" });
      return;
    }
  }

  await db
    .update(teamsTable)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.mission !== undefined ? { mission: body.mission } : {}),
      ...(body.leadAgentId !== undefined ? { leadAgentId: body.leadAgentId } : {}),
    })
    .where(eq(teamsTable.id, teamId));

  const [team] = await loadTeams(req.workspaceId!, teamId);
  res.json(UpdateTeamResponse.parse(team));
});

router.delete("/teams/:teamId", async (req: Request, res: Response) => {
  const { teamId } = DeleteTeamParams.parse(req.params);
  const [deleted] = await db
    .delete(teamsTable)
    .where(
      and(
        eq(teamsTable.id, teamId),
        eq(teamsTable.workspaceId, req.workspaceId!),
      ),
    )
    .returning({ name: teamsTable.name });
  if (!deleted) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  await recordAudit(
    req.workspaceId!,
    "team.deleted",
    `Team "${deleted.name}" was disbanded.`,
  );
  res.status(204).end();
});

router.post("/teams/:teamId/members", async (req: Request, res: Response) => {
  const { teamId } = AddTeamMemberParams.parse(req.params);
  const body = AddTeamMemberBody.parse(req.body);
  const wsId = req.workspaceId!;
  const [[team], [agent]] = await Promise.all([
    db
      .select()
      .from(teamsTable)
      .where(and(eq(teamsTable.id, teamId), eq(teamsTable.workspaceId, wsId)))
      .limit(1),
    db
      .select()
      .from(agentsTable)
      .where(
        and(eq(agentsTable.id, body.agentId), eq(agentsTable.workspaceId, wsId)),
      )
      .limit(1),
  ]);
  if (!team || !agent) {
    res.status(404).json({ error: "Team or agent not found" });
    return;
  }
  await db
    .insert(teamMembersTable)
    .values({ teamId, agentId: body.agentId })
    .onConflictDoNothing();
  await recordAudit(
    wsId,
    "team.member_added",
    `${agent.name} joined team "${team.name}".`,
  );
  const [updated] = await loadTeams(wsId, teamId);
  res.json(AddTeamMemberResponse.parse(updated));
});

router.delete(
  "/teams/:teamId/members/:agentId",
  async (req: Request, res: Response) => {
    const { teamId, agentId } = RemoveTeamMemberParams.parse(req.params);
    const [owned] = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(
        and(
          eq(teamsTable.id, teamId),
          eq(teamsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!owned) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const [removed] = await db
      .delete(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.teamId, teamId),
          eq(teamMembersTable.agentId, agentId),
        ),
      )
      .returning({ agentId: teamMembersTable.agentId });
    if (!removed) {
      res.status(404).json({ error: "That agent is not on this team" });
      return;
    }
    // A departing member cannot keep leading the team.
    await db
      .update(teamsTable)
      .set({ leadAgentId: null })
      .where(and(eq(teamsTable.id, teamId), eq(teamsTable.leadAgentId, agentId)));
    await recordAudit(
      req.workspaceId!,
      "team.member_removed",
      "An agent left a team.",
    );
    const [updated] = await loadTeams(req.workspaceId!, teamId);
    if (!updated) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json(RemoveTeamMemberResponse.parse(updated));
  },
);

router.post("/tasks/:taskId/delegate", async (req: Request, res: Response) => {
  const { taskId } = DelegateTaskParams.parse(req.params);
  const body = DelegateTaskBody.parse(req.body);

  // Authorization, the sub-task quota, and the insert all happen inside one
  // transaction with the parent task row locked. Without the lock two
  // concurrent hand-offs could each see spare capacity and both insert,
  // overshooting the lead's sub-task limit; the lock also freezes team
  // membership and lineage for the duration of the decision.
  const outcome = await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ task: tasksTable, agent: agentsTable })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1)
      .for("update", { of: tasksTable });
    if (!parent) return { status: 404 as const, error: "Task not found" };

    // Finished work is not a standing licence to queue more of it.
    if (!DELEGATABLE_STATUSES.includes(parent.task.status)) {
      return {
        status: 403 as const,
        error: `This task is ${parent.task.status.replace(/_/g, " ")}, so it cannot hand out new work.`,
      };
    }
    if (parent.agent.retired || parent.agent.archived) {
      return {
        status: 403 as const,
        error: `${parent.agent.name} no longer works here and cannot delegate.`,
      };
    }

    const decision = await evaluateDelegation({
      lead: parent.agent,
      targetAgentId: body.agentId,
      parentTask: parent.task,
      tx,
    });
    if (decision.kind === "deny") {
      return { status: 403 as const, error: decision.reason, lead: parent.agent };
    }

    const [target] = await tx
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, body.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!target) return { status: 404 as const, error: "Agent not found" };
    const routing = await resolveRouting(req.workspaceId!, target as AgentRow);

    const [child] = await tx
      .insert(tasksTable)
      .values({
        agentId: body.agentId,
        workspaceId: req.workspaceId!,
        objective: body.objective,
        priority: body.priority ?? parent.task.priority,
        budgetCents: body.budgetCents ?? null,
        provider: routing.provider,
        model: routing.model,
        parentTaskId: parent.task.id,
        rootTaskId: parent.task.rootTaskId ?? parent.task.id,
        depth: decision.depth,
        teamId: decision.teamId,
        delegatedByAgentId: parent.agent.id,
        runtime: parent.task.runtime,
        status: "queued",
      })
      .returning();
    await tx.insert(agentMessagesTable).values({
      fromAgentId: parent.agent.id,
      toAgentId: body.agentId,
      taskId: child.id,
      kind: "delegation",
      body:
        body.note?.trim() ||
        `Please handle this for me: ${body.objective.slice(0, 300)}`,
    });
    await recordAudit(
      req.workspaceId!,
      "task.delegated",
      `${parent.agent.name} delegated a sub-task to ${target?.name ?? "a teammate"}.`,
      tx,
    );
    return {
      status: 201 as const,
      child,
      targetName: target?.name ?? "",
      leadName: parent.agent.name,
    };
  });

  if (outcome.status !== 201) {
    if (outcome.status === 403) {
      await recordAudit(
        req.workspaceId!,
        "delegation.denied",
        `A delegation${outcome.lead ? ` from ${outcome.lead.name}` : ""} was refused: ${outcome.error}`,
      );
    }
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }

  res.status(201).json(
    DelegateTaskResponse.parse({
      ...outcome.child,
      agentName: outcome.targetName,
      teamName: null,
      delegatedByAgentName: outcome.leadName,
      startedAt: null,
      finishedAt: null,
      createdAt: outcome.child.createdAt.toISOString(),
    }),
  );
});

router.get("/tasks/:taskId/tree", async (req: Request, res: Response) => {
  const { taskId } = GetTaskTreeParams.parse(req.params);
  const [task] = await db
    .select({ id: tasksTable.id, rootTaskId: tasksTable.rootTaskId })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.id, taskId),
        eq(tasksTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const rootTaskId = task.rootTaskId ?? task.id;

  const delegator = sql`delegator`;
  const nodes = await db
    .select({
      id: tasksTable.id,
      parentTaskId: tasksTable.parentTaskId,
      agentId: tasksTable.agentId,
      agentName: agentsTable.name,
      objective: tasksTable.objective,
      status: tasksTable.status,
      depth: tasksTable.depth,
      delegatedByAgentName: sql<string | null>`${delegator}.name`,
      actualCostCents: tasksTable.actualCostCents,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
    .leftJoin(
      sql`${agentsTable} as delegator`,
      sql`${tasksTable.delegatedByAgentId} = ${delegator}.id`,
    )
    .where(
      and(
        eq(tasksTable.workspaceId, req.workspaceId!),
        or(eq(tasksTable.rootTaskId, rootTaskId), eq(tasksTable.id, rootTaskId)),
      ),
    )
    .orderBy(tasksTable.depth, tasksTable.createdAt);

  res.json(
    GetTaskTreeResponse.parse({
      rootTaskId,
      nodes: nodes.map((node) => ({
        ...node,
        createdAt: node.createdAt.toISOString(),
      })),
    }),
  );
});

router.get("/messages", async (req: Request, res: Response) => {
  const query = ListAgentMessagesQueryParams.parse(req.query);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const sender = sql`sender`;
  const recipient = sql`recipient`;

  const rows = await db
    .select({
      id: agentMessagesTable.id,
      fromAgentId: agentMessagesTable.fromAgentId,
      fromAgentName: sql<string | null>`${sender}.name`,
      toAgentId: agentMessagesTable.toAgentId,
      toAgentName: sql<string | null>`${recipient}.name`,
      taskId: agentMessagesTable.taskId,
      kind: agentMessagesTable.kind,
      body: agentMessagesTable.body,
      createdAt: agentMessagesTable.createdAt,
    })
    .from(agentMessagesTable)
    .leftJoin(
      sql`${agentsTable} as sender`,
      sql`${agentMessagesTable.fromAgentId} = ${sender}.id`,
    )
    .leftJoin(
      sql`${agentsTable} as recipient`,
      sql`${agentMessagesTable.toAgentId} = ${recipient}.id`,
    )
    .where(
      and(
        // Only messages between this workspace's agents are visible.
        sql`exists (select 1 from ${agentsTable} where ${agentsTable.id} = coalesce(${agentMessagesTable.fromAgentId}, ${agentMessagesTable.toAgentId}) and ${agentsTable.workspaceId} = ${req.workspaceId!})`,
        ...(query.taskId ? [eq(agentMessagesTable.taskId, query.taskId)] : []),
        ...(query.agentId
          ? [
              or(
                eq(agentMessagesTable.fromAgentId, query.agentId),
                eq(agentMessagesTable.toAgentId, query.agentId),
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(agentMessagesTable.createdAt))
    .limit(limit);

  res.json(
    ListAgentMessagesResponse.parse(
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    ),
  );
});

export default router;
