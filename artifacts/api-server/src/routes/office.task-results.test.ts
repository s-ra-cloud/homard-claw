/**
 * Internal read capability over stored completed-task results.
 *
 * Proves, against the real dev Postgres, that a non-sandboxed agent can
 * search and read the office's completed task results — during normal task
 * execution (worker action loop) and during Talk conversations — and that
 * every boundary holds:
 *
 *  - retrieval is accurate: stored outputs come back with task identity,
 *    agent name, and completion time for attribution
 *  - query / agent / date filtering and empty results behave sensibly
 *  - responses are bounded and paginated so histories cannot overflow
 *  - sandboxed callers are denied, and results produced by a sandboxed
 *    agent are invisible to everyone
 *  - workspace isolation is strict in both directions (search and read)
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): this
 * suite owns its workspaces (cascade cleans credentials), keeps agents
 * paused so the live dev worker never claims their tasks, stubs all
 * provider traffic through the global fetch mock, and tags + cleans all
 * rows.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  pool,
  taskLogsTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-task-results-owner" as string | null,
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

import officeRouter from "./office";
import { runTask } from "../worker";
import {
  collectTaskResultsForTalk,
  executeTaskResultRead,
  TALK_RESULT_MAX_RECORDS,
  TASK_RESULT_READ_OPERATION,
  TASK_RESULT_SEARCH_OPERATION,
} from "../task-results";
import { TZDate } from "@date-fns/tz";
import { clearProviderCaches } from "../providers";
import { saveProviderCredential } from "../provider-credentials";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC TaskResults ${Date.now()}`;
const createdAgentIds: string[] = [];
let workspaceId: string;
let otherWorkspaceId: string;
let mainClerkUserId: string;
let otherClerkUserId: string;

async function createAgent(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name: `${name} ${RUN_TAG}`,
      title: "Task Records Tester",
      mission: "Exercise the office task-record read capability.",
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
      ...extra,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused: the live dev worker must never claim this agent's tasks.
  const paused = await request(app)
    .post(`/api/agents/${res.body.id}/pause`)
    .send({ paused: true });
  expect(paused.status).toBe(200);
  return res.body as { id: string; name: string };
}

async function loadAgent(agentId: string) {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return agent!;
}

async function setSandbox(agentId: string, sandboxed: boolean) {
  await db
    .update(agentsTable)
    .set({ sensitiveDataSandbox: sandboxed })
    .where(eq(agentsTable.id, agentId));
}

/** Insert a completed task with stored output directly, workspace stamped. */
async function insertCompletedTask(
  agentId: string,
  wsId: string,
  values: { objective: string; output: string; finishedAt?: Date },
) {
  const [taskRow] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId: wsId,
      objective: `${RUN_TAG} ${values.objective}`,
      output: values.output,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "completed",
      attempts: 1,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: values.finishedAt ?? new Date(),
    })
    .returning();
  return taskRow!;
}

async function insertRunningTask(agentId: string, objective: string) {
  const [taskRow] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId,
      objective: `${RUN_TAG} ${objective}`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "running",
      attempts: 1,
      startedAt: new Date(),
      estimatedCostCents: 1,
    })
    .returning();
  return taskRow!;
}

function utcDayStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Noon UTC of the current day: an anchor for "same day" fixtures so
 * minute-scale offsets can never cross a midnight boundary mid-test.
 */
function utcNoonToday(): Date {
  return new Date(`${utcDayStr(new Date())}T12:00:00.000Z`);
}

