import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  bugReportsTable,
  db,
  pool,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-bug-owner" as string,
  emails: {} as Record<string, string>,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const email = authState.emails[id];
        if (!email) throw new Error("no such user");
        return {
          primaryEmailAddress: {
            emailAddress: email,
            verification: { status: "verified" },
          },
        };
      },
    },
  },
}));

import officeRouter from "./office";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Bug Report Test ${Date.now()}`;
const OWNER = `hc-bug-owner-${Date.now()}`;
const STRANGER = `hc-bug-stranger-${Date.now()}`;
const OWNER_EMAIL = "owner@example.test";
const createdAgentIds: string[] = [];
const createdWorkspaceUserIds = [OWNER, STRANGER];

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = authState.userId;
  authState.userId = userId;
  try {
    return await fn();
  } finally {
    authState.userId = prev;
  }
}

beforeAll(() => {
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  authState.emails = {
    [OWNER]: OWNER_EMAIL,
    [STRANGER]: "stranger@example.test",
  };
});

afterAll(async () => {
  delete process.env.OWNER_EMAIL;
  if (createdAgentIds.length > 0) {
    await db
      .delete(bugReportsTable)
      .where(inArray(bugReportsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  await db
    .delete(workspacesTable)
    .where(inArray(workspacesTable.clerkUserId, createdWorkspaceUserIds));
  await pool.end();
});

let taskCounter = 0;

async function createTask(): Promise<{
  taskId: string;
  agentId: string;
  objective: string;
}> {
  const tag = `${RUN_TAG} ${++taskCounter}`;
  const objective = `${tag}: reproduce the bug`;
  return asUser(OWNER, async () => {
    const agent = await request(app)
      .post("/api/agents")
      .send({
        name: `${tag} Agent`,
        title: "Diagnostics",
        mission: "Exercise bug reporting.",
        provider: "openrouter",
        securityPreset: "assistant",
        avatar: {
          shellColor: "#C34428",
          deskStyle: "standard",
          accessory: "none",
        },
      });
    expect(agent.status).toBe(201);
    createdAgentIds.push(agent.body.id);
    await db
      .update(agentsTable)
      .set({ paused: true })
      .where(eq(agentsTable.id, agent.body.id));

    const task = await request(app).post("/api/tasks").send({
      agentId: agent.body.id,
      objective,
    });
    expect([201, 409, 423, 503]).toContain(task.status);
    if (task.status === 201) {
      return { taskId: task.body.id, agentId: agent.body.id, objective };
    }

    const [ws] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.clerkUserId, OWNER))
      .limit(1);
    const [row] = await db
      .insert(tasksTable)
      .values({
        agentId: agent.body.id,
        workspaceId: ws.id,
        objective,
        provider: "openrouter",
        status: "failed",
        errorKind: "provider_error",
        errorMessage: "boom",
      })
      .returning();
    return { taskId: row.id, agentId: agent.body.id, objective };
  });
}

describe("GET /me", () => {
  it("reports isOwner only for the account whose verified email matches OWNER_EMAIL", async () => {
    const owner = await asUser(OWNER, () => request(app).get("/api/me"));
    expect(owner.status).toBe(200);
    expect(owner.body.isOwner).toBe(true);

    const stranger = await asUser(STRANGER, () => request(app).get("/api/me"));
    expect(stranger.status).toBe(200);
    expect(stranger.body.isOwner).toBe(false);
  });
});

describe("bug reports", () => {
  it("refuses non-owners on both list and create", async () => {
    const { taskId } = await createTask();
    await asUser(STRANGER, async () => {
      const list = await request(app).get("/api/bug-reports");
      expect(list.status).toBe(403);
      const create = await request(app)
        .post("/api/bug-reports")
        .send({ taskId, description: "should be refused" });
      expect(create.status).toBe(403);
    });
  });

  it("lets the owner file a report and see it snapshot the task", async () => {
    const { taskId, agentId, objective } = await createTask();
    const created = await asUser(OWNER, () =>
      request(app)
        .post("/api/bug-reports")
        .send({ taskId, description: `${RUN_TAG} description` }),
    );
    expect(created.status).toBe(201);
    expect(created.body.taskId).toBe(taskId);
    expect(created.body.agentId).toBe(agentId);
    expect(created.body.description).toBe(`${RUN_TAG} description`);
    expect(created.body.context.taskObjective).toBe(objective);

    const list = await asUser(OWNER, () =>
      request(app).get("/api/bug-reports"),
    );
    expect(list.status).toBe(200);
    expect(
      (list.body.reports as { id: string }[]).some(
        (r) => r.id === created.body.id,
      ),
    ).toBe(true);
  });

  it("404s filing a report against an unknown or foreign task id", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const res = await asUser(OWNER, () =>
      request(app).post("/api/bug-reports").send({ taskId: missing }),
    );
    expect(res.status).toBe(404);
  });
});
