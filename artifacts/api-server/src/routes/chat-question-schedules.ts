import {
  CreateChatQuestionScheduleBody,
  CreateChatQuestionScheduleResponse,
  DeleteChatQuestionScheduleParams,
  ListChatQuestionSchedulesResponse,
  UpdateChatQuestionScheduleBody,
  UpdateChatQuestionScheduleParams,
  UpdateChatQuestionScheduleResponse,
} from "@workspace/api-zod";
import {
  agentMessagesTable,
  agentsTable,
  chatQuestionSchedulesTable,
  db,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { recordAudit } from "../audit";
import { publish } from "../events";
import { computeNextRunAt, validateRecurrence, type RecurrenceSpec } from "../recurrence";

const router: IRouter = Router();

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

function toScheduleJson(
  schedule: typeof chatQuestionSchedulesTable.$inferSelect,
  agentName: string,
  latestReplyAt: Date | null,
) {
  return {
    id: schedule.id,
    name: schedule.name,
    agentId: schedule.agentId,
    agentName,
    question: schedule.question,
    cadence: schedule.cadence,
    timezone: schedule.timezone,
    runAt: schedule.runAt ? schedule.runAt.toISOString() : null,
    timeOfDay: schedule.timeOfDay,
    daysOfWeek: schedule.daysOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null,
    lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
    lastMessageId: schedule.lastMessageId,
    // A question is awaiting the owner's reply once it has been sent and
    // no owner-authored message has arrived for this agent since.
    awaitingResponse: Boolean(
      schedule.lastRunAt &&
        (!latestReplyAt || latestReplyAt.getTime() < schedule.lastRunAt.getTime()),
    ),
    createdAt: schedule.createdAt.toISOString(),
  };
}

/** Latest owner-authored message per agent, batched for one page of schedules. */
async function latestReplyByAgent(
  agentIds: string[],
): Promise<Map<string, Date>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({
      agentId: agentMessagesTable.toAgentId,
      latest: sql<Date>`max(${agentMessagesTable.createdAt})`,
    })
    .from(agentMessagesTable)
    .where(
      and(
        isNull(agentMessagesTable.fromAgentId),
        inArray(agentMessagesTable.toAgentId, agentIds),
      ),
    )
    .groupBy(agentMessagesTable.toAgentId);
  return new Map(
    rows
      .filter((row): row is { agentId: string; latest: Date } => row.agentId !== null)
      .map((row) => [row.agentId, new Date(row.latest)]),
  );
}

router.get("/chat-question-schedules", async (req, res): Promise<void> => {
  const rows = await db
    .select({ schedule: chatQuestionSchedulesTable, agentName: agentsTable.name })
    .from(chatQuestionSchedulesTable)
    .innerJoin(agentsTable, eq(chatQuestionSchedulesTable.agentId, agentsTable.id))
    .where(eq(chatQuestionSchedulesTable.workspaceId, req.workspaceId!))
    .orderBy(chatQuestionSchedulesTable.createdAt);
  const replies = await latestReplyByAgent([
    ...new Set(rows.map((row) => row.schedule.agentId)),
  ]);
  res.json(
    ListChatQuestionSchedulesResponse.parse(
      rows.map((row) =>
        toScheduleJson(
          row.schedule,
          row.agentName,
          replies.get(row.schedule.agentId) ?? null,
        ),
      ),
    ),
  );
});

router.post("/chat-question-schedules", async (req, res): Promise<void> => {
  const parsed = CreateChatQuestionScheduleBody.safeParse(req.body);
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
  if (agent.retired || agent.archived) {
    res
      .status(409)
      .json({ error: "This agent is retired or archived and cannot be scheduled" });
    return;
  }
  const now = new Date();
  const nextRunAt =
    parsed.data.cadence === "once"
      ? (parsed.data.runAt ?? null)
      : computeNextRunAt(spec, now);
  if (!nextRunAt) {
    res.status(400).json({ error: "The schedule has no upcoming occurrence" });
    return;
  }
  const [schedule] = await db
    .insert(chatQuestionSchedulesTable)
    .values({
      workspaceId: req.workspaceId!,
      name: parsed.data.name,
      agentId: parsed.data.agentId,
      question: parsed.data.question,
      cadence: parsed.data.cadence,
      timezone: parsed.data.timezone,
      runAt: parsed.data.runAt ?? null,
      timeOfDay: parsed.data.timeOfDay ?? null,
      daysOfWeek: parsed.data.daysOfWeek ?? null,
      dayOfMonth: parsed.data.dayOfMonth ?? null,
      nextRunAt,
    })
    .returning();
  await recordAudit(
    req.workspaceId!,
    "chat_question_schedule.created",
    `A ${schedule.cadence} chat question schedule "${schedule.name}" was created for ${agent.name}.`,
  );
  publish(req.workspaceId!, "chat-question-schedules");
  res
    .status(201)
    .json(
      CreateChatQuestionScheduleResponse.parse(
        toScheduleJson(schedule, agent.name, null),
      ),
    );
});

router.patch(
  "/chat-question-schedules/:scheduleId",
  async (req, res): Promise<void> => {
    const params = UpdateChatQuestionScheduleParams.safeParse(req.params);
    const body = UpdateChatQuestionScheduleBody.safeParse(req.body);
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
        | { ok: true; schedule: typeof chatQuestionSchedulesTable.$inferSelect }
        | { ok: false; status: number; error: string }
      > => {
        const [existing] = await tx
          .select()
          .from(chatQuestionSchedulesTable)
          .where(
            and(
              eq(chatQuestionSchedulesTable.id, params.data.scheduleId),
              eq(chatQuestionSchedulesTable.workspaceId, req.workspaceId!),
            ),
          )
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
          .update(chatQuestionSchedulesTable)
          .set({
            name: merged.name,
            question: merged.question,
            cadence: merged.cadence,
            timezone: merged.timezone,
            runAt: merged.runAt,
            timeOfDay: merged.timeOfDay,
            daysOfWeek: merged.daysOfWeek,
            dayOfMonth: merged.dayOfMonth,
            enabled,
            nextRunAt,
          })
          .where(eq(chatQuestionSchedulesTable.id, existing.id))
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
    publish(req.workspaceId!, "chat-question-schedules");
    const replies = await latestReplyByAgent([schedule.agentId]);
    res.json(
      UpdateChatQuestionScheduleResponse.parse(
        toScheduleJson(
          schedule,
          agent?.name ?? "Unknown",
          replies.get(schedule.agentId) ?? null,
        ),
      ),
    );
  },
);

router.delete(
  "/chat-question-schedules/:scheduleId",
  async (req, res): Promise<void> => {
    const params = DeleteChatQuestionScheduleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid schedule id" });
      return;
    }
    const [deleted] = await db
      .delete(chatQuestionSchedulesTable)
      .where(
        and(
          eq(chatQuestionSchedulesTable.id, params.data.scheduleId),
          eq(chatQuestionSchedulesTable.workspaceId, req.workspaceId!),
        ),
      )
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    await recordAudit(
      req.workspaceId!,
      "chat_question_schedule.deleted",
      `Chat question schedule "${deleted.name}" was deleted.`,
    );
    publish(req.workspaceId!, "chat-question-schedules");
    res.status(204).end();
  },
);

export default router;