function caller(overrides: Partial<Parameters<typeof executeTaskResultRead>[0]> = {}) {
  return {
    workspaceId,
    agentId: createdAgentIds[0] ?? "unused",
    sensitiveDataSandbox: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

function completion(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
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

function completionBody(index: number): string {
  const calls = completionCalls();
  const [, init] = calls[index] as [unknown, { body?: string }];
  return String(init?.body ?? "");
}

const SEARCH_BLOCK = (params: Record<string, unknown>) =>
  `<app_action>${JSON.stringify({
    operation: TASK_RESULT_SEARCH_OPERATION,
    params,
  })}</app_action>`;

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "task-results-test-secret");
  mainClerkUserId = `task-results-owner-${Date.now()}`;
  otherClerkUserId = `task-results-other-${Date.now()}`;
  const [workspaceRow] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: mainClerkUserId })
    .returning();
  const workspace = workspaceRow!;
  workspaceId = workspace.id;
  const [otherRow] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: otherClerkUserId })
    .returning();
  const other = otherRow!;
  otherWorkspaceId = other.id;
  authState.userId = mainClerkUserId;
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    throw new Error(`network disabled in tests: ${String(url)}`);
  });
  authState.userId = mainClerkUserId;
  await saveProviderCredential(workspaceId, "openrouter", "test-openrouter-key");
  await saveProviderCredential(
    otherWorkspaceId,
    "openrouter",
    "test-openrouter-key",
  );
  clearProviderCaches();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (createdAgentIds.length > 0) {
    const taskIds = (
      await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(inArray(tasksTable.agentId, createdAgentIds))
    ).map((row) => row.id);
    if (taskIds.length > 0) {
      await db
        .delete(taskLogsTable)
        .where(inArray(taskLogsTable.taskId, taskIds));
    }
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  // Isolated test workspaces: deleting them cascades their remaining rows
  // (credentials, settings, audit chain) without touching anyone else's.
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, otherWorkspaceId));
  await pool.end();
});

