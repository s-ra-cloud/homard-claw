import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  agentMessagesTable,
  agentsTable,
  chatQuestionSchedulesTable,
  db,
  notificationsTable,
  pool,
  systemStateTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// No provider traffic may leave a test run.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);
const telegramPushMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../telegram/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telegram/service")>()),
  pushTelegramNotification: telegramPushMock,
}));

import officeRouter from "./office";
import { runDueChatQuestionSchedules } from "../chat-question-scheduler";

// Test-only scope: only touch our own schedules, and opt paused test
// agents back in (they are paused so the live dev worker ignores them).
function fireChatQuestionSchedules(...scheduleIds: string[]) {
  return runDueChatQuestionSchedules(new Date(), {
    scheduleIds,
    includePausedAgents: true,
  });
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC ChatQ ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let wsId: string;

async function createAgent(name: string) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Chat Question Tester",
      mission: "Exercise durable chat question schedules.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused: the live dev worker skips paused agents, so these schedules can
  // never be claimed and fired for real outside our explicit test calls.
  await db
    .update(agentsTable)
    .set({ status: "paused" })
    .where(eq(agentsTable.id, res.body.id));
  return res.body as { id: string; name: string };
}

function scheduleBody(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${RUN_TAG} checkin`,
    agentId,
    question: `${RUN_TAG} how did the launch go?`,
    cadence: "daily",
    timezone: "Europe/Paris",
    timeOfDay: "09:00",
    ...extra,
  };
}

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) {
    authState.userId = owner.value;
  } else {
    createdOwnerRow = true;
  }
  const boot = await request(app).get("/api/agents");
  expect(boot.status).toBe(200);
  const [ws] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, authState.userId))
    .limit(1);
  wsId = ws.id;
});

beforeEach(() => {
  fetchMock.mockReset();
  telegramPushMock.mockClear();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
});

afterAll(async () => {
  await db
    .delete(notificationsTable)
    .where(like(notificationsTable.body, `%${RUN_TAG}%`));
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentMessagesTable)
      .where(
        inArray(agentMessagesTable.fromAgentId, createdAgentIds),
      );
    await db
      .delete(agentMessagesTable)
      .where(inArray(agentMessagesTable.toAgentId, createdAgentIds));
    await db
      .delete(chatQuestionSchedulesTable)
      .where(inArray(chatQuestionSchedulesTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  if (createdOwnerRow) {
    await db
      .delete(systemStateTable)
      .where(
        and(
          eq(systemStateTable.key, "owner_clerk_id"),
          eq(systemStateTable.value, authState.userId),
        ),
      );
  }
  await pool.end();
});

describe("chat question schedule CRUD", () => {
  it("creates, lists, updates, and deletes a chat question schedule", async () => {
    const agent = await createAgent(`${RUN_TAG} CRUD`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id));
    expect(created.status).toBe(201);
    expect(created.body.enabled).toBe(true);
    expect(created.body.nextRunAt).toBeTruthy();
    expect(created.body.agentName).toBe(agent.name);
    expect(created.body.awaitingResponse).toBe(false);

    const list = await request(app).get("/api/chat-question-schedules");
    expect(list.status).toBe(200);
    expect(
      list.body.some((s: { id: string }) => s.id === created.body.id),
    ).toBe(true);

    const paused = await request(app)
      .patch(`/api/chat-question-schedules/${created.body.id}`)
      .send({ enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.enabled).toBe(false);

    const resumed = await request(app)
      .patch(`/api/chat-question-schedules/${created.body.id}`)
      .send({ enabled: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.enabled).toBe(true);
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const edited = await request(app)
      .patch(`/api/chat-question-schedules/${created.body.id}`)
      .send({
        name: `${RUN_TAG} checkin renamed`,
        question: `${RUN_TAG} revised question?`,
        cadence: "weekly",
        timeOfDay: "14:30",
        daysOfWeek: [2, 4],
      });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      name: `${RUN_TAG} checkin renamed`,
      question: `${RUN_TAG} revised question?`,
      cadence: "weekly",
      timeOfDay: "14:30",
      daysOfWeek: [2, 4],
    });
    expect(new Date(edited.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const deleted = await request(app).delete(
      `/api/chat-question-schedules/${created.body.id}`,
    );
    expect(deleted.status).toBe(204);
    const listAfter = await request(app).get("/api/chat-question-schedules");
    expect(
      listAfter.body.some((s: { id: string }) => s.id === created.body.id),
    ).toBe(false);
  });

  it("rejects malformed recurrence and unknown timezones", async () => {
    const agent = await createAgent(`${RUN_TAG} Invalid`);
    const badTz = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id, { timezone: "Mars/Olympus_Mons" }));
    expect(badTz.status).toBe(400);
    const noDays = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id, { cadence: "weekly", daysOfWeek: [] }));
    expect(noDays.status).toBe(400);
    const onceNoDate = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id, { cadence: "once", timeOfDay: undefined }));
    expect(onceNoDate.status).toBe(400);
  });
});

describe("chat question schedule firing", () => {
  it("sends a due one-time question into Talk, marks it awaiting, and turns off", async () => {
    const agent = await createAgent(`${RUN_TAG} FireOnce`);
    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(
        scheduleBody(agent.id, {
          cadence: "once",
          runAt: past,
          timeOfDay: undefined,
        }),
      );
    expect(created.status).toBe(201);

    const fired = await fireChatQuestionSchedules(created.body.id);
    expect(fired).toBeGreaterThanOrEqual(1);

    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(1);
    expect(messages[0].fromAgentId).toBe(agent.id);
    expect(messages[0].kind).toBe("chat_question");
    expect(messages[0].body).toContain(RUN_TAG);
    expect(telegramPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsId, kind: "chat_question" }),
    );

    // The question shows up in the owner-facing Talk transcript...
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.status).toBe(200);
    expect(
      history.body.turns.some(
        (t: { role: string; text: string }) =>
          t.role === "agent" && t.text.includes(RUN_TAG),
      ),
    ).toBe(true);

    const [after] = await db
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    expect(after.enabled).toBe(false); // once → turned off after firing
    expect(after.lastMessageId).toBe(messages[0].id);
    expect(after.nextRunAt).toBeNull();

    // ...and stays "awaiting" until the owner replies.
    const list = await request(app).get("/api/chat-question-schedules");
    const listed = list.body.find(
      (s: { id: string }) => s.id === created.body.id,
    );
    expect(listed.awaitingResponse).toBe(true);

    await db.insert(agentMessagesTable).values({
      fromAgentId: null,
      toAgentId: agent.id,
      kind: "voice",
      body: `${RUN_TAG} it went great`,
    });
    const listAfterReply = await request(app).get(
      "/api/chat-question-schedules",
    );
    const listedAfterReply = listAfterReply.body.find(
      (s: { id: string }) => s.id === created.body.id,
    );
    expect(listedAfterReply.awaitingResponse).toBe(false);

    // A second pass must not duplicate the send.
    await fireChatQuestionSchedules(created.body.id);
    const messagesAfter = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messagesAfter).toHaveLength(1);
  });

  it("advances a recurring schedule past 'now' after a missed run (single catch-up)", async () => {
    const agent = await createAgent(`${RUN_TAG} CatchUp`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id));
    const staleDue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db
      .update(chatQuestionSchedulesTable)
      .set({ nextRunAt: staleDue })
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));

    await fireChatQuestionSchedules(created.body.id);
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(1); // one catch-up send, not three
    const [after] = await db
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("recovers a crash between claim and dispatch by resending the occurrence", async () => {
    const agent = await createAgent(`${RUN_TAG} CrashResend`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id));
    await db
      .update(chatQuestionSchedulesTable)
      .set({
        nextRunAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
      })
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));

    await fireChatQuestionSchedules(created.body.id);
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(1); // the lost occurrence sent
    const [after] = await db
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    expect(after.claimedAt).toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("recovers a crash after dispatch by finalizing without a duplicate message", async () => {
    const agent = await createAgent(`${RUN_TAG} CrashFinalize`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id));
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .update(chatQuestionSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 60_000), claimedAt: staleClaim })
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    // The crashed run DID send its message before dying.
    const [existingMessage] = await db
      .insert(agentMessagesTable)
      .values({
        fromAgentId: agent.id,
        toAgentId: null,
        kind: "chat_question",
        body: `${RUN_TAG} survived the crash`,
        chatQuestionScheduleId: created.body.id,
      })
      .returning();

    await fireChatQuestionSchedules(created.body.id);
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(1); // no duplicate send
    const [after] = await db
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    expect(after.claimedAt).toBeNull();
    expect(after.lastMessageId).toBe(existingMessage.id);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("skips a schedule whose claim is fresh (send in flight elsewhere)", async () => {
    const agent = await createAgent(`${RUN_TAG} FreshClaim`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(scheduleBody(agent.id));
    await db
      .update(chatQuestionSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 60_000), claimedAt: new Date() })
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));

    await fireChatQuestionSchedules(created.body.id);
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(0);
  });

  it("disables the schedule and notifies when its agent retires", async () => {
    const agent = await createAgent(`${RUN_TAG} Retiree`);
    const created = await request(app)
      .post("/api/chat-question-schedules")
      .send(
        scheduleBody(agent.id, { name: `${RUN_TAG} retiree checkin` }),
      );
    await db
      .update(chatQuestionSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    await db
      .update(agentsTable)
      .set({ retired: true, retiredAt: new Date() })
      .where(eq(agentsTable.id, agent.id));

    await fireChatQuestionSchedules(created.body.id);

    const [after] = await db
      .select()
      .from(chatQuestionSchedulesTable)
      .where(eq(chatQuestionSchedulesTable.id, created.body.id));
    expect(after.enabled).toBe(false);
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(
        eq(agentMessagesTable.chatQuestionScheduleId, created.body.id),
      );
    expect(messages).toHaveLength(0);
    const alerts = await db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.kind, "schedule_error"),
          like(notificationsTable.body, `%${RUN_TAG} retiree checkin%`),
        ),
      );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});
