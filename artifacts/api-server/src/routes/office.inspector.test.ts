/**
 * Completed-work inspector: selecting the inspector Crustabot, the bounded
 * corrective-retry cap, and one full inspection cycle over a completed task
 * (pass / needs-fix / cannot-verify) with a corrective retry linked to the
 * original task and assigned to the original Crustabot.
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
  db,
  pool,
  taskInspectionsTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-inspector-owner" }));
let wsId = "";

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import {
  inspectCompletedTasks,
  queueInspectionIfConfigured,
} from "../task-inspector";
import { saveProviderCredential } from "../provider-credentials";
import { clearProviderCaches } from "../providers";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Inspector ${Date.now()}`;
const createdAgentIds: string[] = [];

async function createAgent(
  name: string,
  { pause = true }: { pause?: boolean } = {},
) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Inspection Tester",
      mission: "Exercise the completed-work inspector.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  if (pause) {
    await request(app)
      .post(`/api/agents/${res.body.id}/pause`)
      .send({ paused: true });
  }
  return res.body as { id: string; name: string };
}

async function insertCompletedTask(
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
      status: "completed",
      output: "Here is the finished work.",
      inspectionStatus: "queued",
      finishedAt: new Date(),
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

async function inspectionsFor(taskId: string) {
  return db
    .select()
    .from(taskInspectionsTable)
    .where(eq(taskInspectionsTable.taskId, taskId));
}

async function correctionsOf(taskId: string) {
  return db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.correctionOfTaskId, taskId));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Priced OpenRouter catalog plus a fixed inspector verdict on completions. */
function mockInspectorVerdict(verdict: unknown) {
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
      choices: [{ message: { content: JSON.stringify(verdict) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
}

beforeAll(async () => {
  const [ws] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `hc-inspector-${Date.now()}` })
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
  // Start from the documented default: no inspector configured.
  await request(app)
    .put("/api/inspector/settings")
    .send({ inspectorAgentId: null });
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(taskInspectionsTable)
      .where(inArray(taskInspectionsTable.inspectorAgentId, createdAgentIds));
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

describe("inspector settings", () => {
  it("defaults to no inspector and a retry cap of 1", async () => {
    const get = await request(app).get("/api/inspector/settings");
    expect(get.status).toBe(200);
    expect(get.body.inspectorAgentId).toBeNull();
    expect(get.body.inspectionRetryLimit).toBe(1);
  });

  it("rejects a retry cap outside the 1-3 range", async () => {
    const tooHigh = await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: null, inspectionRetryLimit: 4 });
    expect(tooHigh.status).toBe(400);

    const tooLow = await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: null, inspectionRetryLimit: 0 });
    expect(tooLow.status).toBe(400);
  });

  it("assigns and clears the inspector", async () => {
    const inspector = await createAgent(`${RUN_TAG} Assign`, { pause: false });
    const assigned = await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: inspector.id, inspectionRetryLimit: 2 });
    expect(assigned.status).toBe(200);
    expect(assigned.body.inspectorAgentId).toBe(inspector.id);
    expect(assigned.body.inspectionRetryLimit).toBe(2);

    const cleared = await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.inspectorAgentId).toBeNull();
    // Clearing the inspector leaves the retry cap untouched.
    expect(cleared.body.inspectionRetryLimit).toBe(2);
  });

  it("refuses a paused Crustabot as inspector", async () => {
    const paused = await createAgent(`${RUN_TAG} Paused`);
    const res = await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: paused.id });
    expect(res.status).toBe(409);
  });
});

describe("inspection cycle", () => {
  it("records a pass verdict and spawns no corrective retry", async () => {
    const worker = await createAgent(`${RUN_TAG} Worker Pass`);
    const inspector = await createAgent(`${RUN_TAG} Inspector Pass`, {
      pause: false,
    });
    await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: inspector.id });

    const task = await insertCompletedTask(worker.id);
    mockInspectorVerdict({ outcome: "pass", reason: "Matches the objective." });
    const count = await inspectCompletedTasks({ taskIds: [task.id] });
    expect(count).toBe(1);

    const row = await getTaskRow(task.id);
    expect(row.inspectionStatus).toBe("done");
    const inspections = await inspectionsFor(task.id);
    expect(inspections).toHaveLength(1);
    expect(inspections[0].outcome).toBe("pass");
    expect(await correctionsOf(task.id)).toHaveLength(0);
  });

  it("queues a corrective retry for the original Crustabot on needs-fix", async () => {
    const worker = await createAgent(`${RUN_TAG} Worker Fix`);
    const inspector = await createAgent(`${RUN_TAG} Inspector Fix`, {
      pause: false,
    });
    await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: inspector.id, inspectionRetryLimit: 1 });

    const task = await insertCompletedTask(worker.id);
    mockInspectorVerdict({
      outcome: "needs_fix",
      reason: "The result is missing the summary section.",
    });
    await inspectCompletedTasks({ taskIds: [task.id] });

    const inspections = await inspectionsFor(task.id);
    expect(inspections).toHaveLength(1);
    expect(inspections[0].outcome).toBe("needs_fix");

    const corrections = await correctionsOf(task.id);
    expect(corrections).toHaveLength(1);
    const correction = corrections[0];
    // Linked to the original and assigned back to the original Crustabot.
    expect(correction.agentId).toBe(worker.id);
    expect(correction.correctionAttempt).toBe(1);
    expect(correction.parentTaskId).toBe(task.id);
    // The recorded verdict points at the retry it spawned.
    expect(inspections[0].correctionTaskId).toBe(correction.id);
  });

  it("stops creating corrective retries once the cap is reached", async () => {
    const worker = await createAgent(`${RUN_TAG} Worker Cap`);
    const inspector = await createAgent(`${RUN_TAG} Inspector Cap`, {
      pause: false,
    });
    await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: inspector.id, inspectionRetryLimit: 1 });

    // A task that is already one corrective retry deep: the cap of 1 is spent.
    const task = await insertCompletedTask(worker.id, { correctionAttempt: 1 });
    mockInspectorVerdict({
      outcome: "needs_fix",
      reason: "Still wrong.",
    });
    await inspectCompletedTasks({ taskIds: [task.id] });

    const inspections = await inspectionsFor(task.id);
    expect(inspections[0].outcome).toBe("needs_fix");
    // No further retry beyond the cap.
    expect(await correctionsOf(task.id)).toHaveLength(0);
  });

  it("stamps a completed task for inspection but never the inspector's own work", async () => {
    const worker = await createAgent(`${RUN_TAG} Worker Stamp`);
    const inspector = await createAgent(`${RUN_TAG} Inspector Stamp`, {
      pause: false,
    });
    await request(app)
      .put("/api/inspector/settings")
      .send({ inspectorAgentId: inspector.id });

    // A completed task by another Crustabot is queued for inspection.
    const workerTask = await insertCompletedTask(worker.id, {
      inspectionStatus: null,
    });
    await queueInspectionIfConfigured(await getTaskRow(workerTask.id));
    expect((await getTaskRow(workerTask.id)).inspectionStatus).toBe("queued");

    // The inspector's own completed task is never stamped.
    const selfTask = await insertCompletedTask(inspector.id, {
      inspectionStatus: null,
    });
    await queueInspectionIfConfigured(await getTaskRow(selfTask.id));
    expect((await getTaskRow(selfTask.id)).inspectionStatus).toBeNull();
  });
});