describe("task-result search and read service", () => {
  it("finds stored results by search terms with attribution, and reads full detail by id", async () => {
    const ada = await createAgent("Ada");
    const hit = await insertCompletedTask(ada.id, workspaceId, {
      objective: "scan the inbox for kelp invoices",
      output:
        "Found 3 emails from Kelp Co about overdue invoices totalling $500.",
    });
    await insertCompletedTask(ada.id, workspaceId, {
      objective: "water the office plants",
      output: "Watered 12 office plants; the fern needs repotting.",
    });

    const search = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "kelp invoices emails" },
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    // Attribution: task identity, agent name, and completion time.
    expect(search.summary).toContain(hit.id);
    expect(search.summary).toContain(ada.name);
    expect(search.summary).toContain(hit.finishedAt!.toISOString());
    expect(search.summary).toContain("Found 3 emails from Kelp Co");
    expect(search.summary).not.toContain("Watered 12 office plants");

    const detail = await executeTaskResultRead(
      caller(),
      TASK_RESULT_READ_OPERATION,
      { taskId: hit.id },
    );
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.summary).toContain(
      "Found 3 emails from Kelp Co about overdue invoices totalling $500.",
    );
    expect(detail.summary).toContain(ada.name);

    // Incomplete tasks are never readable, even by id.
    const running = await insertRunningTask(ada.id, "still going");
    const unfinished = await executeTaskResultRead(
      caller(),
      TASK_RESULT_READ_OPERATION,
      { taskId: running.id },
    );
    expect(unfinished.ok).toBe(false);
  });

  it("filters by agent name and by date range", async () => {
    const maple = await createAgent("Maple");
    const birch = await createAgent("Birch");
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const recent = await insertCompletedTask(maple.id, workspaceId, {
      objective: "count the plankton drift",
      output: "Plankton drift census: 900 clusters near the north reef.",
      finishedAt: now,
    });
    const old = await insertCompletedTask(birch.id, workspaceId, {
      objective: "count the plankton drift again",
      output: "Plankton drift census: 40 clusters near the south reef.",
      finishedAt: tenDaysAgo,
    });

    const byAgent = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "plankton drift census", agentName: maple.name },
    );
    expect(byAgent.ok).toBe(true);
    if (!byAgent.ok) return;
    expect(byAgent.summary).toContain(recent.id);
    expect(byAgent.summary).not.toContain(old.id);

    const sinceCutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const bySince = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "plankton drift census", since: sinceCutoff },
    );
    expect(bySince.ok).toBe(true);
    if (!bySince.ok) return;
    expect(bySince.summary).toContain(recent.id);
    expect(bySince.summary).not.toContain(old.id);

    // A date-only "until" is inclusive of that whole day.
    const untilToday = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      {
        query: "plankton drift census",
        until: now.toISOString().slice(0, 10),
      },
    );
    expect(untilToday.ok).toBe(true);
    if (!untilToday.ok) return;
    expect(untilToday.summary).toContain(recent.id);
    expect(untilToday.summary).toContain(old.id);
  });

  it("returns a clear empty-results message and rejects invalid params", async () => {
    const empty = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "zebra unicorn contrabassoon" },
    );
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.summary).toContain("No completed task results matched");

    const badDate = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { since: "not-a-date" },
    );
    expect(badDate.ok).toBe(false);
    if (badDate.ok) return;
    expect(badDate.message).toContain("since");

    const badPage = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { page: 0 },
    );
    expect(badPage.ok).toBe(false);

    const badId = await executeTaskResultRead(
      caller(),
      TASK_RESULT_READ_OPERATION,
      { taskId: "not-a-uuid" },
    );
    expect(badId.ok).toBe(false);
  });

  it("bounds and paginates large histories", async () => {
    const scribe = await createAgent("Scribe");
    const longOutput = `Nautilus ledger reconciliation report. ${"Every shell account was rebalanced against the tide charts. ".repeat(60)}`;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const task = await insertCompletedTask(scribe.id, workspaceId, {
        objective: `nautilus ledger reconciliation ${i}`,
        output: longOutput,
        finishedAt: new Date(Date.now() - i * 60_000),
      });
      ids.push(task.id);
    }

    const pageOne = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "nautilus ledger reconciliation" },
    );
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) return;
    expect(pageOne.summary).toContain("Found 7 completed task result(s)");
    expect(pageOne.summary).toContain("Showing 1–5 of 7");
    expect(pageOne.summary).toContain("(truncated;");
    // Bounded: even 7 multi-kilobyte outputs cannot overflow a prompt.
    expect(pageOne.summary.length).toBeLessThan(6000);
    const shown = ids.filter((id) => pageOne.summary.includes(id));
    expect(shown).toHaveLength(5);

    const pageTwo = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "nautilus ledger reconciliation", page: 2 },
    );
    expect(pageTwo.ok).toBe(true);
    if (!pageTwo.ok) return;
    const shownTwo = ids.filter((id) => pageTwo.summary.includes(id));
    expect(shownTwo).toHaveLength(2);
    expect(shownTwo.every((id) => !shown.includes(id))).toBe(true);
  });

  it("denies sandboxed callers outright", async () => {
    const sandboxedSearch = await executeTaskResultRead(
      caller({ sensitiveDataSandbox: true }),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "anything" },
    );
    expect(sandboxedSearch.ok).toBe(false);
    if (sandboxedSearch.ok) return;
    expect(sandboxedSearch.kind).toBe("denied");
    expect(sandboxedSearch.message).toContain("sandbox");

    const sandboxedRead = await executeTaskResultRead(
      caller({ sensitiveDataSandbox: true }),
      TASK_RESULT_READ_OPERATION,
      { taskId: "00000000-0000-4000-8000-000000000000" },
    );
    expect(sandboxedRead.ok).toBe(false);
    if (sandboxedRead.ok) return;
    expect(sandboxedRead.kind).toBe("denied");
  });

  it("hides results produced by a currently sandboxed agent", async () => {
    const secretive = await createAgent("Secretive");
    const task = await insertCompletedTask(secretive.id, workspaceId, {
      objective: "audit the pearl vault",
      output: "Pearl vault audit: 14 pearls, one missing clasp.",
    });
    await setSandbox(secretive.id, true);

    const search = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "pearl vault audit" },
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.summary).toContain("No completed task results matched");

    const read = await executeTaskResultRead(
      caller(),
      TASK_RESULT_READ_OPERATION,
      { taskId: task.id },
    );
    expect(read.ok).toBe(false);
  });

  it("never crosses workspaces in either direction", async () => {
    // The foreign workspace gets its own agent and stored result.
    authState.userId = otherClerkUserId;
    const foreignAgent = await createAgent("Foreign");
    const foreignTask = await insertCompletedTask(
      foreignAgent.id,
      otherWorkspaceId,
      {
        objective: "chart the abyssal trench",
        output: "Abyssal trench charted: 3 new vents at 4,100 meters.",
      },
    );
    authState.userId = mainClerkUserId;

    const search = await executeTaskResultRead(
      caller(),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "abyssal trench vents" },
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.summary).toContain("No completed task results matched");

    // A foreign id reads as not-found — no existence leak.
    const read = await executeTaskResultRead(
      caller(),
      TASK_RESULT_READ_OPERATION,
      { taskId: foreignTask.id },
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain("No completed task result");

    // The rightful workspace still sees its own record.
    const home = await executeTaskResultRead(
      caller({ workspaceId: otherWorkspaceId, agentId: foreignAgent.id }),
      TASK_RESULT_SEARCH_OPERATION,
      { query: "abyssal trench vents" },
    );
    expect(home.ok).toBe(true);
    if (!home.ok) return;
    expect(home.summary).toContain(foreignTask.id);
  });
});

