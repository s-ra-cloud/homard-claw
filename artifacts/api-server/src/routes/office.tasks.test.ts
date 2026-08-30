import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  appActionsTable,
  db,
  pool,
  systemStateTable,
  taskLogsTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// All provider traffic is mocked; the worker must never reach a real vendor
// from a test run. Individual tests install specific behaviors.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import {
  abortAllInFlight,
  claimNextTask,
  getWorkerStatus,
  heartbeatOwnershipOnce,
  recoverInterruptedTasks,
  runTask,
  setOwnershipForTest,
  stopWorker,
} from "../worker";
import {
  WORKER_INSTANCE_ID,
  acquireOrRenewOwnership,
  deleteOwnershipRow,
  getOwnershipSnapshot,
  renewOwnership,
} from "../worker-ownership";
import { clearProviderCaches } from "../providers";
import {
  deleteProviderCredential,
  saveProviderCredential,
} from "../provider-credentials";
import { providerCredentialsTable } from "@workspace/db";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Tasks ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let wsId = "";
let priorCredentialRows: (typeof providerCredentialsTable.$inferSelect)[] = [];
let createdWorkspace = false;

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Queue Tester",
      mission: "Exercise the persistent task queue.",
      provider: "claude_max",
      securityPreset: "assistant",
      // These tests exercise execution mechanics, not policy: run fully
      // autonomous with unlimited caps (explicit null overrides) so the
      // spend-ceiling gate only engages when a test sets its own task
      // budget. Policy gating itself is covered in office.policy.test.ts.
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      ...extra,
    });
  if (res.status === 201) createdAgentIds.push(res.body.id);
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

/** Insert a task row directly so tests control status/attempts exactly. */
async function insertTask(
  agentId: string,
  overrides: Partial<typeof tasksTable.$inferInsert> = {},
) {
  const [taskRow] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId: wsId,
      objective: `${RUN_TAG} scripted objective`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "queued",
      // A priced task by default: metered tasks with no estimate AND no
      // budget park for approval instead of running.
      estimatedCostCents: 1,
      ...overrides,
    })
    .returning();
  return taskRow!;
}

async function getTaskRow(id: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return task;
}

async function getLogs(taskId: string) {
  return db
    .select()
    .from(taskLogsTable)
    .where(eq(taskLogsTable.taskId, taskId))
    .orderBy(taskLogsTable.createdAt);
}

async function loadAgent(agentId: string) {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return agent!;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OPENROUTER_SUCCESS = {
  choices: [{ message: { content: "Here is the finished work." } }],
  usage: { prompt_tokens: 1200, completion_tokens: 340 },
};

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
  const [existingWorkspace] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, authState.userId))
    .limit(1);
  const boot = await request(app).get("/api/agents");
  expect(boot.status).toBe(200);
  const [wsRow] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, authState.userId))
    .limit(1);
  wsId = wsRow!.id;
  createdWorkspace = !existingWorkspace;
  priorCredentialRows = await db
    .select()
    .from(providerCredentialsTable)
    .where(eq(providerCredentialsTable.workspaceId, wsId));
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  // Provider credentials are workspace rows now, not env vars.
  await saveProviderCredential(wsId, "openrouter", "test-openrouter-key");
  await saveProviderCredential(wsId, "claude_max", "test-claude-token");
  clearProviderCaches();
});

/** Fetch behavior with a priced OpenRouter catalog plus completion handling. */
function mockOpenRouterWithPricing(
  completion: (init?: { signal?: AbortSignal }) => Promise<Response>,
) {
  fetchMock.mockImplementation(
    async (url: unknown, init?: { signal?: AbortSignal }) => {
      if (String(url).includes("/models")) {
        return jsonResponse({
          data: [
            {
              id: "test-vendor/test-model",
              name: "Test Model",
              context_length: 8192,
              // $1 per M prompt tokens, $10 per M completion tokens
              pricing: { prompt: "0.000001", completion: "0.00001" },
            },
          ],
        });
      }
      return completion(init);
    },
  );
}

function completionCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("chat/completions"),
  );
}

