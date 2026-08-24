/**
 * End-to-end coverage of the worker's approval-gated connected-app write
 * path, with a stubbed provider (global fetch) and stubbed connector
 * execution (executeOperation). Proves, against the real dev Postgres:
 *
 *  - a requested write parks the task waiting_approval with the exact
 *    action recorded, and after the owner approves, the worker claims and
 *    executes that stored action exactly once, then the model resumes with
 *    the verified result in its prompt
 *  - the approved → executing fence is exactly-once under a simulated race
 *    (parallel claimApprovedAction calls)
 *  - a grant revoked between approval and execution denies the action; the
 *    connector is never called
 *  - a task cancelled (or whose agent is archived) after approval is never
 *    claimable, so the approved write never executes
 *  - a metered multi-round run is stopped before the next dispatch when the
 *    budget ceiling is already spent
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate the existing owner, keep test agents paused so the live dev
 * worker never claims their tasks, use the scoped claim for worker paths,
 * tag + clean up all rows, restore shared settings, never touch audit rows.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  appActionsTable,
  approvalsTable,
  db,
  googleAccountsTable,
  pool,
  taskLogsTable,
  tasksTable,
  workspaceConnectedAppsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-apps-worker-owner" as string | null,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async () => {
        throw new Error("no such user");
      },
    },
  },
}));

// All provider traffic goes through this mock; nothing reaches a vendor.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

// Connector execution is stubbed at the module boundary the worker uses:
// executeOperation is the single seam through which every allowed or
// approved action reaches an external app.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("../connected-apps/connections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connected-apps/connections")>();
  return { ...actual, executeOperation: executeMock };
});

import officeRouter from "./office";
import { claimNextTask, runTask } from "../worker";
import { claimApprovedAction, executeClaimedAction } from "../connected-apps/actions";
import {
  clearGoogleTokenCache,
  encryptRefreshToken,
} from "../google/credentials";
import { clearProviderCaches } from "../providers";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC AppsWorker ${Date.now()}`;
const createdAgentIds: string[] = [];
let workspaceId: string;
/** app → original settings row (or null when there was none) to restore. */
const touchedSettings = new Map<string, { enabled: boolean } | null>();

async function createAgent(
  name: string,
  appGrants: Array<{ app: string; accessLevel: string }>,
) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name: `${name} ${RUN_TAG}`,
      title: "Write-Path Tester",
      mission: "Exercise the approval-gated connected-app write path.",
      provider: "openrouter",
      securityPreset: "assistant",
      // Execution mechanics, not policy: fully autonomous, unlimited caps,
      // so only the per-test task budget ever engages the spend ceiling.
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      appGrants,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused: the live dev worker must never claim this agent's tasks. The
  // scoped claim below opts back in explicitly.
  const paused = await request(app)
    .post(`/api/agents/${res.body.id}/pause`)
    .send({ paused: true });
  expect(paused.status).toBe(200);
  return res.body as { id: string };
}

async function loadAgent(agentId: string) {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return agent!;
}

/** Insert a task row directly so tests control status/attempts exactly. */
async function insertRunningTask(
  agentId: string,
  overrides: Partial<typeof tasksTable.$inferInsert> = {},
) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId,
      objective: `${RUN_TAG} handle the kelp correspondence`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "running",
      attempts: 1,
      startedAt: new Date(),
      // Metered tasks with no estimate AND no budget park for approval.
      estimatedCostCents: 1,
      ...overrides,
    })
    .returning();
  return task;
}

async function getTaskRow(id: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return task;
}

async function getActions(taskId: string) {
  return db
    .select()
    .from(appActionsTable)
    .where(eq(appActionsTable.taskId, taskId))
    .orderBy(appActionsTable.createdAt);
}

async function getPendingApproval(taskId: string) {
  const [approval] = await db
    .select()
    .from(approvalsTable)
    .where(
      and(eq(approvalsTable.taskId, taskId), eq(approvalsTable.status, "pending")),
    )
    .limit(1);
  return approval;
}

