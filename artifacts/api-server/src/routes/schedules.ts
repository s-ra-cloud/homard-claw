import {
  CreateScheduleBody,
  CreateScheduleResponse,
  DeleteScheduleParams,
  ListSchedulesResponse,
  UpdateScheduleBody,
  UpdateScheduleParams,
  UpdateScheduleResponse,
} from "@workspace/api-zod";
import {
  agentsTable,
  db,
  schedulesTable,
  tasksTable,
  type NotifyPrefs,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { recordAudit } from "../audit";
import { publish } from "../events";
import { computeNextRunAt, validateRecurrence, type RecurrenceSpec } from "../recurrence";

const router: IRouter = Router();

const DEFAULT_NOTIFY: NotifyPrefs = {
  onCompleted: true,
  onFailed: true,
  onBlocked: true,
  onApprovalNeeded: true,
};

function toScheduleJson(
  schedule: typeof schedulesTable.$inferSelect,
  agentName: string,
  lastTaskStatus: string | null,
) {
  return {
    id: schedule.id,
    name: schedule.name,
    agentId: schedule.agentId,
    agentName,
    objective: schedule.objective,
    priority: schedule.priority,
    providerOverride: schedule.providerOverride,
    modelOverride: schedule.modelOverride,
    budgetCents: schedule.budgetCents,
    cadence: schedule.cadence,
    timezone: schedule.timezone,
    runAt: schedule.runAt ? schedule.runAt.toISOString() : null,
    timeOfDay: schedule.timeOfDay,
    daysOfWeek: schedule.daysOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    notify: schedule.notify,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null,
    lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
    lastTaskId: schedule.lastTaskId,
    lastTaskStatus,
    createdAt: schedule.createdAt.toISOString(),
  };
}

function recurrenceSpec(row: {
  cadence: string;
  timezone: string;
  runAt?: Date | null;
  timeOfDay?: string | null;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
}): RecurrenceSpec {
  return {
    cadence: row.cadence as RecurrenceSpec["cadence"],
    timezone: row.timezone,
    runAt: row.runAt ?? null,
    timeOfDay: row.timeOfDay ?? null,
    daysOfWeek: row.daysOfWeek ?? null,
    dayOfMonth: row.dayOfMonth ?? null,
  };
}

router.get("/schedules", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ schedule: schedulesTable, agentName: agentsTable.name })
    .from(schedulesTable)
    .innerJoin(agentsTable, eq(schedulesTable.agentId, agentsTable.id))
    .orderBy(desc(schedulesTable.createdAt));
  const lastTaskIds = rows
    .map((row) => row.schedule.lastTaskId)
    .filter((id): id is string => id !== null);
  const statuses =
    lastTaskIds.length > 0
      ? await db
          .select({ id: tasksTable.id, status: tasksTable.status })
          .from(tasksTable)
          .where(inArray(tasksTable.id, lastTaskIds))
      : [];
  const statusById = new Map(statuses.map((row) => [row.id, row.status]));
  res.json(
    ListSchedulesResponse.parse(
      rows.map((row) =>
        toScheduleJson(
          row.schedule,
          row.agentName,
          row.schedule.lastTaskId
            ? (statusById.get(row.schedule.lastTaskId) ?? null)
            : null,
        ),
      ),
    ),
  );
});

