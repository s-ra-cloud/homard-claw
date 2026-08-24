import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  notificationsTable,
  pool,
  schedulesTable,
  systemStateTable,
  tasksTable,
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

import officeRouter from "./office";
import { runDueSchedules } from "../scheduler";

// Test-only scope: only touch our own schedules, and opt paused test
// agents back in (they are paused so the live dev worker ignores them).
function fireSchedules(...scheduleIds: string[]) {
  return runDueSchedules(new Date(), { scheduleIds, includePausedAgents: true });
}
import { notifyTaskEvent } from "../notifications";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Sched ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let wsId: string;

async function createAgent(name: string) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Roster Tester",
      mission: "Exercise durable schedules.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused: the live dev worker skips paused agents, so tasks these
  // schedules create can never be claimed and executed for real.
  await db
    .update(agentsTable)
    .set({ status: "paused" })
    .where(eq(agentsTable.id, res.body.id));
  return res.body as { id: string; name: string };
}

function scheduleBody(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${RUN_TAG} roster`,
    agentId,
    objective: `${RUN_TAG} scheduled objective`,
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
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
});

afterAll(async () => {
  await db.delete(notificationsTable).where(like(notificationsTable.body, `%${RUN_TAG}%`));
  if (createdAgentIds.length > 0) {
    await db
      .update(tasksTable)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(tasksTable.agentId, createdAgentIds),
          inArray(tasksTable.status, ["queued", "running", "blocked", "waiting_approval"]),
        ),
      );
    await db.delete(tasksTable).where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(schedulesTable).where(inArray(schedulesTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
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

describe("schedule CRUD", () => {
  it("creates, lists, updates, and deletes a schedule", async () => {
    const agent = await createAgent(`${RUN_TAG} CRUD`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id));
    expect(created.status).toBe(201);
    expect(created.body.enabled).toBe(true);
    expect(created.body.nextRunAt).toBeTruthy();
    expect(created.body.agentName).toBe(agent.name);

    const list = await request(app).get("/api/schedules");
    expect(list.status).toBe(200);
    expect(list.body.some((s: { id: string }) => s.id === created.body.id)).toBe(true);

    const paused = await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.enabled).toBe(false);

    const resumed = await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ enabled: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.enabled).toBe(true);
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const deleted = await request(app).delete(`/api/schedules/${created.body.id}`);
    expect(deleted.status).toBe(204);
    const listAfter = await request(app).get("/api/schedules");
    expect(listAfter.body.some((s: { id: string }) => s.id === created.body.id)).toBe(false);
  });

  it("rejects malformed recurrence and unknown timezones", async () => {
    const agent = await createAgent(`${RUN_TAG} Invalid`);
    const badTz = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id, { timezone: "Mars/Olympus_Mons" }));
    expect(badTz.status).toBe(400);
    const noDays = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id, { cadence: "weekly", daysOfWeek: [] }));
    expect(noDays.status).toBe(400);
    const onceNoDate = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id, { cadence: "once", timeOfDay: undefined }));
    expect(onceNoDate.status).toBe(400);
  });
});

describe("schedule firing", () => {
  it("fires a due one-time schedule exactly once and links the task", async () => {
    const agent = await createAgent(`${RUN_TAG} FireOnce`);
    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id, { cadence: "once", runAt: past, timeOfDay: undefined }));
    expect(created.status).toBe(201);

    const fired = await fireSchedules(created.body.id);
    expect(fired).toBeGreaterThanOrEqual(1);

    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(1);
    // The canonical dispatch path runs for scheduled tasks too: with a
    // configured provider the task queues; without one it is explicitly
    // blocked with an actionable reason — never silently dropped.
    if (tasks[0].status === "blocked") {
      expect(tasks[0].errorKind).toBe("not_configured");
    } else {
      expect(tasks[0].status).toBe("queued");
    }
    expect(tasks[0].objective).toContain(RUN_TAG);

    const [after] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, created.body.id));
    expect(after.enabled).toBe(false); // once → turned off after firing
    expect(after.lastTaskId).toBe(tasks[0].id);
    expect(after.nextRunAt).toBeNull();

    // A second pass must not duplicate the run.
    await fireSchedules(created.body.id);
    const tasksAfter = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasksAfter).toHaveLength(1);
  });

  it("advances a recurring schedule past 'now' after a missed run (single catch-up)", async () => {
    const agent = await createAgent(`${RUN_TAG} CatchUp`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id));
    // Simulate downtime: the next run was due 3 days ago.
    const staleDue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db
      .update(schedulesTable)
      .set({ nextRunAt: staleDue })
      .where(eq(schedulesTable.id, created.body.id));

    await fireSchedules(created.body.id);
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(1); // one catch-up run, not three
    const [after] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, created.body.id));
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("recovers a crash between claim and dispatch by refiring the occurrence", async () => {
    const agent = await createAgent(`${RUN_TAG} CrashRefire`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id));
    // Simulate a crash: the schedule was claimed 10 minutes ago, still due,
    // but no task row ever appeared.
    await db
      .update(schedulesTable)
      .set({
        nextRunAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
      })
      .where(eq(schedulesTable.id, created.body.id));

    await fireSchedules(created.body.id);
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(1); // the lost occurrence fired
    const [after] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, created.body.id));
    expect(after.claimedAt).toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("recovers a crash after dispatch by finalizing without a duplicate task", async () => {
    const agent = await createAgent(`${RUN_TAG} CrashFinalize`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id));
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .update(schedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 60_000), claimedAt: staleClaim })
      .where(eq(schedulesTable.id, created.body.id));
    // The crashed run DID create its task before dying.
    const [existingTask] = await db
      .insert(tasksTable)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        objective: `${RUN_TAG} survived the crash`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "queued",
        estimatedCostCents: 1,
        scheduleId: created.body.id,
      })
      .returning();

    await fireSchedules(created.body.id);
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(1); // no duplicate launch
    const [after] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, created.body.id));
    expect(after.claimedAt).toBeNull();
    expect(after.lastTaskId).toBe(existingTask.id);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("skips a schedule whose claim is fresh (dispatch in flight elsewhere)", async () => {
    const agent = await createAgent(`${RUN_TAG} FreshClaim`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id));
    await db
      .update(schedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 60_000), claimedAt: new Date() })
      .where(eq(schedulesTable.id, created.body.id));

    await fireSchedules(created.body.id);
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(0);
  });

  it("disables the schedule and notifies when its agent retires", async () => {
    const agent = await createAgent(`${RUN_TAG} Retiree`);
    const created = await request(app)
      .post("/api/schedules")
      .send(scheduleBody(agent.id, { name: `${RUN_TAG} retiree roster` }));
    await db
      .update(schedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schedulesTable.id, created.body.id));
    await db
      .update(agentsTable)
      .set({ retired: true, retiredAt: new Date() })
      .where(eq(agentsTable.id, agent.id));

    await fireSchedules(created.body.id);

    const [after] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, created.body.id));
    expect(after.enabled).toBe(false);
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.scheduleId, created.body.id));
    expect(tasks).toHaveLength(0);
    const alerts = await db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.kind, "schedule_error"),
          like(notificationsTable.body, `%${RUN_TAG} retiree roster%`),
        ),
      );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("notifications", () => {
  it("records task events, honors schedule notify prefs, and marks read", async () => {
    const agent = await createAgent(`${RUN_TAG} Notify`);
    // A schedule that opts out of completion notifications.
    const muted = await request(app)
      .post("/api/schedules")
      .send(
        scheduleBody(agent.id, {
          notify: { onCompleted: false, onFailed: true, onBlocked: true, onApprovalNeeded: true },
        }),
      );
    const [mutedTask] = await db
      .insert(tasksTable)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        objective: `${RUN_TAG} muted completion`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "completed",
        scheduleId: muted.body.id,
      })
      .returning();
    await notifyTaskEvent("task_completed", mutedTask);

    // An ad-hoc task always notifies.
    const [adhocTask] = await db
      .insert(tasksTable)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        objective: `${RUN_TAG} adhoc failure`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "failed",
      })
      .returning();
    await notifyTaskEvent("task_failed", adhocTask, "Provider exploded.");

    const list = await request(app).get("/api/notifications?limit=50");
    expect(list.status).toBe(200);
    const bodies = (list.body.notifications as { body: string; id: string; read: boolean }[]) ?? [];
    expect(bodies.some((n) => n.body.includes(`${RUN_TAG} adhoc failure`))).toBe(true);
    expect(bodies.some((n) => n.body.includes(`${RUN_TAG} muted completion`))).toBe(false);

    const mine = bodies.filter((n) => n.body.includes(RUN_TAG));
    expect(mine.every((n) => !n.read)).toBe(true);
    const marked = await request(app)
      .post("/api/notifications/read")
      .send({ ids: mine.map((n) => n.id) });
    expect(marked.status).toBe(200);
    expect(marked.body.updated).toBe(mine.length);

    const after = await request(app).get("/api/notifications?limit=50");
    const afterMine = (after.body.notifications as { body: string; read: boolean }[]).filter((n) =>
      n.body.includes(RUN_TAG),
    );
    expect(afterMine.every((n) => n.read)).toBe(true);
  });
});

describe("usage report", () => {
  it("returns real aggregates in the documented shape", async () => {
    const res = await request(app).get("/api/reports/usage");
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      todayCostCents: expect.any(Number),
      last7dCostCents: expect.any(Number),
      monthCostCents: expect.any(Number),
    });
    expect(res.body.outcomes).toHaveProperty("completed");
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(Array.isArray(res.body.blockers)).toBe(true);
  });
});
