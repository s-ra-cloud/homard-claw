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
  approvalsTable,
  auditEventsTable,
  db,
  pool,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));
let wsId = "";

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// All provider traffic is mocked; the worker must never reach a real vendor
// from a test run. Individual tests install specific behaviors.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { claimNextTask, expireStaleApprovals, runTask } from "../worker";
import { recordAudit, verifyAuditChain } from "../audit";
import { effectivePermissions, evaluateTaskPolicy } from "../policy";
import { clearProviderCaches } from "../providers";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Policy ${Date.now()}`;
const createdAgentIds: string[] = [];

/**
 * Agents are created paused so the live development worker never claims
 * their tasks; tests claim explicitly with a scope that includes paused
 * agents.
 */
async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Policy Tester",
      mission: "Exercise autonomy and permission enforcement.",
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
  return res.body as {
    id: string;
    name: string;
    autonomy: string;
    permissions: Record<string, unknown>;
    permissionOverrides: Record<string, unknown> | null;
  };
}

const scopeFor = (agentId: string) => ({
  agentIds: [agentId],
  includePausedAgents: true,
});

/** Insert a task row directly so tests control status/estimates exactly. */
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
      choices: [{ message: { content: "Here is the finished work." } }],
      usage: { prompt_tokens: 1200, completion_tokens: 340 },
    });
  });
}

beforeAll(async () => {
  const [ws] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `hc-policy-${Date.now()}` })
    .returning({
      id: workspacesTable.id,
      clerkUserId: workspacesTable.clerkUserId,
    });
  wsId = ws.id;
  authState.userId = ws.clerkUserId;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-claude-token");
  clearProviderCaches();
});

afterAll(async () => {
  vi.unstubAllEnvs();
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
  // This suite owns the entire workspace, so cascading its deletion removes
  // the isolated audit chain without touching any real user's append-only log.
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsId));
  await pool.end();
});

describe("agent autonomy and permission configuration", () => {
  it("persists autonomy and custom overrides and reports effective permissions", async () => {
    const agent = await createAgent(`${RUN_TAG} Config`, {
      autonomy: "supervised",
      permissionOverrides: { maxTaskBudgetCents: 7, maxTasksPerDay: 3 },
    });
    expect(agent.autonomy).toBe("supervised");
    // Overrides win; untouched fields fall back to the assistant profile.
    expect(agent.permissions.maxTaskBudgetCents).toBe(7);
    expect(agent.permissions.maxTasksPerDay).toBe(3);
    expect(agent.permissions.dailyBudgetCents).toBe(250);
    expect(agent.permissionOverrides).toEqual({
      maxTaskBudgetCents: 7,
      maxTasksPerDay: 3,
    });

    const updated = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ autonomy: "autonomous", permissionOverrides: null });
    expect(updated.status).toBe(200);
    expect(updated.body.autonomy).toBe("autonomous");
    expect(updated.body.permissionOverrides).toBeNull();
    expect(updated.body.permissions.maxTaskBudgetCents).toBe(50);
  });
});

describe("policy denials", () => {
  it("blocks a task whose estimate exceeds the per-task cap", async () => {
    const agent = await createAgent(`${RUN_TAG} Capped`, {
      autonomy: "autonomous",
      permissionOverrides: { maxTaskBudgetCents: 10 },
    });
    await insertTask(agent.id, {
      estimatedCostCents: 25,
      talkMode: true,
      talkAutoApprove: true,
    });
    const claimed = await claimNextTask(scopeFor(agent.id));
    expect(claimed).not.toBeNull();
    await runTask(claimed!);

    const row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("policy");
    expect(row.errorMessage).toContain("per-task cap");
    expect(await getApprovalForTask(row.id)).toBeUndefined();
    // Policy blocked it before any provider call.
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("denies via provider allow-list and daily task limit", async () => {
    const agent = await createAgent(`${RUN_TAG} Limits`, {
      autonomy: "autonomous",
      permissionOverrides: {
        allowedProviders: ["claude_max"],
        maxTasksPerDay: 1,
      },
    });
    const agentRow = await loadAgent(agent.id);
    const task = await insertTask(agent.id, { estimatedCostCents: 1 });
    const denied = await evaluateTaskPolicy(agentRow, task);
    expect(denied.kind).toBe("deny");
    // The denial names the provider the way the owner sees it, not by id.
    expect((denied as { reason: string }).reason).toContain("OpenRouter");

    // Same task on an allowed provider, but another run already started
    // today: the daily count denies.
    await insertTask(agent.id, {
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const claudeTask = await insertTask(agent.id, { provider: "claude_max" });
    const counted = await evaluateTaskPolicy(agentRow, claudeTask);
    expect(counted.kind).toBe("deny");
    expect((counted as { reason: string }).reason).toContain("daily limit");
  });

  it("denies when the daily budget is exhausted", async () => {
    const agent = await createAgent(`${RUN_TAG} Broke`, {
      autonomy: "autonomous",
      permissionOverrides: { dailyBudgetCents: 5 },
    });
    await insertTask(agent.id, {
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      actualCostCents: 6,
    });
    const agentRow = await loadAgent(agent.id);
    const task = await insertTask(agent.id, { estimatedCostCents: 1 });
    const decision = await evaluateTaskPolicy(agentRow, task);
    expect(decision.kind).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("daily budget");
  });

  it("denies a task whose cost would take today's spend over the cap", async () => {
    const agent = await createAgent(`${RUN_TAG} Headroom`, {
      autonomy: "autonomous",
      permissionOverrides: { dailyBudgetCents: 10, maxTaskBudgetCents: 10 },
    });
    await insertTask(agent.id, {
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      actualCostCents: 6,
    });
    const agentRow = await loadAgent(agent.id);
    // 6 spent + 5 estimated > 10 daily cap: deny, even though neither
    // number alone breaks a limit.
    const task = await insertTask(agent.id, { estimatedCostCents: 5 });
    const decision = await evaluateTaskPolicy(agentRow, task);
    expect(decision.kind).toBe("deny");
    // A task's explicit budget counts as its cost bound when there is no
    // estimate — the worker hard-clamps spend to it.
    const budgeted = await insertTask(agent.id, {
      estimatedCostCents: null,
      budgetCents: 5,
    });
    expect((await evaluateTaskPolicy(agentRow, budgeted)).kind).toBe("deny");
    const fits = await insertTask(agent.id, {
      estimatedCostCents: null,
      budgetCents: 4,
    });
    expect((await evaluateTaskPolicy(agentRow, fits)).kind).toBe("allow");
  });

  it("requires sign-off for unboundable costs even when autonomous", async () => {
    const agent = await createAgent(`${RUN_TAG} Unbounded`, {
      autonomy: "autonomous",
    });
    const agentRow = await loadAgent(agent.id);
    // No estimate, no budget, metered provider: hard caps cannot be
    // verified, so autonomy does not exempt it from approval.
    const unpriced = await insertTask(agent.id, {
      estimatedCostCents: null,
      budgetCents: null,
    });
    const decision = await evaluateTaskPolicy(agentRow, unpriced);
    expect(decision.kind).toBe("needs_approval");
    // claude_max is subscription-backed, so no cost bound is needed.
    const subscription = await insertTask(agent.id, {
      provider: "claude_max",
      estimatedCostCents: null,
      budgetCents: null,
    });
    expect((await evaluateTaskPolicy(agentRow, subscription)).kind).toBe(
      "allow",
    );
  });
});

describe("approval lifecycle", () => {
  it("parks a supervised task, then approval resumes and runs it", async () => {
    const agent = await createAgent(`${RUN_TAG} Supervised`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, { estimatedCostCents: 1 });
    const claimed = await claimNextTask(scopeFor(agent.id));
    expect(claimed).not.toBeNull();
    await runTask(claimed!);

    // Parked, not executed; the consumed attempt is refunded.
    let row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("waiting_approval");
    expect(row.attempts).toBe(0);
    const approval = await getApprovalForTask(row.id);
    expect(approval?.status).toBe("pending");
    expect(approval?.action).toContain("Run task");

    // The approvals API exposes the real task context.
    const list = await request(app).get("/api/approvals");
    expect(list.status).toBe(200);
    const listed = list.body.find((a: { id: string }) => a.id === approval!.id);
    expect(listed.taskId).toBe(row.id);
    expect(listed.taskObjective).toContain(RUN_TAG);

    // Approve: the task requeues and the next claim runs it to completion
    // without asking again.
    const decide = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);
    expect(decide.body.status).toBe("approved");
    row = await getTaskRow(row.id);
    expect(row.status).toBe("queued");

    mockOpenRouterSuccess();
    const reclaimed = await claimNextTask(scopeFor(agent.id));
    expect(reclaimed?.task.id).toBe(row.id);
    await runTask(reclaimed!);
    row = await getTaskRow(row.id);
    expect(row.status).toBe("completed");
    expect(row.output).toContain("finished work");
  });

  it("auto-approves only the initial gate for a Talk task and reports the result back", async () => {
    const agent = await createAgent(`${RUN_TAG} Talk Auto`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, {
      estimatedCostCents: 1,
      talkMode: true,
      talkAutoApprove: true,
    });
    mockOpenRouterSuccess();
    const claimed = await claimNextTask(scopeFor(agent.id));
    expect(claimed).not.toBeNull();
    await runTask(claimed!);

    const row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("completed");
    const approval = await getApprovalForTask(row.id);
    expect(approval?.status).toBe("approved");
    expect(approval?.details).toContain("confirmed in Talk");

    const recaps = await db
      .select()
      .from(agentMessagesTable)
      .where(
        and(
          eq(agentMessagesTable.taskId, row.id),
          eq(agentMessagesTable.kind, "voice"),
        ),
      );
    expect(recaps).toHaveLength(1);
    expect(recaps[0]?.fromAgentId).toBe(agent.id);
    expect(recaps[0]?.body).toContain("What I did and the main result");
    expect(recaps[0]?.body).toContain("Here is the finished work.");
    expect(recaps[0]?.body).toContain("No issues were reported.");
  });

  it("rejecting an approval cancels the task", async () => {
    const agent = await createAgent(`${RUN_TAG} Rejected`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, { estimatedCostCents: 1 });
    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);
    const approval = await getApprovalForTask(claimed!.task.id);
    expect(approval?.status).toBe("pending");

    const decide = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "rejected" });
    expect(decide.status).toBe(200);
    const row = await getTaskRow(claimed!.task.id);
    expect(row.status).toBe("cancelled");
    expect(row.errorKind).toBe("approval_rejected");
  });

  it("limited autonomy parks only above the approval threshold", async () => {
    const agent = await createAgent(`${RUN_TAG} Limited`, {
      autonomy: "limited",
      permissionOverrides: {
        approvalThresholdCents: 10,
        maxTaskBudgetCents: 100,
      },
    });
    const agentRow = await loadAgent(agent.id);
    const cheap = await insertTask(agent.id, { estimatedCostCents: 5 });
    expect((await evaluateTaskPolicy(agentRow, cheap)).kind).toBe("allow");
    const pricey = await insertTask(agent.id, { estimatedCostCents: 50 });
    expect((await evaluateTaskPolicy(agentRow, pricey)).kind).toBe(
      "needs_approval",
    );
    const unpriced = await insertTask(agent.id, { estimatedCostCents: null });
    expect((await evaluateTaskPolicy(agentRow, unpriced)).kind).toBe(
      "needs_approval",
    );
  });

  it("expires stale approvals and unblocks their tasks as retryable", async () => {
    const agent = await createAgent(`${RUN_TAG} Expiry`, {
      autonomy: "supervised",
    });
    const task = await insertTask(agent.id, { status: "waiting_approval" });
    await db.insert(approvalsTable).values({
      agentId: agent.id,
      taskId: task.id,
      action: `${RUN_TAG} stale request`,
      details: "left undecided",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expireStaleApprovals();

    const approval = await getApprovalForTask(task.id);
    expect(approval?.status).toBe("expired");
    const row = await getTaskRow(task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("approval_expired");

    // An expired approval can no longer be decided.
    const decide = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "approved" });
    expect(decide.status).toBe(404);
  });

  it("cancelling a waiting task kills its pending approval", async () => {
    const agent = await createAgent(`${RUN_TAG} Cancelled`, {
      autonomy: "supervised",
    });
    await insertTask(agent.id, { estimatedCostCents: 1 });
    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);
    const approval = await getApprovalForTask(claimed!.task.id);
    expect(approval?.status).toBe("pending");

    const cancel = await request(app).post(
      `/api/tasks/${claimed!.task.id}/cancel`,
    );
    expect(cancel.status).toBe(200);
    const after = await getApprovalForTask(claimed!.task.id);
    expect(after?.status).toBe("cancelled");

    // The dead approval cannot resurrect the cancelled task.
    const decide = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "approved" });
    expect(decide.status).toBe(404);
    expect((await getTaskRow(claimed!.task.id)).status).toBe("cancelled");
  });
});

function completionCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("chat/completions"),
  );
}

describe("provider-call spend ceiling", () => {
  it("clamps output to the per-task cap even with a tiny estimate and no budget", async () => {
    const agent = await createAgent(`${RUN_TAG} TightCap`, {
      autonomy: "autonomous",
      // Per-task cap 1¢ is the binding bound; no daily budget, no task
      // budget — the cap alone must constrain the actual call.
      permissionOverrides: { maxTaskBudgetCents: 1, dailyBudgetCents: null },
    });
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      estimatedCostCents: 1,
      budgetCents: null,
    });
    mockOpenRouterSuccess();
    await runTask({ task, agent: await loadAgent(agent.id) });

    const done = await getTaskRow(task.id);
    expect(done.status).toBe("completed");
    const [call] = completionCalls();
    const body = JSON.parse(String(call?.[1]?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBeLessThan(4096);
    expect(body.max_tokens).toBeGreaterThan(0);
    // max_tokens at $10/M completion (1000¢/MTok) must fit inside 1¢.
    expect((body.max_tokens * 1000) / 1_000_000).toBeLessThanOrEqual(1);
  });

  it("clamps output to the remaining daily budget", async () => {
    const agent = await createAgent(`${RUN_TAG} DayCap`, {
      autonomy: "autonomous",
      permissionOverrides: { dailyBudgetCents: 10, maxTaskBudgetCents: null },
    });
    // 8¢ already spent today: only 2¢ of headroom remains.
    await insertTask(agent.id, {
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      actualCostCents: 8,
    });
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      estimatedCostCents: 1,
      budgetCents: null,
    });
    mockOpenRouterSuccess();
    await runTask({ task, agent: await loadAgent(agent.id) });

    expect((await getTaskRow(task.id)).status).toBe("completed");
    const [call] = completionCalls();
    const body = JSON.parse(String(call?.[1]?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBeLessThan(4096);
    expect((body.max_tokens * 1000) / 1_000_000).toBeLessThanOrEqual(2);
  });

  it("blocks the call when pricing is unknown and a cap applies", async () => {
    const agent = await createAgent(`${RUN_TAG} NoPrice`, {
      autonomy: "autonomous",
      permissionOverrides: { maxTaskBudgetCents: 5 },
    });
    const task = await insertTask(agent.id, {
      status: "running",
      attempts: 1,
      estimatedCostCents: 1,
    });
    // Catalog has no entry for the model: pricing unknown, cap unenforceable.
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/models")) return jsonResponse({ data: [] });
      return jsonResponse({
        choices: [{ message: { content: "should never happen" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    await runTask({ task, agent: await loadAgent(agent.id) });

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("budget");
    expect(row.errorMessage).toMatch(/pricing/i);
    expect(completionCalls().length).toBe(0);
  });
});

describe("tamper-evident audit history", () => {
  it("chains events, detects tampering, and supports search", async () => {
    const marker = `${RUN_TAG} chain probe`;
    await recordAudit(wsId, "test.probe", `${marker} first`);
    await recordAudit(wsId, "test.probe", `${marker} second`);

    const before = await verifyAuditChain(wsId);
    expect(before.valid).toBe(true);
    expect(before.checked).toBeGreaterThanOrEqual(2);

    // Search finds the events through the owner API.
    const search = await request(app).get("/api/audit").query({ q: marker });
    expect(search.status).toBe(200);
    expect(search.body.total).toBe(2);
    expect(search.body.events[0].chained).toBe(true);

    const verifyApi = await request(app).get("/api/audit/verify");
    expect(verifyApi.status).toBe(200);
    expect(verifyApi.body.valid).toBe(true);

    // Tamper with a recorded summary inside a transaction that ALWAYS
    // rolls back: this database is shared with the live dev server, so
    // the forgery must never be visible outside this probe — even if the
    // test crashes mid-way.
    const [victim] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.summary, `${marker} first`))
      .limit(1);
    const ROLLBACK = "rollback-tamper-probe";
    await db
      .transaction(async (tx) => {
        await tx
          .update(auditEventsTable)
          .set({ summary: `${marker} FORGED` })
          .where(eq(auditEventsTable.id, victim!.id));
        const tampered = await verifyAuditChain(wsId, tx);
        expect(tampered.valid).toBe(false);
        expect(tampered.firstInvalidId).toBe(victim!.id);
        throw new Error(ROLLBACK);
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== ROLLBACK) {
          throw error;
        }
      });
    expect((await verifyAuditChain(wsId)).valid).toBe(true);
  });
});