async function getLogs(taskId: string) {
  return db
    .select()
    .from(taskLogsTable)
    .where(eq(taskLogsTable.taskId, taskId))
    .orderBy(taskLogsTable.createdAt);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// $1 per M prompt tokens, $10 per M completion tokens.
const PRICING_CATALOG = {
  data: [
    {
      id: "test-vendor/test-model",
      name: "Test Model",
      context_length: 8192,
      pricing: { prompt: "0.000001", completion: "0.00001" },
    },
  ],
};

function completion(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } = {
    prompt_tokens: 1000,
    completion_tokens: 100,
  },
) {
  return { choices: [{ message: { content } }], usage };
}

/** Pricing catalog plus an ordered queue of completion responses. */
function queueCompletions(bodies: unknown[]) {
  const queue = [...bodies];
  fetchMock.mockImplementation(async (url: unknown) => {
    if (String(url).includes("/models")) return jsonResponse(PRICING_CATALOG);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    }
    return jsonResponse(next);
  });
}

function completionCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("chat/completions"),
  );
}

function lastPromptSent(): string {
  const calls = completionCalls();
  const [, init] = calls[calls.length - 1] as [unknown, { body?: string }];
  return String(init?.body ?? "");
}

const SEND_EMAIL_PARAMS = {
  to: "alice@example.com",
  subject: "Kelp report",
  body: "The full report is below.",
};
const SEND_EMAIL_BLOCK = `I need to send this now.\n<app_action>${JSON.stringify(
  { operation: "gmail.send_email", params: SEND_EMAIL_PARAMS },
)}</app_action>`;

/**
 * Drive a fresh task through: model requests a write → task parks
 * waiting_approval with the action row recorded and linked to a pending
 * approval. Returns the parked task and its action + approval rows.
 */
async function parkOnWrite(agentId: string) {
  const task = await insertRunningTask(agentId);
  queueCompletions([completion(SEND_EMAIL_BLOCK)]);
  await runTask({ task, agent: await loadAgent(agentId) });

  const parked = await getTaskRow(task.id);
  expect(parked?.status).toBe("waiting_approval");
  // Parking refunds the attempt: waiting is not a failure.
  expect(parked?.attempts).toBe(0);
  const approval = await getPendingApproval(task.id);
  expect(approval).toBeTruthy();
  const [action] = await getActions(task.id);
  expect(action?.status).toBe("waiting_approval");
  expect(action?.operation).toBe("gmail.send_email");
  expect(action?.params).toEqual(SEND_EMAIL_PARAMS);
  expect(action?.approvalId).toBe(approval!.id);
  return { task: parked!, approval: approval!, action: action! };
}

async function approve(approvalId: string) {
  const res = await request(app)
    .patch(`/api/approvals/${approvalId}`)
    .send({ decision: "approved" });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "connected-apps-worker-test-secret");
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `connected-apps-worker-${Date.now()}` })
    .returning();
  workspaceId = workspace.id;
  authState.userId = workspace.clerkUserId;
  await db.insert(googleAccountsTable).values({
    workspaceId,
    clerkUserId: workspace.clerkUserId,
    googleSub: `google-${RUN_TAG}`,
    email: "worker-test@example.com",
    refreshTokenEnc: encryptRefreshToken("test-refresh-token"),
    scopes:
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send",
  });

  // Gmail must be enabled workspace-wide for grants to take effect;
  // remember whatever the row was so teardown restores it exactly.
  const [existing] = await db
    .select()
    .from(workspaceConnectedAppsTable)
    .where(
      and(
        eq(workspaceConnectedAppsTable.workspaceId, workspaceId),
        eq(workspaceConnectedAppsTable.app, "gmail"),
      ),
    )
    .limit(1);
  touchedSettings.set("gmail", existing ? { enabled: existing.enabled } : null);
  const enable = await request(app)
    .patch("/api/connected-apps/gmail")
    .send({ enabled: true });
  expect(enable.status).toBe(200);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    throw new Error(`network disabled in tests: ${String(url)}`);
  });
  executeMock.mockReset();
  executeMock.mockResolvedValue({
    ok: true,
    summary: "Message sent (id msg-123).",
  });
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  clearGoogleTokenCache();
  clearProviderCaches();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const [appId, original] of touchedSettings) {
    if (original === null) {
      await db
        .delete(workspaceConnectedAppsTable)
        .where(
          and(
            eq(workspaceConnectedAppsTable.workspaceId, workspaceId),
            eq(workspaceConnectedAppsTable.app, appId),
          ),
        );
    } else {
      await db
        .insert(workspaceConnectedAppsTable)
        .values({
          workspaceId,
          app: appId,
          enabled: original.enabled,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            workspaceConnectedAppsTable.workspaceId,
            workspaceConnectedAppsTable.app,
          ],
          set: { enabled: original.enabled, updatedAt: new Date() },
        });
    }
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(appActionsTable)
      .where(inArray(appActionsTable.agentId, createdAgentIds));
    await db
      .delete(approvalsTable)
      .where(inArray(approvalsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Audit rows are hash-chained and append-only; deleting the isolated test
  // workspace removes its whole chain without touching another workspace.
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await pool.end();
});