describe("worker task execution path", () => {
  it("lets a grantless agent search task records mid-run and completes with the results", async () => {
    const historian = await createAgent("Historian");
    await insertCompletedTask(historian.id, workspaceId, {
      objective: "run the kelp census",
      output: "The kelp census counted 4,200 healthy fronds in sector 7.",
    });
    const runner = await createAgent("Runner");
    const task = await insertRunningTask(
      runner.id,
      "summarize what the kelp census found",
    );
    queueCompletions([
      completion(
        `Checking the records.\n${SEARCH_BLOCK({ query: "kelp census fronds" })}`,
      ),
      completion("The kelp census found 4,200 healthy fronds in sector 7."),
    ]);
    await runTask({ task, agent: await loadAgent(runner.id) });

    const [done] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    expect(done?.status).toBe("completed");
    expect(done?.output).toContain("4,200 healthy fronds");
    expect(done?.output).not.toContain("<app_action>");

    // The capability was advertised, and the stored result was fed back to
    // the model before its final answer.
    expect(completionCalls()).toHaveLength(2);
    expect(completionBody(0)).toContain("OFFICE TASK RECORDS");
    expect(completionBody(1)).toContain("4,200 healthy fronds in sector 7");
    expect(completionBody(1)).toContain("Office task records");

    const logs = await db
      .select()
      .from(taskLogsTable)
      .where(eq(taskLogsTable.taskId, task.id));
    expect(
      logs.some((log) => log.message.includes("Read the office task records")),
    ).toBe(true);
  });

  it("keeps office task records away from a sandboxed agent's run", async () => {
    const keeper = await createAgent("Keeper");
    await insertCompletedTask(keeper.id, workspaceId, {
      objective: "tally the treasury",
      output: "Treasury tally: 88 doubloons in the anemone safe.",
    });
    const sandboxed = await createAgent("Cloistered");
    await setSandbox(sandboxed.id, true);
    const task = await insertRunningTask(sandboxed.id, "report the treasury tally");
    queueCompletions([
      completion(
        `Let me look that up.\n${SEARCH_BLOCK({ query: "treasury tally doubloons" })}`,
      ),
    ]);
    await runTask({ task, agent: await loadAgent(sandboxed.id) });

    const [done] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    expect(done?.status).toBe("completed");
    // The block was stripped, nothing ran, and nothing leaked.
    expect(done?.output).not.toContain("88 doubloons");
    expect(done?.output).not.toContain("<app_action>");
    expect(done?.output).toContain("office task records are not available");
    expect(completionCalls()).toHaveLength(1);
    // The capability is never advertised to a sandboxed agent.
    expect(completionBody(0)).not.toContain("OFFICE TASK RECORDS");
  });
});

