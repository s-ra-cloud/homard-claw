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
 *  - a run that exhausts every bounded action round with well-formed work
 *    remaining parks for an owner-approved continuation instead of
 *    completing; approval resumes the SAME task for one more bounded
 *    segment with prior verified results and a cumulative usage ledger,
 *    rejection ends it cleanly, and repeated limits pause again
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
import { ApprovalDecisionError, decideApproval } from "../approvals";
import { claimNextTask, runTask } from "../worker";
import { claimApprovedAction, executeClaimedAction } from "../connected-apps/actions";
import {
  clearGoogleTokenCache,
  encryptRefreshToken,
} from "../google/credentials";
import { clearProviderCaches } from "../providers";
import { saveProviderCredential } from "../provider-credentials";

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

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    throw new Error(`network disabled in tests: ${String(url)}`);
  });
  executeMock.mockReset();
  executeMock.mockResolvedValue({
    ok: true,
    summary: "Message sent (id msg-123).",
  });
  // Provider credentials are workspace rows now, not env vars. This suite
  // owns its workspace, so cascade deletion cleans the row up.
  await saveProviderCredential(workspaceId, "openrouter", "test-openrouter-key");
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

describe("malformed action recovery", () => {
  // Invalid JSON: bare identifiers, no quotes.
  const BAD_JSON_BLOCK =
    "Searching now.\n<app_action>{operation: gmail.search}</app_action>";
  // Valid JSON, but no operation name — nothing to even authorize.
  const NO_OPERATION_BLOCK =
    'Trying again.\n<app_action>{"params":{"query":"from:alice"}}</app_action>';
  const READ_BLOCK = `Searching properly.\n<app_action>${JSON.stringify({
    operation: "gmail.search",
    params: { query: "from:alice" },
  })}</app_action>`;

  it("fails the task when every round's action request stays malformed", async () => {
    const agent = await createAgent("Garbled", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const task = await insertRunningTask(agent.id);
    // The model never corrects itself: malformed blocks in every round the
    // loop allows (MAX_ACTION_ROUNDS = 4).
    queueCompletions([
      completion(BAD_JSON_BLOCK),
      completion(NO_OPERATION_BLOCK),
      completion(BAD_JSON_BLOCK),
      completion(BAD_JSON_BLOCK),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    // Every bounded corrective round was used, nothing was ever executed,
    // and no action row was invented for an unparseable request.
    expect(completionCalls()).toHaveLength(4);
    expect(executeMock).not.toHaveBeenCalled();
    expect(await getActions(task.id)).toHaveLength(0);

    // The final prompt carried the precise validation feedback back.
    const prompt = lastPromptSent();
    expect(prompt).toContain("MALFORMED REQUEST — NOT EXECUTED");
    expect(prompt).toMatch(/not valid JSON/i);

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("failed");
    expect(done?.errorKind).toBe("malformed_app_actions");
    expect(done?.errorMessage).toMatch(/no connected-app action was executed/i);
    const logs = await getLogs(task.id);
    expect(
      logs.some((l) =>
        l.message.includes("Rejected a malformed connected-app action request"),
      ),
    ).toBe(true);
  });

  it("does not let a confident prose answer mask that no action ever ran", async () => {
    const agent = await createAgent("Bluffer", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const task = await insertRunningTask(agent.id);
    queueCompletions([
      completion(NO_OPERATION_BLOCK),
      completion("All done — I searched the mailbox and found nothing relevant."),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    expect(executeMock).not.toHaveBeenCalled();
    expect(await getActions(task.id)).toHaveLength(0);
    const done = await getTaskRow(task.id);
    // The prose is preserved for context, but the status tells the truth.
    expect(done?.status).toBe("failed");
    expect(done?.errorKind).toBe("malformed_app_actions");
    expect(done?.errorMessage).toMatch(/no connected-app action was executed/i);
    expect(done?.output).toContain("All done");
  });

  it("recovers when the model corrects the block in a later round", async () => {
    const agent = await createAgent("Corrected", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const task = await insertRunningTask(agent.id);
    executeMock.mockResolvedValue({ ok: true, summary: "2 messages found." });
    queueCompletions([
      completion(BAD_JSON_BLOCK),
      completion(READ_BLOCK),
      completion("Found the thread; objective complete."),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    // Round two was prompted with the validation error it then corrected.
    const calls = completionCalls();
    expect(calls).toHaveLength(3);
    const secondPrompt = String(
      (calls[1] as [unknown, { body?: string }])[1]?.body ?? "",
    );
    expect(secondPrompt).toContain("MALFORMED REQUEST");

    expect(executeMock).toHaveBeenCalledTimes(1);
    const actions = await getActions(task.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.operation).toBe("gmail.search");
    expect(actions[0]?.status).toBe("executed");

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("objective complete");
  });

  it("completes a mixed round by running the valid request and reporting the malformed one", async () => {
    const agent = await createAgent("Mixed", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const task = await insertRunningTask(agent.id);
    executeMock.mockResolvedValue({ ok: true, summary: "2 messages found." });
    queueCompletions([
      completion(`${READ_BLOCK}\n<app_action>not json</app_action>`),
      completion("Here is the summary."),
    ]);

    await runTask({ task, agent: await loadAgent(agent.id) });

    // The valid request ran; the malformed one produced feedback, not an
    // action row and not a guess.
    expect(executeMock).toHaveBeenCalledTimes(1);
    const actions = await getActions(task.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("executed");
    const prompt = lastPromptSent();
    expect(prompt).toContain("MALFORMED REQUEST");
    expect(prompt).toContain("SUCCESS");
    expect((await getTaskRow(task.id))?.status).toBe("completed");
  });
});

describe("round-limit continuation approval", () => {
  const CONTINUE_READ_BLOCK = `Searching further.\n<app_action>${JSON.stringify(
    { operation: "gmail.search", params: { query: "kelp" } },
  )}</app_action>`;

  /**
   * Drive a segment that spends every bounded action round on well-formed
   * reads: rounds 1-3 execute, round 4 still requests more work, so the
   * task must park for an owner-approved continuation. Returns the parked
   * task row and its pending continuation approval.
   */
  async function parkOnRoundLimit(
    agentId: string,
    taskOverrides: Partial<typeof tasksTable.$inferInsert> = {},
    usage?: { prompt_tokens: number; completion_tokens: number },
  ) {
    const task = await insertRunningTask(agentId, taskOverrides);
    executeMock.mockResolvedValue({ ok: true, summary: "2 messages found." });
    queueCompletions([
      completion(CONTINUE_READ_BLOCK, usage),
      completion(CONTINUE_READ_BLOCK, usage),
      completion(CONTINUE_READ_BLOCK, usage),
      completion(CONTINUE_READ_BLOCK, usage),
    ]);
    await runTask({ task, agent: await loadAgent(agentId) });
    const parked = await getTaskRow(task.id);
    const approval = await getPendingApproval(task.id);
    return { task: parked!, approval };
  }

  async function resume(agentId: string, taskId: string) {
    const claimed = await claimNextTask({
      agentIds: [agentId],
      includePausedAgents: true,
    });
    expect(claimed?.task.id).toBe(taskId);
    await runTask(claimed!);
  }

  it("parks at the round limit with the work, usage, and a continuation approval preserved", async () => {
    const agent = await createAgent("Marathon", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);

    // Not completed with unrun requests: waiting, attempt refunded, and
    // the pause is counted so the next attempt knows it is a continuation.
    expect(task.status).toBe("waiting_approval");
    expect(task.attempts).toBe(0);
    expect(task.continuationSegments).toBe(1);
    expect(task.output).toContain("Paused");
    expect(task.output).toContain("waiting for the owner's approval");

    // Exactly the first three rounds executed; the fourth round's request
    // was never authorized or run.
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(completionCalls()).toHaveLength(4);
    const actions = await getActions(task.id);
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.status === "executed")).toBe(true);

    // The durable approval is the continuation kind, not an action gate.
    expect(approval).toBeTruthy();
    expect(approval!.kind).toBe("task_continuation");
    expect(approval!.action).toContain("Continue task:");
    expect(approval!.details).toMatch(/one more bounded segment/i);

    // Usage from the finished segment is recorded before the pause: four
    // rounds at 1000 prompt + 100 completion tokens, 0.2¢ each.
    expect(task.actualInputTokens).toBe(4000);
    expect(task.actualOutputTokens).toBe(400);
    expect(task.actualCostCents).toBeCloseTo(0.8, 5);

    const logs = await getLogs(task.id);
    expect(
      logs.some((l) =>
        l.message.includes("Waiting for your approval to continue"),
      ),
    ).toBe(true);

    // The task detail API exposes the pause distinguishably for clients.
    const detail = await request(app).get(`/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.pendingApproval?.id).toBe(approval!.id);
    expect(detail.body.pendingApproval?.kind).toBe("task_continuation");
    expect(detail.body.task.continuationSegments).toBe(1);
    expect(detail.body.task.status).toBe("waiting_approval");
  });

  it("resumes the same task after approval with prior results and a cumulative usage ledger, never replaying executed actions", async () => {
    const agent = await createAgent("Resumer", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);
    await approve(approval!.id);
    expect((await getTaskRow(task.id))?.status).toBe("queued");

    // The resumed segment finishes the remaining read and wraps up.
    queueCompletions([
      completion(CONTINUE_READ_BLOCK),
      completion("Compiled the kelp digest; objective complete."),
    ]);
    await resume(agent.id, task.id);

    // One more execution — the three settled reads were not replayed.
    expect(executeMock).toHaveBeenCalledTimes(4);
    const actions = await getActions(task.id);
    expect(actions).toHaveLength(4);
    expect(actions.every((a) => a.status === "executed")).toBe(true);

    // The resumed model saw the server-verified history of the earlier
    // segment in its prompt.
    const prompt = lastPromptSent();
    expect(prompt).toContain("CONNECTED-APP ACTION RESULTS");
    expect(prompt).toContain("SUCCESS");

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("objective complete");
    // Cumulative ledger: 4 parked rounds + 2 resumed rounds of
    // 1000/100 tokens — the pause did not erase the earlier spend.
    expect(done?.actualInputTokens).toBe(6000);
    expect(done?.actualOutputTokens).toBe(600);
    expect(done?.actualCostCents).toBeCloseTo(1.2, 5);
    expect(done?.continuationSegments).toBe(1);

    const logs = await getLogs(task.id);
    expect(
      logs.some((l) => l.message.includes("Continuation approved")),
    ).toBe(true);
  });

  it("pauses again for a fresh approval when the resumed segment hits the limit too", async () => {
    const agent = await createAgent("Repeater", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);
    await approve(approval!.id);

    // The resumed segment burns all four rounds on well-formed reads again.
    queueCompletions([
      completion(CONTINUE_READ_BLOCK),
      completion(CONTINUE_READ_BLOCK),
      completion(CONTINUE_READ_BLOCK),
      completion(CONTINUE_READ_BLOCK),
    ]);
    await resume(agent.id, task.id);

    const parkedAgain = await getTaskRow(task.id);
    expect(parkedAgain?.status).toBe("waiting_approval");
    expect(parkedAgain?.continuationSegments).toBe(2);
    // No indefinite continuation: a NEW pending approval, not a reuse of
    // the decided one.
    const second = await getPendingApproval(task.id);
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(approval!.id);
    expect(second!.kind).toBe("task_continuation");

    // Segment two executed its first three rounds; six settled in total.
    expect(executeMock).toHaveBeenCalledTimes(6);
    expect(await getActions(task.id)).toHaveLength(6);
    // The ledger kept accumulating across both segments.
    expect(parkedAgain?.actualInputTokens).toBe(8000);
    expect(parkedAgain?.actualOutputTokens).toBe(800);
    expect(parkedAgain?.actualCostCents).toBeCloseTo(1.6, 5);
  });

  it("ends the task cleanly when the continuation is rejected, keeping the completed work", async () => {
    const agent = await createAgent("Declined", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);

    const res = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "rejected" });
    expect(res.status).toBe(200);

    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.errorKind).toBe("continuation_rejected");
    expect(done?.errorMessage).toMatch(/work completed so far/i);
    // The partial output survives the rejection.
    expect(done?.output).toContain("Paused");

    // A rejected continuation is never claimable again.
    expect(
      await claimNextTask({ agentIds: [agent.id], includePausedAgents: true }),
    ).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(3);

    const logs = await getLogs(task.id);
    expect(
      logs.some((l) => l.message.includes("Continuation rejected")),
    ).toBe(true);
  });

  it("refuses a continuation decision from another workspace and a duplicate decision", async () => {
    const agent = await createAgent("Fenced", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);

    // A foreign workspace cannot decide it, no matter how it calls in.
    const [foreign] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `continuation-foreign-${Date.now()}` })
      .returning();
    try {
      await expect(
        decideApproval({
          workspaceId: foreign.id,
          approvalId: approval!.id,
          decision: "approved",
        }),
      ).rejects.toThrow(ApprovalDecisionError);
    } finally {
      await db
        .delete(workspacesTable)
        .where(eq(workspacesTable.id, foreign.id));
    }
    // Untouched: still pending, task still waiting.
    expect((await getPendingApproval(task.id))?.id).toBe(approval!.id);
    expect((await getTaskRow(task.id))?.status).toBe("waiting_approval");

    // A stale duplicate decision after the real one is a 404, not a
    // second requeue.
    await approve(approval!.id);
    const dup = await request(app)
      .patch(`/api/approvals/${approval!.id}`)
      .send({ decision: "rejected" });
    expect(dup.status).toBe(404);
    expect((await getTaskRow(task.id))?.status).toBe("queued");
  });

  it("re-checks the remaining budget on resume and blocks instead of granting the ceiling afresh", async () => {
    const agent = await createAgent("Ceilinged", [
      { app: "gmail", accessLevel: "read" },
    ]);
    // 2¢ budget; each round reports 4000 prompt + 80 completion tokens
    // (0.48¢), so the parked segment records 1.92¢ and only 0.08¢ remains.
    // The long objective makes the resume preflight prompt alone cost more
    // than that remainder.
    const { task, approval } = await parkOnRoundLimit(
      agent.id,
      {
        budgetCents: 2,
        objective: `${RUN_TAG} kelp census ${"survey the beds thoroughly ".repeat(200)}`,
      },
      { prompt_tokens: 4000, completion_tokens: 80 },
    );
    expect(task.status).toBe("waiting_approval");
    expect(task.actualCostCents).toBeCloseTo(1.92, 5);
    await approve(approval!.id);

    const completionsBefore = completionCalls().length;
    await resume(agent.id, task.id);

    // Preflight subtracted the earlier segments' spend: nothing was
    // dispatched and nothing external ran in the resumed segment.
    expect(completionCalls()).toHaveLength(completionsBefore);
    expect(executeMock).toHaveBeenCalledTimes(3);
    const blocked = await getTaskRow(task.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.errorKind).toBe("budget");
    expect(blocked?.continuationSegments).toBe(1);
  });

  it("denies resumed requests when the app grant was revoked after the continuation was approved", async () => {
    const agent = await createAgent("Ungrannted", [
      { app: "gmail", accessLevel: "read" },
    ]);
    const { task, approval } = await parkOnRoundLimit(agent.id);
    await approve(approval!.id);

    // The owner strips the grant while the approved continuation waits.
    const revoke = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ appGrants: [] });
    expect(revoke.status).toBe(200);

    queueCompletions([completion(CONTINUE_READ_BLOCK)]);
    await resume(agent.id, task.id);

    // Approval to continue is not approval to act: with no grant, nothing
    // external ran in the resumed segment and no action row was added.
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(await getActions(task.id)).toHaveLength(3);
    const done = await getTaskRow(task.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("no app access");
  });
});
