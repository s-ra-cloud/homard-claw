import { GetUsageReportResponse } from "@workspace/api-zod";
import { agentsTable, db, tasksTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

/**
 * Real operational reporting, aggregated straight from the tasks table —
 * cost/token sums come from recorded actuals (actualCostCents et al.),
 * never estimates, so an unpriced model contributes zero cost while its
 * token counts still show.
 */
router.get("/reports/usage", async (req, res): Promise<void> => {
  const ws = eq(tasksTable.workspaceId, req.workspaceId!);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const cost = sql<number>`coalesce(sum(${tasksTable.actualCostCents}), 0)::float`;
  const inputTokens = sql<number>`coalesce(sum(${tasksTable.actualInputTokens}), 0)::int`;
  const outputTokens = sql<number>`coalesce(sum(${tasksTable.actualOutputTokens}), 0)::int`;

  const [
    [today],
    [week],
    [month],
    outcomeRows,
    agentRows,
    agentUsageRows,
    providerRows,
    blockerRows,
  ] = await Promise.all([
    db.select({ cost }).from(tasksTable).where(and(ws, gte(tasksTable.createdAt, dayAgo))),
    db.select({ cost }).from(tasksTable).where(and(ws, gte(tasksTable.createdAt, weekAgo))),
    db
      .select({ cost, inputTokens, outputTokens })
      .from(tasksTable)
      .where(and(ws, gte(tasksTable.createdAt, monthStart))),
    db
      .select({ status: tasksTable.status, count: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(ws, gte(tasksTable.createdAt, thirtyDaysAgo)))
      .groupBy(tasksTable.status),
    db
      .select({ id: agentsTable.id, name: agentsTable.name, status: agentsTable.status })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, req.workspaceId!),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, false),
        ),
      )
      .orderBy(agentsTable.name),
    db
      .select({
        agentId: tasksTable.agentId,
        completed: sql<number>`count(*) filter (where ${tasksTable.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${tasksTable.status} = 'failed')::int`,
        inputTokens,
        outputTokens,
        cost,
      })
      .from(tasksTable)
      .where(and(ws, gte(tasksTable.createdAt, thirtyDaysAgo)))
      .groupBy(tasksTable.agentId),
    db
      .select({
        provider: tasksTable.provider,
        tasks: sql<number>`count(*)::int`,
        inputTokens,
        outputTokens,
        cost,
      })
      .from(tasksTable)
      .where(and(ws, gte(tasksTable.createdAt, thirtyDaysAgo)))
      .groupBy(tasksTable.provider),
    db
      .select({
        taskId: tasksTable.id,
        agentName: agentsTable.name,
        objective: tasksTable.objective,
        errorKind: tasksTable.errorKind,
        errorMessage: tasksTable.errorMessage,
        createdAt: tasksTable.createdAt,
      })
      .from(tasksTable)
      .innerJoin(agentsTable, eq(tasksTable.agentId, agentsTable.id))
      .where(and(ws, inArray(tasksTable.status, ["blocked", "waiting_approval"])))
      .orderBy(desc(tasksTable.createdAt))
      .limit(20),
  ]);

  const outcomeByStatus = new Map(outcomeRows.map((row) => [row.status, row.count]));
  const usageByAgent = new Map(agentUsageRows.map((row) => [row.agentId, row]));

  res.json(
    GetUsageReportResponse.parse({
      totals: {
        todayCostCents: today?.cost ?? 0,
        last7dCostCents: week?.cost ?? 0,
        monthCostCents: month?.cost ?? 0,
        monthInputTokens: month?.inputTokens ?? 0,
        monthOutputTokens: month?.outputTokens ?? 0,
      },
      outcomes: {
        completed: outcomeByStatus.get("completed") ?? 0,
        failed: outcomeByStatus.get("failed") ?? 0,
        blocked: outcomeByStatus.get("blocked") ?? 0,
        cancelled: outcomeByStatus.get("cancelled") ?? 0,
        queued: outcomeByStatus.get("queued") ?? 0,
        running: outcomeByStatus.get("running") ?? 0,
        waitingApproval: outcomeByStatus.get("waiting_approval") ?? 0,
      },
      agents: agentRows.map((agent) => {
        const usage = usageByAgent.get(agent.id);
        return {
          agentId: agent.id,
          name: agent.name,
          status: agent.status,
          tasksCompleted: usage?.completed ?? 0,
          tasksFailed: usage?.failed ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costCents: usage?.cost ?? 0,
        };
      }),
      providers: providerRows.map((row) => ({
        provider: row.provider,
        tasks: row.tasks,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costCents: row.cost,
      })),
      blockers: blockerRows.map((row) => ({
        taskId: row.taskId,
        agentName: row.agentName,
        objective: row.objective,
        errorKind: row.errorKind,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt.toISOString(),
      })),
    }),
  );
});

export default router;