describe("Talk conversation path", () => {
  it("answers the owner from stored task results", async () => {
    const finder = await createAgent("Finder");
    await insertCompletedTask(finder.id, workspaceId, {
      objective: "check this morning's inbox",
      output:
        "Found 3 emails from Kelp Co: two overdue invoices and one delivery note.",
    });
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "Let me check the office records.",
          taskObjective: null,
          agentRequest: null,
          taskResultsQuery: { query: "emails Kelp Co inbox" },
        }),
      ),
      completion(
        "We found 3 emails from Kelp Co today: two overdue invoices and a delivery note.",
      ),
    ]);

    const res = await request(app)
      .post(`/api/agents/${finder.id}/converse`)
      .send({ text: "What emails were found today?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(
      "We found 3 emails from Kelp Co today: two overdue invoices and a delivery note.",
    );
    // A lookup turn is never also a work proposal.
    expect(res.body.proposedTaskObjective).toBeNull();
    expect(completionCalls()).toHaveLength(2);
    // The compose round saw the actual stored records.
    expect(completionBody(1)).toContain("Found 3 emails from Kelp Co");
    // The lookup capability is offered in the Talk contract.
    expect(completionBody(0)).toContain("taskResultsQuery");
  });

  it("says so plainly when the records have no match", async () => {
    const seeker = await createAgent("Seeker");
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "Checking now.",
          taskObjective: null,
          agentRequest: null,
          taskResultsQuery: { query: "volcanic glass shipment manifest" },
        }),
      ),
      completion("I didn't find any completed task about that."),
    ]);

    const res = await request(app)
      .post(`/api/agents/${seeker.id}/converse`)
      .send({ text: "What did the volcanic glass shipment task find?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("I didn't find any completed task about that.");
    expect(completionBody(1)).toContain("No completed task results matched");
  });

  it("refuses a sandboxed agent's Talk lookup without reading anything", async () => {
    const open = await createAgent("Openbook");
    await insertCompletedTask(open.id, workspaceId, {
      objective: "log the coral bleaching survey",
      output: "Coral bleaching survey: 12% of the reef affected.",
    });
    const shut = await createAgent("Shutcase");
    await setSandbox(shut.id, true);
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "Let me check.",
          taskObjective: null,
          agentRequest: null,
          taskResultsQuery: { query: "coral bleaching survey" },
        }),
      ),
    ]);

    const res = await request(app)
      .post(`/api/agents/${shut.id}/converse`)
      .send({ text: "What did the coral survey find?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("sensitive data sandbox");
    expect(res.body.reply).not.toContain("12%");
    // No compose round, no query: the refusal happened before any read.
    expect(completionCalls()).toHaveLength(1);
    // Sandboxed prompts never advertise the lookup.
    expect(completionBody(0)).not.toContain("taskResultsQuery");
  });

  it("withholds records when the sandbox is enabled while the turn is in flight", async () => {
    const flip = await createAgent("Flipside");
    await insertCompletedTask(flip.id, workspaceId, {
      objective: "index the moonstone ledger",
      output: "Moonstone ledger indexed: 55 entries reconciled.",
    });
    // The first (and only allowed) reply call flips the sandbox on before
    // returning its lookup request — simulating an owner sandboxing the
    // agent while the provider round is still running. The live re-check
    // must deny the lookup: no query, no compose round.
    let calls = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes("/models")) return jsonResponse(PRICING_CATALOG);
      if (target.includes("/chat/completions")) {
        calls += 1;
        if (calls > 1) throw new Error("no further provider calls expected");
        await setSandbox(flip.id, true);
        return jsonResponse(
          completion(
            JSON.stringify({
              reply: "Checking the ledger records.",
              taskObjective: null,
              agentRequest: null,
              taskResultsQuery: { query: "moonstone ledger" },
            }),
          ),
        );
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    });

    const res = await request(app)
      .post(`/api/agents/${flip.id}/converse`)
      .send({ text: "What did the moonstone ledger task find?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("sensitive data sandbox");
    expect(res.body.reply).not.toContain("55 entries");
    expect(calls).toBe(1);
  });

  it("answers 'every task today' from the complete same-day set", async () => {
    // The deployed regression: >5 records finished today, and the owner
    // asks for all of them. The answering round must receive every record,
    // not just the first page of five.
    const digest = await createAgent("Digestor");
    const noon = utcNoonToday();
    const day = utcDayStr(noon);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const task = await insertCompletedTask(digest.id, workspaceId, {
        objective: `daily errand ${i}`,
        output: `Errand ${i} finished without incident.`,
        finishedAt: new Date(noon.getTime() - i * 60_000),
      });
      ids.push(task.id);
    }
    const stale = await insertCompletedTask(digest.id, workspaceId, {
      objective: "old errand",
      output: "Ancient errand, long done.",
      finishedAt: new Date(noon.getTime() - 5 * 24 * 60 * 60 * 1000),
    });
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "Let me pull up today's records.",
          taskObjective: null,
          agentRequest: null,
          // Browse contract: no full-text query, explicit date bounds.
          taskResultsQuery: { agentName: digest.name, since: day, until: day },
        }),
      ),
      completion("Today we completed seven tasks; here's the rundown."),
    ]);

    const res = await request(app)
      .post(`/api/agents/${digest.id}/converse`)
      .send({
        text: "Summarize every task we've done today.",
        ownerTimezone: "UTC",
      });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(
      "Today we completed seven tasks; here's the rundown.",
    );
    expect(completionCalls()).toHaveLength(2);
    // The Talk contract grounds "today" on the owner's calendar and
    // teaches the browse mode explicitly.
    expect(completionBody(0)).toContain(day);
    expect(completionBody(0)).toContain("OMIT query");
    // The answering round received every same-day record — all 7, in one
    // summary, marked as the complete set — and no older distractor.
    const compose = completionBody(1);
    for (const id of ids) expect(compose).toContain(id);
    expect(compose).not.toContain(stale.id);
    expect(compose).toContain("COMPLETE set");
    expect(compose).toContain("All 7 matching completed task result(s)");
    expect(compose).not.toContain("not browsable");
  });

  it("tells the answering round when records remain beyond the Talk bound", async () => {
    const overflow = await createAgent("Overflow");
    const noon = utcNoonToday();
    const day = utcDayStr(noon);
    const total = TALK_RESULT_MAX_RECORDS + 2;
    for (let i = 0; i < total; i += 1) {
      await insertCompletedTask(overflow.id, workspaceId, {
        objective: `bulk chore ${i}`,
        output: `Bulk chore ${i} done.`,
        finishedAt: new Date(noon.getTime() - i * 60_000),
      });
    }
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "Checking the day's records.",
          taskObjective: null,
          agentRequest: null,
          taskResultsQuery: {
            agentName: overflow.name,
            since: day,
            until: day,
          },
        }),
      ),
      completion(
        `I show the ${TALK_RESULT_MAX_RECORDS} most recent of ${total} tasks; 2 more finished earlier today.`,
      ),
    ]);

    const res = await request(app)
      .post(`/api/agents/${overflow.id}/converse`)
      .send({ text: "List everything we did today.", ownerTimezone: "UTC" });
    expect(res.status).toBe(200);
    const compose = completionBody(1);
    // The answering round is told, in its instructions AND in the records,
    // that this is a partial set — it can never present it as complete.
    expect(compose).toContain("NEVER present them as the complete history");
    expect(compose).toContain(
      `only the ${TALK_RESULT_MAX_RECORDS} most recent of ${total}`,
    );
    expect(compose).not.toContain("COMPLETE set of matching results");
  });

  it("still proposes tasks normally when no lookup is requested", async () => {
    const planner = await createAgent("Planner");
    queueCompletions([
      completion(
        JSON.stringify({
          reply: "I can draft that report — want me to make it a task?",
          taskObjective: "Draft the weekly reef report",
          agentRequest: null,
          taskResultsQuery: null,
        }),
      ),
    ]);

    const res = await request(app)
      .post(`/api/agents/${planner.id}/converse`)
      .send({ text: "Can you draft the weekly reef report?" });
    expect(res.status).toBe(200);
    expect(res.body.proposedTaskObjective).toBe("Draft the weekly reef report");
  });
});

