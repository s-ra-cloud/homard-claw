/**
 * Shared approval preferences: the "always approve everything" switch (one
 * setting driven from both the task board and the approval board) and the
 * owner-configurable failed-task retry limit, capped at 3.
 */
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
  agentsTable,
  approvalsTable,
  db,
  pool,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-approval-prefs-owner" }));
let wsId = "";

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { claimNextTask, runTask } from "../worker";
import { saveProviderCredential } from "../provider-credentials";
import { clearProviderCaches } from "../providers";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Approval Prefs ${Date.now()}`;
const createdAgentIds: string[] = [];

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Preferences Tester",
      mission: "Exercise the shared approval preferences.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
      ...extra,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  await request(app)
    .post(`/api/agents/${res.body.id}/pause`)
    .send({ paused: true });
  return res.body as { id: string; name: string };
}

const scopeFor = (agentId: string) => ({
  agentIds: [agentId],
  includePausedAgents: true,
});

async function insertTask(
  agentId: string,
  overrides: Partial<typeof tasksTable.$inferInsert> = {},
) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      workspaceId: wsId,
      agentId,
      objective: `${RUN_TAG} scripted objective`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "queued",
      ...overrides,
    })
    .returning();
  return task!;
}

async function getTaskRow(id: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return task!;
}

async function getApprovalForTask(taskId: string) {
  const [approval] = await db
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.taskId, taskId))
    .limit(1);
  return approval;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Priced OpenRouter catalog plus a successful completion. */
function mockOpenRouterSuccess() {
  fetchMock.mockImplementation(async (url: unknown) => {
    if (String(url).includes("/models")) {
      return jsonResponse({
        data: [
          {
            id: "test-vendor/test-model",
            name: "Test Model",
            context_length: 8192,
            pricing: { prompt: "0.000001", completion: "0.00001" },
          },
        ],
      });
    }
    return jsonResponse({
      choices: [{ message: { content: "Done." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
}

beforeAll(async () => {
  const [ws] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `hc-approval-prefs-${Date.now()}` })
    .returning({
      id: workspacesTable.id,
      clerkUserId: workspacesTable.clerkUserId,
    });
  wsId = ws.id;
  authState.userId = ws.clerkUserId;
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  await saveProviderCredential(wsId, "openrouter", "test-openrouter-key");
  clearProviderCaches();
  // Each test starts from the documented defaults.
  await request(app).put("/api/approvals/settings").send({
    reviewerAgentId: null,
    alwaysApproveEverything: false,
    failedTaskRetryLimit: 3,
  });
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(approvalsTable)
      .where(inArray(approvalsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsId));
  await pool.end();
});

describe("approval preferences defaults and validation", () => {
  it("defaults to manual review, always-approve off, and a 3-attempt retry limit", async () => {
    const get = await request(app).get("/api/approvals/settings");
    expect(get.status).toBe(200);
    expect(get.body.reviewerAgentId).toBeNull();
    expect(get.body.alwaysApproveEverything).toBe(false);
    expect(get.body.failedTaskRetryLimit).toBe(3);
  });

  it("rejects a retry limit outside the 1-3 range", async () => {
    const tooHigh = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, failedTaskRetryLimit: 4 });
    expect(tooHigh.status).toBe(400);

    const tooLow = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, failedTaskRetryLimit: 0 });
    expect(tooLow.status).toBe(400);

    // Rejected writes must not have taken effect.
    const get = await request(app).get("/api/approvals/settings");
    expect(get.body.failedTaskRetryLimit).toBe(3);
  });

  it("treats the two preferences as independent partial updates", async () => {
    const onlySwitch = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, alwaysApproveEverything: true });
    expect(onlySwitch.status).toBe(200);
    expect(onlySwitch.body.alwaysApproveEverything).toBe(true);
    // Omitted field is untouched, not reset to a default.
    expect(onlySwitch.body.failedTaskRetryLimit).toBe(3);

    const onlyLimit = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, failedTaskRetryLimit: 2 });
    expect(onlyLimit.status).toBe(200);
    expect(onlyLimit.body.failedTaskRetryLimit).toBe(2);
    // The switch set moments ago by the "other board" is still on.
    expect(onlyLimit.body.alwaysApproveEverything).toBe(true);
  });
});

describe("always approve everything", () => {
  it("is one shared preference immediately visible on a fresh read after either board changes it", async () => {
    const before = await request(app).get("/api/approvals/settings");
    expect(before.body.alwaysApproveEverything).toBe(false);

    // Simulates the task board flipping the switch.
    const flipped = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, alwaysApproveEverything: true });
    expect(flipped.status).toBe(200);

    // Simulates the approval board's independent read picking up the change.
    const after = await request(app).get("/api/approvals/settings");
    expect(after.body.alwaysApproveEverything).toBe(true);
  });

  it("auto-approves a task's initial policy gate with no approval left pending", async () => {
    await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, alwaysApproveEverything: true });

    const agent = await createAgent(`${RUN_TAG} Always Approve`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, { estimatedCostCents: 1 });
    const claimed = await claimNextTask(scopeFor(agent.id));
    expect(claimed).not.toBeNull();
    await runTask(claimed!);

    // Requeued straight past the approval desk, not left waiting.
    const row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("queued");
    const approval = await getApprovalForTask(row.id);
    expect(approval?.status).toBe("approved");

    mockOpenRouterSuccess();
    const reclaimed = await claimNextTask(scopeFor(agent.id));
    expect(reclaimed?.task.id).toBe(row.id);
    await runTask(reclaimed!);
    expect((await getTaskRow(row.id)).status).toBe("completed");
  });

  it("leaves a task pending for the owner when the switch is off", async () => {
    const agent = await createAgent(`${RUN_TAG} Manual Review`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, { estimatedCostCents: 1 });
    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);

    const row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("waiting_approval");
    const approval = await getApprovalForTask(row.id);
    expect(approval?.status).toBe("pending");
  });
});

describe("failed-task retry limit", () => {
  it("caps automatic attempts at the configured workspace limit", async () => {
    const settings = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, failedTaskRetryLimit: 1 });
    expect(settings.body.failedTaskRetryLimit).toBe(1);

    const agent = await createAgent(`${RUN_TAG} Retry Capped`);
    // Simulates a task that already used its one allowed attempt.
    const task = await insertTask(agent.id, {
      attempts: 1,
      estimatedCostCents: 1,
    });
    const claimed = await claimNextTask(scopeFor(agent.id));
    expect(claimed?.task.attempts).toBe(2);
    await runTask(claimed!);

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("policy");
    expect(row.errorMessage).toContain("1 attempt");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never exceeds the hard ceiling of 3 even if asked", async () => {
    const rejected = await request(app)
      .put("/api/approvals/settings")
      .send({ reviewerAgentId: null, failedTaskRetryLimit: 3.5 });
    expect(rejected.status).toBe(400);
  });
});
