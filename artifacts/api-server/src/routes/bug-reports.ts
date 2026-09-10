import {
  CreateBugReportBody,
  CreateBugReportResponse,
  ListBugReportsResponse,
} from "@workspace/api-zod";
import { agentsTable, bugReportsTable, db, tasksTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { requireOwner } from "../workspace";

const router: IRouter = Router();

router.get("/bug-reports", requireOwner, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(bugReportsTable)
    .orderBy(desc(bugReportsTable.createdAt))
    .limit(200);
  res.json(
    ListBugReportsResponse.parse({
      reports: rows.map((row) => ({
        id: row.id,
        description: row.description,
        taskId: row.taskId,
        agentId: row.agentId,
        context: row.context ?? {},
        createdAt: row.createdAt.toISOString(),
      })),
    }),
  );
});

router.post("/bug-reports", requireOwner, async (req, res): Promise<void> => {
  const parsed = CreateBugReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.taskId) {
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.id, parsed.data.taskId),
          eq(tasksTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const [agent] = task.agentId
      ? await db
          .select({ name: agentsTable.name })
          .from(agentsTable)
          .where(eq(agentsTable.id, task.agentId))
          .limit(1)
      : [undefined];

    const [row] = await db
      .insert(bugReportsTable)
      .values({
        workspaceId: req.workspaceId!,
        taskId: task.id,
        agentId: task.agentId,
        reporterClerkUserId: req.workspaceUserId!,
        description: parsed.data.description ?? "",
        context: {
          taskObjective: task.objective,
          taskStatus: task.status,
          provider: task.provider,
          model: task.model,
          errorKind: task.errorKind,
          errorMessage: task.errorMessage,
          agentName: agent?.name ?? null,
        },
      })
      .returning();

    res.status(201).json(
      CreateBugReportResponse.parse({
        id: row.id,
        description: row.description,
        taskId: row.taskId,
        agentId: row.agentId,
        context: row.context ?? {},
        createdAt: row.createdAt.toISOString(),
      }),
    );
    return;
  }

  if (!parsed.data.agentId) {
    res.status(400).json({ error: "Either taskId or agentId is required" });
    return;
  }

  const [agent] = await db
    .select({ name: agentsTable.name })
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

  const [row] = await db
    .insert(bugReportsTable)
    .values({
      workspaceId: req.workspaceId!,
      taskId: null,
      agentId: parsed.data.agentId,
      reporterClerkUserId: req.workspaceUserId!,
      description: parsed.data.description ?? "",
      context: {
        agentName: agent.name,
        talkMessages: parsed.data.talkMessages ?? [],
      },
    })
    .returning();

  res.status(201).json(
    CreateBugReportResponse.parse({
      id: row.id,
      description: row.description,
      taskId: row.taskId,
      agentId: row.agentId,
      context: row.context ?? {},
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

export default router;