router.post("/schedules", async (req, res): Promise<void> => {
  const parsed = CreateScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const spec = recurrenceSpec(parsed.data);
  const invalid = validateRecurrence(spec);
  if (invalid) {
    res.status(400).json({ error: invalid });
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
  if (agent.retired || agent.archived) {
    res
      .status(409)
      .json({ error: "This agent is retired or archived and cannot be scheduled" });
    return;
  }
  const now = new Date();
  // A one-time schedule may be created for an instant that is due right
  // away (nextRunAt = runAt, even in the past → fires on the next tick);
  // recurring schedules start at their next future occurrence.
  const nextRunAt =
    parsed.data.cadence === "once"
      ? (parsed.data.runAt ?? null)
      : computeNextRunAt(spec, now);
  if (!nextRunAt) {
    res.status(400).json({ error: "The schedule has no upcoming occurrence" });
    return;
  }
  const [schedule] = await db
    .insert(schedulesTable)
    .values({
      name: parsed.data.name,
      agentId: parsed.data.agentId,
      objective: parsed.data.objective,
      priority: parsed.data.priority ?? "normal",
      providerOverride: parsed.data.providerOverride ?? null,
      modelOverride: parsed.data.modelOverride ?? null,
      budgetCents: parsed.data.budgetCents ?? null,
      cadence: parsed.data.cadence,
      timezone: parsed.data.timezone,
      runAt: parsed.data.runAt ?? null,
      timeOfDay: parsed.data.timeOfDay ?? null,
      daysOfWeek: parsed.data.daysOfWeek ?? null,
      dayOfMonth: parsed.data.dayOfMonth ?? null,
      notify: parsed.data.notify ?? DEFAULT_NOTIFY,
      nextRunAt,
    })
    .returning();
  await recordAudit(
    "schedule.created",
    `A ${schedule.cadence} schedule "${schedule.name}" was created for ${agent.name}.`,
  );
  publish("schedules");
  res
    .status(201)
    .json(CreateScheduleResponse.parse(toScheduleJson(schedule, agent.name, null)));
});

router.patch("/schedules/:scheduleId", async (req, res): Promise<void> => {
  const params = UpdateScheduleParams.safeParse(req.params);
  const body = UpdateScheduleBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid schedule update" });
    return;
  }
  // Read-modify-write under the schedule's row lock so an edit can never
  // interleave with the worker's claim/finalize cycle and resurrect a
  // stale, already-fired nextRunAt.
  const result = await db.transaction(
    async (
      tx,
    ): Promise<
      | { ok: true; schedule: typeof schedulesTable.$inferSelect }
      | { ok: false; status: number; error: string }
    > => {
      const [existing] = await tx
        .select()
        .from(schedulesTable)
        .where(eq(schedulesTable.id, params.data.scheduleId))
        .limit(1)
        .for("update");
      if (!existing) {
        return { ok: false, status: 404, error: "Schedule not found" };
      }
      const merged = {
        ...existing,
        ...Object.fromEntries(
          Object.entries(body.data).filter(([, value]) => value !== undefined),
        ),
      } as typeof existing;
      const spec = recurrenceSpec(merged);
      const invalid = validateRecurrence(spec);
      if (invalid) {
        return { ok: false, status: 400, error: invalid };
      }
      const enabled = body.data.enabled ?? existing.enabled;
      // Recompute the next occurrence whenever timing fields change or the
      // schedule is re-enabled; a re-enabled `once` in the past has no
      // future occurrence and is rejected rather than silently staying off.
      const timingTouched =
        body.data.cadence !== undefined ||
        body.data.timezone !== undefined ||
        body.data.runAt !== undefined ||
        body.data.timeOfDay !== undefined ||
        body.data.daysOfWeek !== undefined ||
        body.data.dayOfMonth !== undefined ||
        (body.data.enabled === true && !existing.enabled);
      let nextRunAt = existing.nextRunAt;
      if (timingTouched && enabled) {
        nextRunAt =
          merged.cadence === "once"
            ? (merged.runAt ?? null)
            : computeNextRunAt(spec, new Date());
        if (!nextRunAt) {
          return { ok: false, status: 400, error: "The schedule has no upcoming occurrence" };
        }
      }
      const [schedule] = await tx
        .update(schedulesTable)
        .set({
          name: merged.name,
          objective: merged.objective,
          priority: merged.priority,
          providerOverride:
            body.data.providerOverride !== undefined
              ? body.data.providerOverride
              : existing.providerOverride,
          modelOverride:
            body.data.modelOverride !== undefined
              ? body.data.modelOverride
              : existing.modelOverride,
          budgetCents:
            body.data.budgetCents !== undefined
              ? body.data.budgetCents
              : existing.budgetCents,
          cadence: merged.cadence,
          timezone: merged.timezone,
          runAt: merged.runAt,
          timeOfDay: merged.timeOfDay,
          daysOfWeek: merged.daysOfWeek,
          dayOfMonth: merged.dayOfMonth,
          notify: body.data.notify ?? existing.notify,
          enabled,
          nextRunAt,
        })
        .where(eq(schedulesTable.id, existing.id))
        .returning();
      return { ok: true, schedule };
    },
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const schedule = result.schedule;
  const [agent] = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.id, schedule.agentId))
    .limit(1);
  publish("schedules");
  const lastTaskStatus = schedule.lastTaskId
    ? ((
        await db
          .select({ status: tasksTable.status })
          .from(tasksTable)
          .where(eq(tasksTable.id, schedule.lastTaskId))
          .limit(1)
      )[0]?.status ?? null)
    : null;
  res.json(
    UpdateScheduleResponse.parse(
      toScheduleJson(schedule, agent?.name ?? "Unknown", lastTaskStatus),
    ),
  );
});

router.delete("/schedules/:scheduleId", async (req, res): Promise<void> => {
  const params = DeleteScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid schedule id" });
    return;
  }
  const [deleted] = await db
    .delete(schedulesTable)
    .where(eq(schedulesTable.id, params.data.scheduleId))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  await recordAudit("schedule.deleted", `Schedule "${deleted.name}" was deleted.`);
  publish("schedules");
  res.status(204).end();
});

export default router;