afterAll(async () => {
  vi.unstubAllEnvs();
  // Restore the workspace's credential rows exactly as we found them.
  await db
    .delete(providerCredentialsTable)
    .where(eq(providerCredentialsTable.workspaceId, wsId));
  if (priorCredentialRows.length > 0) {
    await db.insert(providerCredentialsTable).values(priorCredentialRows);
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Audit rows are intentionally left in place: the log is hash-chained
  // and append-only, so deleting rows would break chain verification.
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
  if (createdWorkspace) {
    await db.delete(workspacesTable).where(eq(workspacesTable.id, wsId));
  }
  await pool.end();
});

describe("task creation with priority and budget", () => {
  it("persists priority and budget and queues when the provider is configured", async () => {
    const agent = await createAgent(`${RUN_TAG} Creator`);
    const res = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: `${RUN_TAG} file the kelp reports`,
      priority: "high",
      budgetCents: 250,
    });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("high");
    expect(res.body.budgetCents).toBe(250);
    expect(res.body.status).toBe("queued");
    expect(res.body.attempts).toBe(0);
    const logs = await getLogs(res.body.id);
    expect(logs.some((l) => l.message.includes("queued"))).toBe(true);
    // Keep it out of any worker's reach.
    await request(app).post(`/api/tasks/${res.body.id}/cancel`);
  });

  it("blocks creation explicitly when the provider is not configured", async () => {
    await deleteProviderCredential(wsId, "claude_max");
    const agent = await createAgent(`${RUN_TAG} Unconfigured`);
    const res = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: `${RUN_TAG} do work without credentials`,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("blocked");
    expect(res.body.errorKind).toBe("not_configured");
    expect(res.body.errorMessage).toMatch(/not configured/i);
  });
});

