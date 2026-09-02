/**
 * Approved day-off lifecycle: chat-granted leave to Retirement Island,
 * office/island visibility, task safety while away, and the automatic
 * return sweep. Runs against the real dev Postgres like the other office
 * route suites.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  agentsTable,
  approvalsTable,
  db,
  pool,
  systemStateTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-leave-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

import officeRouter from "./office";
import { returnAgentsFromLeave } from "../leave";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Leave Test ${Date.now()}`;
const createdAgentIds: string[] = [];
const createdTaskIds: string[] = [];
let createdOwnerRow = false;
let wsId: string;

function agentInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: "Test Analyst",
    mission: "Run leave lifecycle checks and report back.",
    provider: "claude_max",
    securityPreset: "assistant",
    avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    ...extra,
  };
}

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/agents").send(agentInput(name, extra));
  if (res.status === 201) createdAgentIds.push(res.body.id);
  return res;
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
  wsId = ws!.id;
});

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.delete(tasksTable).where(inArray(tasksTable.id, createdTaskIds));
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(approvalsTable)
      .where(inArray(approvalsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
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

describe("approved day off", () => {
  it("grants leave from a clear chat authorization, hides the agent from the office, and shows it on the island", async () => {
    const created = await createAgent(`${RUN_TAG} Homer`);
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;

    // Inserted directly as "running" (bypassing routing) to isolate what
    // matters here: leave interrupts in-flight work regardless of why it
    // was running.
    const [insertedTask] = await db
      .insert(tasksTable)
      .values({
        workspaceId: wsId,
        agentId,
        objective: `${RUN_TAG} in-flight objective`,
        status: "running",
        provider: "claude_max",
      })
      .returning({ id: tasksTable.id });
    const taskId = insertedTask!.id;
    createdTaskIds.push(taskId);

    const converse = await request(app)
      .post(`/api/agents/${agentId}/converse`)
      .send({ text: "You can take the day off", history: [] });
    expect(converse.status).toBe(200);
    expect(converse.body.reply).toMatch(/retirement island/i);

    const [row] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    expect(row?.onLeaveUntil).toBeTruthy();
    expect(row?.paused).toBe(true);
    expect(row?.status).toBe("paused");
    expect(row?.retired).toBe(false);

    // The in-flight task is interrupted rather than left hanging.
    const [taskRow] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    expect(taskRow?.status).toBe("blocked");
    expect(taskRow?.errorKind).toBe("agent_on_leave");

    // Excluded from the normal office roster while away...
    const roster = await request(app).get("/api/agents");
    expect(roster.body.map((a: { id: string }) => a.id)).not.toContain(agentId);

    // ...and visible on the island instead.
    const island = await request(app).get("/api/island/leave");
    expect(island.status).toBe(200);
    const onIsland = island.body.find((a: { id: string }) => a.id === agentId);
    expect(onIsland).toBeTruthy();
    expect(onIsland.onLeaveUntil).toBe(row!.onLeaveUntil!.toISOString());

    // The permanent-retirement island listing is untouched.
    const retiredIsland = await request(app).get("/api/island/agents");
    expect(
      retiredIsland.body.map((a: { id: string }) => a.id),
    ).not.toContain(agentId);
  });

  it("does not re-grant leave when already away, and returns automatically once the window ends", async () => {
    const created = await createAgent(`${RUN_TAG} Marge`);
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;

    const first = await request(app)
      .post(`/api/agents/${agentId}/converse`)
      .send({ text: "Take the day off", history: [] });
    expect(first.status).toBe(200);
    const [afterFirst] = await db
      .select({ onLeaveUntil: agentsTable.onLeaveUntil })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    const firstReturnAt = afterFirst!.onLeaveUntil!.getTime();

    // A second grant mid-leave must not push the return time further out.
    const second = await request(app)
      .post(`/api/agents/${agentId}/converse`)
      .send({ text: "You can take the day off", history: [] });
    expect(second.status).toBe(200);
    expect(second.body.reply).toMatch(/already/i);
    const [afterSecond] = await db
      .select({ onLeaveUntil: agentsTable.onLeaveUntil })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    expect(afterSecond!.onLeaveUntil!.getTime()).toBe(firstReturnAt);

    // The sweep leaves it alone before the window ends...
    const tooEarly = await returnAgentsFromLeave(
      new Date(firstReturnAt - 60_000),
    );
    expect(tooEarly).toBe(0);
    const [stillAway] = await db
      .select({ onLeaveUntil: agentsTable.onLeaveUntil, status: agentsTable.status })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    expect(stillAway?.onLeaveUntil).toBeTruthy();

    // ...and brings it back once due.
    const swept = await returnAgentsFromLeave(new Date(firstReturnAt + 1000));
    expect(swept).toBeGreaterThanOrEqual(1);
    const [backHome] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    expect(backHome?.onLeaveUntil).toBeNull();
    expect(backHome?.paused).toBe(false);
    expect(backHome?.status).toBe("idle");

    const roster = await request(app).get("/api/agents");
    expect(roster.body.map((a: { id: string }) => a.id)).toContain(agentId);
    const island = await request(app).get("/api/island/leave");
    expect(island.body.map((a: { id: string }) => a.id)).not.toContain(agentId);
  });

  it("never grants leave from an unrelated or self-referential message", async () => {
    const created = await createAgent(`${RUN_TAG} Lisa`);
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;

    // No provider is configured in this workspace, so this may fail closed
    // with a routing error rather than 200 — what matters here is that no
    // leave was ever granted from a self-referential question.
    await request(app)
      .post(`/api/agents/${agentId}/converse`)
      .send({ text: "Can I take the day off?", history: [] });

    const [row] = await db
      .select({ onLeaveUntil: agentsTable.onLeaveUntil })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    expect(row?.onLeaveUntil).toBeNull();
  });
});