describe("approval-gated write, end to end", () => {
  it("parks on write, then after approval the worker claims, executes once, and the model resumes with the verified result", async () => {
    const agent = await createAgent("Sender", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval, action } = await parkOnWrite(agent.id);
    expect(executeMock).not.toHaveBeenCalled();

    await approve(approval.id);
    expect((await getTaskRow(task.id))?.status).toBe("queued");
    const [approvedAction] = await getActions(task.id);
    expect(approvedAction?.status).toBe("approved");

    // The real claim path, scoped so no live work is stolen.
    const scope = { agentIds: [agent.id], includePausedAgents: true };
    const claimed = await claimNextTask(scope);
    expect(claimed?.task.id).toBe(task.id);

    const roundsBeforeResume = completionCalls().length;
    queueCompletions([completion("The email went out; objective complete.")]);
    await runTask(claimed!);

    // The stored action — operation, params and all — ran exactly once.
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [opArg, paramsArg, contextArg] = executeMock.mock.calls[0]!;
    expect((opArg as { name: string }).name).toBe("gmail.send_email");
    expect(paramsArg).toEqual(SEND_EMAIL_PARAMS);
    expect(contextArg).toEqual({ actionId: action.id, workspaceId });

    const [executed] = await getActions(task.id);
    expect(executed?.id).toBe(action.id);
    expect(executed?.status).toBe("executed");
    expect(executed?.resultSummary).toBe("Message sent (id msg-123).");

    // The model resumed in a single fresh round with the server-verified
    // result in its prompt.
    expect(completionCalls()).toHaveLength(roundsBeforeResume + 1);
    const prompt = lastPromptSent();
    expect(prompt).toContain("CONNECTED-APP ACTION RESULTS");
    expect(prompt).toContain("SUCCESS");
    expect(prompt).toContain("Message sent (id msg-123).");

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("objective complete");
  });

  it("claims an approved action exactly once when two workers race, and never re-executes it afterwards", async () => {
    const agent = await createAgent("Racer", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval, action } = await parkOnWrite(agent.id);
    await approve(approval.id);

    // Two workers race on the same approved action: the guarded UPDATE
    // lets exactly one of them move approved → executing.
    const [first, second] = await Promise.all([
      claimApprovedAction(action.id),
      claimApprovedAction(action.id),
    ]);
    const winners = [first, second].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(action.id);
    expect(winners[0]!.status).toBe("executing");
    expect(winners[0]!.params).toEqual(SEND_EMAIL_PARAMS);

    // The winner executes; a third claim attempt gets nothing.
    await executeClaimedAction(winners[0]!, "Racer", workspaceId);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(await claimApprovedAction(action.id)).toBeNull();

    // A worker picking the task up afterwards finds nothing approved left
    // to run and resumes the model with the settled result — the send is
    // not repeated.
    const claimed = await claimNextTask({
      agentIds: [agent.id],
      includePausedAgents: true,
    });
    expect(claimed?.task.id).toBe(task.id);
    queueCompletions([completion("Confirmed, all done.")]);
    await runTask(claimed!);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [finalAction] = await getActions(task.id);
    expect(finalAction?.status).toBe("executed");
    expect(lastPromptSent()).toContain("SUCCESS");
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });

  it("denies an approved action when the grant was revoked between approval and execution", async () => {
    const agent = await createAgent("Revoked", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval, action } = await parkOnWrite(agent.id);
    await approve(approval.id);

    // Revoke-after-approval: the owner strips the grant while the task
    // sits queued.
    const revoke = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ appGrants: [] });
    expect(revoke.status).toBe(200);

    const claimed = await claimNextTask({
      agentIds: [agent.id],
      includePausedAgents: true,
    });
    expect(claimed?.task.id).toBe(task.id);
    queueCompletions([completion("Understood, I will not send it.")]);
    await runTask(claimed!);

    // Approval was necessary but not sufficient: fresh grants win.
    expect(executeMock).not.toHaveBeenCalled();
    const [denied] = await getActions(task.id);
    expect(denied?.id).toBe(action.id);
    expect(denied?.status).toBe("denied");
    expect(denied?.errorMessage).toMatch(/no access/i);
    // The model was told the action was refused, not that it ran.
    expect(lastPromptSent()).toContain("DENIED");
    const logs = await getLogs(task.id);
    expect(logs.some((l) => l.message.includes("was NOT run"))).toBe(true);
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });

  it("never executes an approved write for a task cancelled after approval", async () => {
    const agent = await createAgent("Cancelled", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval } = await parkOnWrite(agent.id);
    await approve(approval.id);

    const cancel = await request(app).post(`/api/tasks/${task.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect((await getTaskRow(task.id))?.status).toBe("cancelled");

    // The write only ever runs inside a claimed task attempt, and a
    // cancelled task is never claimable — even with the widest test scope.
    expect(
      await claimNextTask({ agentIds: [agent.id], includePausedAgents: true }),
    ).toBeNull();
    const [action] = await getActions(task.id);
    expect(action?.status).toBe("approved");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("never executes an approved write after the agent is archived", async () => {
    const agent = await createAgent("Archived", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval } = await parkOnWrite(agent.id);
    await approve(approval.id);

    const archive = await request(app)
      .post(`/api/agents/${agent.id}/archive`)
      .send({ archived: true });
    expect(archive.status).toBe(200);

    // Archiving blocks the queued task and removes the agent from every
    // claim, so the approved write has no path to execution.
    const row = await getTaskRow(task.id);
    expect(row?.status).toBe("blocked");
    expect(row?.errorKind).toBe("agent_archived");
    expect(
      await claimNextTask({ agentIds: [agent.id], includePausedAgents: true }),
    ).toBeNull();
    const [action] = await getActions(task.id);
    expect(action?.status).toBe("approved");
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("sensitive data sandbox at the worker boundary", () => {
  it("lets a sandboxed agent read but denies its draft/write requests, executing nothing external", async () => {
    const agent = await createAgent("Vaulted", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const patched = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(patched.status).toBe(200);
    expect(patched.body.sensitiveDataSandbox).toBe(true);

    const task = await insertRunningTask(agent.id);
    const readBlock = `Reading first.\n<app_action>${JSON.stringify(
      { operation: "gmail.search", params: { query: "from:alice" } },
    )}</app_action>`;
    executeMock.mockResolvedValue({ ok: true, summary: "2 messages found." });
    queueCompletions([
      completion(readBlock),
      completion(SEND_EMAIL_BLOCK),
      completion("Understood; here is my summary instead."),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    // The read ran; the send was denied without ever parking for approval.
    expect(executeMock).toHaveBeenCalledTimes(1);
    const actions = await getActions(task.id);
    const read = actions.find((a) => a.operation === "gmail.search");
    const send = actions.find((a) => a.operation === "gmail.send_email");
    expect(read?.status).toBe("executed");
    expect(send?.status).toBe("denied");
    expect(send?.errorMessage).toMatch(/sensitive data sandbox/i);
    expect(await getPendingApproval(task.id)).toBeFalsy();
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });

  it("denies a write when the sandbox is enabled while the model is mid-run", async () => {
    const agent = await createAgent("Flipped Midrun", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const task = await insertRunningTask(agent.id);

    // The attempt starts with the sandbox OFF: the agent snapshot and the
    // grants loaded at attempt start would both allow the send. The owner
    // flips the sandbox ON while the provider is producing the round that
    // requests the write — modelled by toggling the flag inside the fetch
    // mock, before the completion carrying the action block is returned.
    const bodies = [completion(SEND_EMAIL_BLOCK), completion("Understood.")];
    let flipped = false;
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify(PRICING_CATALOG), {
          headers: { "content-type": "application/json" },
        });
      }
      if (!flipped) {
        flipped = true;
        await db
          .update(agentsTable)
          .set({ sensitiveDataSandbox: true })
          .where(eq(agentsTable.id, agent.id));
      }
      const next = bodies.shift();
      if (next === undefined) throw new Error("unexpected fetch in test");
      return new Response(JSON.stringify(next), {
        headers: { "content-type": "application/json" },
      });
    });

    await runTask({ task, agent: await loadAgent(agent.id) });

    // The per-round refresh caught the toggle: nothing external ran and
    // the write never even parked for approval.
    expect(executeMock).not.toHaveBeenCalled();
    const [action] = await getActions(task.id);
    expect(action?.operation).toBe("gmail.send_email");
    expect(action?.status).toBe("denied");
    expect(action?.errorMessage).toMatch(/sensitive data sandbox/i);
    expect(await getPendingApproval(task.id)).toBeFalsy();
    const logs = await getLogs(task.id);
    expect(
      logs.some((l) => l.message.includes("enabled mid-run")),
    ).toBe(true);
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });

  it("denies a previously approved write once the sandbox is switched on", async () => {
    const agent = await createAgent("Locked Later", [
      { app: "gmail", accessLevel: "write" },
    ]);
    const { task, approval, action } = await parkOnWrite(agent.id);
    await approve(approval.id);

    // The owner flips the sandbox on while the approved task sits queued.
    const lockdown = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(lockdown.status).toBe(200);

    const claimed = await claimNextTask({
      agentIds: [agent.id],
      includePausedAgents: true,
    });
    expect(claimed?.task.id).toBe(task.id);
    queueCompletions([completion("Understood, I will not send it.")]);
    await runTask(claimed!);

    // Fresh re-authorization wins over the stale approval.
    expect(executeMock).not.toHaveBeenCalled();
    const [denied] = await getActions(task.id);
    expect(denied?.id).toBe(action.id);
    expect(denied?.status).toBe("denied");
    expect(denied?.errorMessage).toMatch(/sensitive data sandbox/i);
    const logs = await getLogs(task.id);
    expect(logs.some((l) => l.message.includes("was NOT run"))).toBe(true);
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });
});

describe("multi-round budget ceiling", () => {
  it("stops a follow-up action round before dispatch once the ceiling is spent", async () => {
    const agent = await createAgent("Frugal", [
      { app: "gmail", accessLevel: "read" },
    ]);
    // 2¢ ceiling. Round one reports 10k prompt + 1.5k completion tokens:
    // at 0.0001¢/prompt-token and 0.001¢/completion-token that is 2.5¢ —
    // past the ceiling before any second round could be dispatched.
    const task = await insertRunningTask(agent.id, { budgetCents: 2 });
    const readBlock = `Checking the mailbox first.\n<app_action>${JSON.stringify(
      { operation: "gmail.search", params: { query: "from:alice" } },
    )}</app_action>`;
    queueCompletions([
      completion(readBlock, { prompt_tokens: 10_000, completion_tokens: 1_500 }),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    // Exactly one provider round; the requested action was never dispatched.
    expect(completionCalls()).toHaveLength(1);
    expect(executeMock).not.toHaveBeenCalled();
    expect(await getActions(task.id)).toHaveLength(0);

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("the task's budget was already spent");
    const logs = await getLogs(task.id);
    expect(
      logs.some((l) => l.message.includes("The budget ceiling was reached")),
    ).toBe(true);
  });
});