describe("complete Talk task history (bounded-exhaustive browse)", () => {
  it("browses a whole day chronologically with no query — every record, newest first", async () => {
    const chronicle = await createAgent("Chronicle");
    const noon = utcNoonToday();
    const day = utcDayStr(noon);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const task = await insertCompletedTask(chronicle.id, workspaceId, {
        objective: `digest entry ${i}`,
        output: `Digest entry ${i} recorded.`,
        finishedAt: new Date(noon.getTime() - i * 60_000),
      });
      ids.push(task.id);
    }
    const distractors = [];
    for (let i = 0; i < 2; i += 1) {
      distractors.push(
        await insertCompletedTask(chronicle.id, workspaceId, {
          objective: `stale digest ${i}`,
          output: "Old digest, different day.",
          finishedAt: new Date(noon.getTime() - (i + 3) * 24 * 60 * 60 * 1000),
        }),
      );
    }

    const lookup = await collectTaskResultsForTalk(caller(), {
      agentName: chronicle.name,
      since: day,
      until: day,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.total).toBe(7);
    expect(lookup.shown).toBe(7);
    expect(lookup.complete).toBe(true);
    // Every same-day record present, newest first; no older distractors.
    const positions = ids.map((id) => lookup.summary.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const old of distractors) {
      expect(lookup.summary).not.toContain(old.id);
    }
    expect(lookup.summary).toContain("complete set");
  });

  it("treats a filler query like 'all tasks today' as browsing today, never as full-text terms", async () => {
    const broad = await createAgent("Broadside");
    const noon = utcNoonToday();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const task = await insertCompletedTask(broad.id, workspaceId, {
        objective: `sweep round ${i}`,
        output: `Sweep round ${i} clear.`,
        finishedAt: new Date(noon.getTime() - i * 60_000),
      });
      ids.push(task.id);
    }
    const old = await insertCompletedTask(broad.id, workspaceId, {
      objective: "sweep round from last week",
      output: "Old sweep.",
      finishedAt: new Date(noon.getTime() - 6 * 24 * 60 * 60 * 1000),
    });

    // No since/until given: the filler words themselves name the day.
    const lookup = await collectTaskResultsForTalk(caller(), {
      query: "all tasks today",
      agentName: broad.name,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.total).toBe(6);
    expect(lookup.complete).toBe(true);
    for (const id of ids) expect(lookup.summary).toContain(id);
    expect(lookup.summary).not.toContain(old.id);
    // The filler was never demanded as a literal text match.
    expect(lookup.summary).not.toContain('matching "all tasks today"');
  });

  it("follows pages up to the documented bound and reports exactly what remains", async () => {
    const prolific = await createAgent("Prolific");
    const noon = utcNoonToday();
    const day = utcDayStr(noon);
    const total = TALK_RESULT_MAX_RECORDS + 3;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const task = await insertCompletedTask(prolific.id, workspaceId, {
        objective: `harbor log ${i}`,
        output: `Harbor log ${i}.`,
        finishedAt: new Date(noon.getTime() - i * 60_000),
      });
      ids.push(task.id);
    }

    const lookup = await collectTaskResultsForTalk(caller(), {
      agentName: prolific.name,
      since: day,
      until: day,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.total).toBe(total);
    expect(lookup.shown).toBe(TALK_RESULT_MAX_RECORDS);
    expect(lookup.complete).toBe(false);
    // The newest records fill the bound; the overflow is named, not hidden.
    for (const id of ids.slice(0, TALK_RESULT_MAX_RECORDS)) {
      expect(lookup.summary).toContain(id);
    }
    for (const id of ids.slice(TALK_RESULT_MAX_RECORDS)) {
      expect(lookup.summary).not.toContain(id);
    }
    expect(lookup.summary).toContain(
      `only the ${TALK_RESULT_MAX_RECORDS} most recent of ${total}`,
    );
    expect(lookup.summary).toContain("3 more exist");
  });

  it("distinguishes unbrowsable records instead of implying they do not exist", async () => {
    const mixed = await createAgent("Mixedbag");
    const noon = utcNoonToday();
    const day = utcDayStr(noon);
    const done = await insertCompletedTask(mixed.id, workspaceId, {
      objective: "sort the shells",
      output: "Shells sorted into 4 bins.",
      finishedAt: noon,
    });
    await insertRunningTask(mixed.id, "still sorting the shells");
    // Completed but with no stored output: eligible-looking, not browsable.
    await db.insert(tasksTable).values({
      agentId: mixed.id,
      workspaceId,
      objective: `${RUN_TAG} finished without output`,
      output: "",
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "completed",
      attempts: 1,
      startedAt: new Date(noon.getTime() - 60_000),
      finishedAt: noon,
    });

    const lookup = await collectTaskResultsForTalk(caller(), {
      agentName: mixed.name,
      since: day,
      until: day,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.total).toBe(1);
    expect(lookup.summary).toContain(done.id);
    expect(lookup.summary).toContain(
      "2 other task(s) in this range are not browsable",
    );

    // A sandboxed agent's record in an otherwise empty range: reported as
    // unbrowsable by count only — its content never appears.
    const hidden = await createAgent("Hiddenwork");
    const past = new Date(noon.getTime() - 30 * 24 * 60 * 60 * 1000);
    await insertCompletedTask(hidden.id, workspaceId, {
      objective: "secret survey",
      output: "Secret survey findings.",
      finishedAt: past,
    });
    await setSandbox(hidden.id, true);
    const gone = await collectTaskResultsForTalk(caller(), {
      since: utcDayStr(past),
      until: utcDayStr(past),
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.total).toBe(0);
    expect(gone.summary).toContain("No completed task results matched");
    expect(gone.summary).toContain(
      "1 other task(s) in this range are not browsable",
    );
    expect(gone.summary).not.toContain("Secret survey");
  });

  it("resolves date-only bounds on the owner's calendar day, not the server's", async () => {
    const boundary = await createAgent("Boundary");
    // UTC+14, no DST: the owner's "today" differs maximally from UTC.
    const tz = "Pacific/Kiritimati";
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [y, m, d] = today.split("-").map(Number);
    const dayStart = new Date(
      new TZDate(y!, m! - 1, d!, 0, 0, 0, tz).getTime(),
    );
    const early = await insertCompletedTask(boundary.id, workspaceId, {
      objective: "sunrise patrol",
      output: "Sunrise patrol done.",
      finishedAt: new Date(dayStart.getTime() + 10 * 60_000),
    });
    const late = await insertCompletedTask(boundary.id, workspaceId, {
      objective: "midnight patrol",
      output: "Midnight patrol done.",
      finishedAt: new Date(dayStart.getTime() + (23 * 60 + 50) * 60_000),
    });
    const priorDay = await insertCompletedTask(boundary.id, workspaceId, {
      objective: "yesterday patrol",
      output: "Yesterday patrol done.",
      finishedAt: new Date(dayStart.getTime() - 10 * 60_000),
    });

    const owner = await collectTaskResultsForTalk(
      caller(),
      { agentName: boundary.name, since: today, until: today },
      { timezone: tz },
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.total).toBe(2);
    expect(owner.summary).toContain(early.id);
    expect(owner.summary).toContain(late.id);
    expect(owner.summary).not.toContain(priorDay.id);

    // The relative words resolve on the same owner calendar.
    const relative = await collectTaskResultsForTalk(
      caller(),
      { agentName: boundary.name, since: "today", until: "today" },
      { timezone: tz },
    );
    expect(relative.ok).toBe(true);
    if (!relative.ok) return;
    expect(relative.total).toBe(2);

    // Without the owner's timezone the same dates are a different window:
    // the owner's early-morning record falls outside the UTC day.
    const utc = await collectTaskResultsForTalk(caller(), {
      agentName: boundary.name,
      since: today,
      until: today,
    });
    expect(utc.ok).toBe(true);
    if (!utc.ok) return;
    expect(utc.summary).not.toContain(early.id);
  });
});