describe("worker claim ordering", () => {
  it("claims by priority then age, honors backoff, and skips paused agents", async () => {
    // Paused agent: the live dev worker ignores it, so ordering is
    // deterministic; the scoped claim below opts back in.
    const agent = await createAgent(`${RUN_TAG} Claimant`);
    await request(app).post(`/api/agents/${agent.id}/pause`).send({ paused: true });
    const scope = { agentIds: [agent.id], includePausedAgents: true };

    const low = await insertTask(agent.id, { priority: "low" });
    const normal = await insertTask(agent.id, { priority: "normal" });
    const high = await insertTask(agent.id, { priority: "high" });
    const backoff = await insertTask(agent.id, {
      priority: "high",
      notBefore: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Paused agents are skipped without the explicit opt-in.
    expect(await claimNextTask({ agentIds: [agent.id] })).toBeNull();

    const first = await claimNextTask(scope);
    expect(first?.task.id).toBe(high.id);
    expect(first?.task.status).toBe("running");
    expect(first?.task.attempts).toBe(1);
    const second = await claimNextTask(scope);
    expect(second?.task.id).toBe(normal.id);
    const third = await claimNextTask(scope);
    expect(third?.task.id).toBe(low.id);
    // The rate-limited task is not claimable until its backoff expires.
    expect(await claimNextTask(scope)).toBeNull();
    expect((await getTaskRow(backoff.id))?.status).toBe("queued");
  });
});

describe("worker execution", () => {
  it("completes a task, storing output, usage, cost, and logs", async () => {
    const agent = await createAgent(`${RUN_TAG} Doer`);
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      startedAt: new Date(),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(OPENROUTER_SUCCESS));

    await runTask({ task, agent: await loadAgent(agent.id) });

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("Here is the finished work.");
    expect(done?.actualInputTokens).toBe(1200);
    expect(done?.actualOutputTokens).toBe(340);
    expect(done?.finishedAt).toBeTruthy();
    const logs = await getLogs(task.id);
    expect(logs.some((l) => l.message.match(/Completed/))).toBe(true);
    // Never leak credentials into logs or output.
    expect(JSON.stringify(logs)).not.toContain("test-openrouter-key");

    const [call] = fetchMock.mock.calls;
    expect(String(call?.[0])).toContain("openrouter.ai");
  });

  it("fails with a structured auth error when the provider rejects the credential", async () => {
    const agent = await createAgent(`${RUN_TAG} Rejected`);
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad key" }, 401));

    await runTask({ task, agent: await loadAgent(agent.id) });

    const failed = await getTaskRow(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorKind).toBe("auth");
    expect(failed?.errorMessage).toMatch(/credential/i);
  });

  it("requeues with backoff on rate limits, then fails after max attempts", async () => {
    const agent = await createAgent(`${RUN_TAG} Limited`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });
    fetchMock.mockResolvedValue(jsonResponse({ error: "slow down" }, 429));

    await runTask({ task, agent: await loadAgent(agent.id) });
    const requeued = await getTaskRow(task.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.errorKind).toBe("rate_limit");
    expect(requeued?.notBefore && requeued.notBefore > new Date()).toBe(true);

    // Final attempt exhausts the retry budget.
    const [lastAttempt] = await db
      .update(tasksTable)
      .set({ status: "running", attempts: 3 })
      .where(eq(tasksTable.id, task.id))
      .returning();
    await runTask({ task: lastAttempt!, agent: await loadAgent(agent.id) });
    const failed = await getTaskRow(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorKind).toBe("rate_limit");
  });

  it("requeues a provider 503 and completes on the next attempt", async () => {
    const agent = await createAgent(`${RUN_TAG} Flaky`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    await runTask({ task, agent: await loadAgent(agent.id) });
    const requeued = await getTaskRow(task.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.errorKind).toBe("transient");
    expect(requeued?.notBefore && requeued.notBefore > new Date()).toBe(true);
    expect((await getLogs(task.id)).some((l) => l.message.match(/Retrying in/))).toBe(
      true,
    );

    // The blip clears: the next attempt runs and the task finishes normally.
    // Mirrors what claimNextTask does when the backoff expires — it clears
    // the previous attempt's error as it takes the task.
    const [second] = await db
      .update(tasksTable)
      .set({
        status: "running",
        attempts: 2,
        notBefore: null,
        errorKind: null,
        errorMessage: null,
      })
      .where(eq(tasksTable.id, task.id))
      .returning();
    fetchMock.mockResolvedValueOnce(jsonResponse(OPENROUTER_SUCCESS));
    await runTask({ task: second!, agent: await loadAgent(agent.id) });

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("Here is the finished work.");
    expect(done?.errorKind).toBeNull();
  });

  it("requeues transient network failures, then fails cleanly at the ceiling", async () => {
    const agent = await createAgent(`${RUN_TAG} Dropped`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });
    // What undici throws when the socket dies mid-request: a generic
    // TypeError with the real code buried on the cause chain.
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    });

    await runTask({ task, agent: await loadAgent(agent.id) });
    const requeued = await getTaskRow(task.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.errorKind).toBe("transient");
    expect(requeued?.errorMessage).toMatch(/ECONNRESET/);

    // The ceiling still applies: the last attempt fails terminally.
    const [lastAttempt] = await db
      .update(tasksTable)
      .set({ status: "running", attempts: 3, notBefore: null })
      .where(eq(tasksTable.id, task.id))
      .returning();
    await runTask({ task: lastAttempt!, agent: await loadAgent(agent.id) });
    const failed = await getTaskRow(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorKind).toBe("transient");
    expect(failed?.finishedAt).toBeTruthy();
  });

  it("keeps the per-call timeout terminal rather than retrying it", async () => {
    const agent = await createAgent(`${RUN_TAG} Slow`, {
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
        // One second of wall clock: the worker aborts its own call.
        maxRunSeconds: 1,
      },
    });
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });
    fetchMock.mockImplementationOnce(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    await runTask({ task, agent: await loadAgent(agent.id) });
    const failed = await getTaskRow(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorKind).toBe("timeout");
  });

  it("handles malformed provider payloads as explicit failures", async () => {
    const agent = await createAgent(`${RUN_TAG} Garbled`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: "shape" }));

    await runTask({ task, agent: await loadAgent(agent.id) });
    const failed = await getTaskRow(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorKind).toBe("provider_error");
  });

  it("blocks budgeted tasks when model pricing is unknown", async () => {
    // The default fetch mock fails the catalog lookup, so pricing is
    // unknown; a budget cannot be enforced against unknown prices.
    const agent = await createAgent(`${RUN_TAG} Thrifty`);
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      budgetCents: 10,
    });

    await runTask({ task, agent: await loadAgent(agent.id) });
    const blocked = await getTaskRow(task.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.errorKind).toBe("budget");
    expect(blocked?.errorMessage).toMatch(/pricing.*unknown/i);
    expect(completionCalls()).toHaveLength(0);
  });

  it("blocks when the prompt alone would exceed the budget", async () => {
    const agent = await createAgent(`${RUN_TAG} Broke`);
    // Prompt is ~650+ tokens at $1/M ≈ 0.065¢; a 0.01¢ budget cannot even
    // cover the input.
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      budgetCents: 0.01,
    });
    mockOpenRouterWithPricing(async () => jsonResponse(OPENROUTER_SUCCESS));

    await runTask({ task, agent: await loadAgent(agent.id) });
    const blocked = await getTaskRow(task.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.errorKind).toBe("budget");
    expect(blocked?.errorMessage).toMatch(/prompt alone/i);
    expect(completionCalls()).toHaveLength(0);
  });

  it("clamps completion tokens so actual spend cannot exceed the budget", async () => {
    const agent = await createAgent(`${RUN_TAG} Capped`);
    // 1¢ budget: prompt ≈ 0.065¢ at $1/M leaves <1¢ for output at $10/M
    // (1000 cents/MTok) → far fewer than the 4096-token default.
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      budgetCents: 1,
    });
    mockOpenRouterWithPricing(async () => jsonResponse(OPENROUTER_SUCCESS));

    await runTask({ task, agent: await loadAgent(agent.id) });

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    const [call] = completionCalls();
    const body = JSON.parse(String(call?.[1]?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBeLessThan(4096);
    expect(body.max_tokens).toBeGreaterThan(0);
    // max_tokens * completion rate must fit inside the remaining budget.
    expect((body.max_tokens * 1000) / 1_000_000).toBeLessThanOrEqual(1);
    const logs = await getLogs(task.id);
    expect(logs.some((l) => l.message.match(/capped/i))).toBe(true);
  });

  it("blocks explicitly when the provider is not configured", async () => {
    await deleteProviderCredential(wsId, "openrouter");
    const agent = await createAgent(`${RUN_TAG} Keyless`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });

    await runTask({ task, agent: await loadAgent(agent.id) });
    const blocked = await getTaskRow(task.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.errorKind).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops spending when the worker lease is lost mid-call", async () => {
    const agent = await createAgent(`${RUN_TAG} Fenced`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });

    fetchMock.mockImplementationOnce(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const run = runTask({ task, agent: await loadAgent(agent.id) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Lease loss aborts every in-flight call; a new lease holder recovers
    // and reclaims the task (attempts increments).
    expect(abortAllInFlight("lease_lost")).toBe(1);
    await db
      .update(tasksTable)
      .set({ status: "running", attempts: 2 })
      .where(eq(tasksTable.id, task.id));
    await run;

    // The stale process wrote no terminal state over the new attempt.
    const after = await getTaskRow(task.id);
    expect(after?.status).toBe("running");
    expect(after?.attempts).toBe(2);
    expect(after?.output).toBeNull();
    // Park the row so nothing else touches it.
    await db
      .update(tasksTable)
      .set({ status: "cancelled" })
      .where(eq(tasksTable.id, task.id));
  });

  it("fences a stale attempt's late result away from a reclaimed task", async () => {
    const agent = await createAgent(`${RUN_TAG} Stale`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });

    let releaseCall: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseCall = () => resolve(jsonResponse(OPENROUTER_SUCCESS));
        }),
    );

    const run = runTask({ task, agent: await loadAgent(agent.id) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Simulate a reclaim by another instance while the call is in flight.
    await db
      .update(tasksTable)
      .set({ status: "running", attempts: 2 })
      .where(eq(tasksTable.id, task.id));
    releaseCall?.();
    await run;

    // The stale attempt's result and usage must not touch the new attempt.
    const after = await getTaskRow(task.id);
    expect(after?.status).toBe("running");
    expect(after?.attempts).toBe(2);
    expect(after?.output).toBeNull();
    expect(after?.actualInputTokens).toBeNull();
    await db
      .update(tasksTable)
      .set({ status: "cancelled" })
      .where(eq(tasksTable.id, task.id));
  });

  it("keeps a cancellation over an in-flight result and records usage", async () => {
    const agent = await createAgent(`${RUN_TAG} Interrupted`);
    const task = await insertTask(agent.id, { status: "running", attempts: 1 });

    let releaseCall: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          releaseCall = () => resolve(jsonResponse(OPENROUTER_SUCCESS));
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const run = runTask({ task, agent: await loadAgent(agent.id) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Owner cancels while the provider call is in flight; the route also
    // aborts the in-process call.
    const cancel = await request(app).post(`/api/tasks/${task.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
    await run;

    const after = await getTaskRow(task.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.output).toBeNull();
    releaseCall?.();
  });
});

describe("queue ownership fencing", () => {
  // Every key is run-unique: the production ownership row ("queue-worker")
  // belongs to the live development server's worker and is never touched.
  const OWNERSHIP_RUN = `test-fence-${Date.now()}`;

  it("aborts a long provider call and completes nothing when ownership is taken over", async () => {
    const key = `${OWNERSHIP_RUN}-takeover`;
    try {
      // This process acquires with a tiny TTL, then "freezes": no
      // heartbeats until the takeover has already happened. The local
      // state is installed as if the worker loop had acquired normally.
      const acquired = await acquireOrRenewOwnership(key, WORKER_INSTANCE_ID, 50);
      expect(acquired.state).toBe("acquired");
      setOwnershipForTest({
        key,
        generation: 1,
        expiresAtMs: Date.now() + 60_000,
      });

      const agent = await createAgent(`${RUN_TAG} Takeover`);
      const task = await insertTask(agent.id, { status: "running", attempts: 1 });
      fetchMock.mockImplementationOnce(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      );
      const run = runTask({ task, agent: await loadAgent(agent.id) });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      // The TTL passes; a healthy rival instance takes over and, as the new
      // owner would, requeues and reclaims the interrupted task
      // (attempts increments — the completion fence).
      await new Promise((resolve) => setTimeout(resolve, 60));
      const rival = await acquireOrRenewOwnership(key, "rival-instance", 60_000);
      expect(rival).toMatchObject({
        state: "acquired",
        generation: 2,
        takeoverFrom: WORKER_INSTANCE_ID,
      });
      await db
        .update(tasksTable)
        .set({ status: "running", attempts: 2 })
        .where(eq(tasksTable.id, task.id));

      // The stale holder's next heartbeat is rejected — it must abort its
      // in-flight provider call immediately and drop to standby.
      await heartbeatOwnershipOnce();
      const status = getWorkerStatus();
      expect(status.state).toBe("standby");
      expect(status.leaseHeld).toBe(false);
      expect(status.ownershipLosses).toBeGreaterThanOrEqual(1);
      await run;

      // The stale attempt wrote no terminal state over the new attempt, and
      // made exactly one (aborted) provider call: nothing completed or was
      // billed twice.
      const after = await getTaskRow(task.id);
      expect(after?.status).toBe("running");
      expect(after?.attempts).toBe(2);
      expect(after?.output).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Fencing holds durably too: the displaced generation can never renew.
      expect(await renewOwnership(key, WORKER_INSTANCE_ID, 1, 60_000)).toBe(
        false,
      );

      // Park the row so nothing else touches it.
      await db
        .update(tasksTable)
        .set({ status: "cancelled" })
        .where(eq(tasksTable.id, task.id));
    } finally {
      setOwnershipForTest(null);
      await deleteOwnershipRow(key);
    }
  });

  it("releases ownership on clean shutdown so a successor takes over immediately", async () => {
    const key = `${OWNERSHIP_RUN}-shutdown`;
    try {
      const acquired = await acquireOrRenewOwnership(
        key,
        WORKER_INSTANCE_ID,
        60_000,
      );
      expect(acquired.state).toBe("acquired");
      setOwnershipForTest({
        key,
        generation: acquired.state === "acquired" ? acquired.generation : 1,
        expiresAtMs: Date.now() + 60_000,
      });

      await stopWorker();

      // The row is gone — no successor waits out a 60s TTL after SIGTERM.
      expect(await getOwnershipSnapshot(key)).toBeNull();
      const successor = await acquireOrRenewOwnership(key, "successor", 60_000);
      expect(successor.state).toBe("acquired");
      expect(getWorkerStatus().state).toBe("standby");
    } finally {
      setOwnershipForTest(null);
      await deleteOwnershipRow(key);
    }
  });
});

describe("restart recovery", () => {
  it("requeues tasks that were running when the process died", async () => {
    const agent = await createAgent(`${RUN_TAG} Survivor`);
    await request(app).post(`/api/agents/${agent.id}/pause`).send({ paused: true });
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 2,
      startedAt: new Date(),
    });
    const legacy = await insertTask(agent.id, { status: "paused" });

    await recoverInterruptedTasks();

    const recovered = await getTaskRow(task.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.startedAt).toBeNull();
    const logs = await getLogs(task.id);
    expect(logs.some((l) => l.message.match(/restarted/i))).toBe(true);

    // Legacy `paused` rows migrate to the current contract as blocked.
    const migrated = await getTaskRow(legacy.id);
    expect(migrated?.status).toBe("blocked");
    expect(migrated?.errorKind).toBe("legacy_paused");
  });
});

describe("task lifecycle routes", () => {
  it("returns task detail with ordered execution logs", async () => {
    const agent = await createAgent(`${RUN_TAG} Inspected`);
    const task = await insertTask(agent.id, { status: "failed", errorKind: "auth", errorMessage: "nope" });
    await db.insert(taskLogsTable).values([
      { taskId: task.id, level: "info", message: "first entry" },
      { taskId: task.id, level: "error", message: "second entry" },
    ]);

    const res = await request(app).get(`/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(task.id);
    expect(res.body.task.errorKind).toBe("auth");
    expect(res.body.logs.map((l: { message: string }) => l.message)).toEqual([
      "first entry",
      "second entry",
    ]);
    expect(res.body.actions).toEqual([]);

    const missing = await request(app).get(
      "/api/tasks/00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
  });

  it("returns connected-app actions on task detail and a rollup on agent detail", async () => {
    const agent = await createAgent(`${RUN_TAG} AppActor`);
    const task = await insertTask(agent.id, { status: "completed" });
    await db.insert(appActionsTable).values([
      {
        taskId: task.id,
        agentId: agent.id,
        app: "gmail",
        operation: "gmail.search",
        targetSummary: `${RUN_TAG} search inbox for invoices`,
        status: "executed",
        resultSummary: "3 threads found",
        executedAt: new Date(),
        createdAt: new Date(Date.now() - 2000),
      },
      {
        taskId: task.id,
        agentId: agent.id,
        app: "github",
        operation: "github.create_issue",
        targetSummary: `${RUN_TAG} open issue in owner/repo`,
        status: "waiting_approval",
        createdAt: new Date(Date.now() - 1000),
      },
    ]);

    const detail = await request(app).get(`/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    // Oldest first on the task timeline.
    expect(
      detail.body.actions.map((a: { operation: string; status: string }) => [
        a.operation,
        a.status,
      ]),
    ).toEqual([
      ["gmail.search", "executed"],
      ["github.create_issue", "waiting_approval"],
    ]);
    expect(detail.body.actions[0].resultSummary).toBe("3 threads found");
    expect(detail.body.actions[0].executedAt).toBeTruthy();

    const agentDetail = await request(app).get(`/api/agents/${agent.id}`);
    expect(agentDetail.status).toBe(200);
    // Newest first on the agent rollup, with the owning task's objective.
    expect(
      agentDetail.body.recentActions.map((a: { operation: string }) => a.operation),
    ).toEqual(["github.create_issue", "gmail.search"]);
    expect(agentDetail.body.recentActions[0].taskObjective).toBe(task.objective);
  });

  it("cancels queued work and rejects cancelling finished work", async () => {
    const agent = await createAgent(`${RUN_TAG} Canceller`);
    const task = await insertTask(agent.id, {
      status: "queued",
      notBefore: new Date(Date.now() + 60 * 60 * 1000),
    });

    const cancelled = await request(app).post(`/api/tasks/${task.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.finishedAt).toBeTruthy();

    const again = await request(app).post(`/api/tasks/${task.id}/cancel`);
    expect(again.status).toBe(409);

    const done = await insertTask(agent.id, { status: "completed" });
    const rejected = await request(app).post(`/api/tasks/${done.id}/cancel`);
    expect(rejected.status).toBe(409);
  });

  it("retries failed work with a clean slate and rejects ineligible states", async () => {
    const agent = await createAgent(`${RUN_TAG} Retrier`);
    await request(app).post(`/api/agents/${agent.id}/pause`).send({ paused: true });
    const task = await insertTask(agent.id, {
      status: "failed",
      attempts: 3,
      errorKind: "provider_error",
      errorMessage: "it broke",
      output: "partial",
      finishedAt: new Date(),
    });

    const retried = await request(app).post(`/api/tasks/${task.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe("queued");
    expect(retried.body.attempts).toBe(0);
    expect(retried.body.errorKind).toBeNull();
    expect(retried.body.errorMessage).toBeNull();
    expect(retried.body.output).toBeNull();
    expect(retried.body.finishedAt).toBeNull();

    const running = await insertTask(agent.id, { status: "running" });
    const rejected = await request(app).post(`/api/tasks/${running.id}/retry`);
    expect(rejected.status).toBe(409);
    // Leave nothing claimable behind.
    await db
      .update(tasksTable)
      .set({ status: "cancelled" })
      .where(inArray(tasksTable.id, [task.id, running.id]));
  });
});
