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
  db,
  memoriesTable,
  pool,
  systemStateTable,
  tasksTable,
  teamMembersTable,
  teamsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { claimNextTask, runTask } from "../worker";
import { clearProviderCaches } from "../providers";
import { getRuntime, listRuntimeHealth, queueHealth } from "../runtime";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Teams ${Date.now()}`;
const createdAgentIds: string[] = [];
const createdTeamIds: string[] = [];
let createdOwnerRow = false;
let wsId: string;

/** Paused agents keep the live development worker away from test tasks. */
async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Team Tester",
      mission: "Exercise team delegation rules.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      autonomy: "autonomous",
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
    permissions: Record<string, number>;
  };
}

async function createTeam(name: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/teams")
    .send({ name, ...body });
  expect(res.status).toBe(201);
  createdTeamIds.push(res.body.id);
  return res.body;
}

async function insertTask(
  agentId: string,
  overrides: Partial<typeof tasksTable.$inferInsert> = {},
) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      workspaceId: wsId,
      agentId,
      objective: `${RUN_TAG} parent objective`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "queued",
      // Priced up front: an unpriced metered task always parks for owner
      // sign-off, which would hide the behaviour under test.
      estimatedCostCents: 1,
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

const scopeFor = (agentId: string) => ({
  agentIds: [agentId],
  includePausedAgents: true,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockOpenRouterSuccess(output = "Here is the finished work.") {
  fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
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
    lastCompletionBody = JSON.parse(
      String((init as { body?: string } | undefined)?.body ?? "{}"),
    );
    return jsonResponse({
      choices: [{ message: { content: output } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    });
  });
}

let lastCompletionBody: Record<string, unknown> = {};

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

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  lastCompletionBody = {};
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-claude-token");
  clearProviderCaches();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentMessagesTable)
      .where(inArray(agentMessagesTable.fromAgentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(memoriesTable)
      .where(like(memoriesTable.content, `%${RUN_TAG}%`));
  }
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds));
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
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

describe("teams", () => {
  it("creates a team with a lead and members, and lists them", async () => {
    const lead = await createAgent(`${RUN_TAG} Lead A`);
    const member = await createAgent(`${RUN_TAG} Member A`);
    const team = await createTeam(`${RUN_TAG} Alpha`, {
      mission: "Ship the thing",
      leadAgentId: lead.id,
      memberAgentIds: [member.id],
    });

    expect(team.leadAgentName).toBe(lead.name);
    expect(team.members).toHaveLength(2);
    // The lead is listed first and flagged.
    expect(team.members[0]).toMatchObject({ agentId: lead.id, isLead: true });

    const list = await request(app).get("/api/teams");
    expect(list.status).toBe(200);
    expect(list.body.some((row: { id: string }) => row.id === team.id)).toBe(
      true,
    );
  });

  it("rejects a duplicate team name regardless of case", async () => {
    await createTeam(`${RUN_TAG} Bravo`);
    const dup = await request(app)
      .post("/api/teams")
      .send({ name: `${RUN_TAG} bravo`.toUpperCase() });
    expect(dup.status).toBe(409);
  });

  it("refuses to appoint a lead who is not a member", async () => {
    const outsider = await createAgent(`${RUN_TAG} Outsider`);
    const team = await createTeam(`${RUN_TAG} Charlie`);
    const res = await request(app)
      .patch(`/api/teams/${team.id}`)
      .send({ leadAgentId: outsider.id });
    expect(res.status).toBe(409);
  });

  it("clears the lead when the lead is removed from the team", async () => {
    const lead = await createAgent(`${RUN_TAG} Lead B`);
    const team = await createTeam(`${RUN_TAG} Delta`, {
      leadAgentId: lead.id,
      memberAgentIds: [lead.id],
    });
    expect(team.leadAgentId).toBe(lead.id);

    const removed = await request(app).delete(
      `/api/teams/${team.id}/members/${lead.id}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.leadAgentId).toBeNull();
    expect(removed.body.members).toHaveLength(0);
  });
});

describe("delegation authorization", () => {
  async function buildTeam(
    tag: string,
    leadExtra: Record<string, unknown> = {},
  ) {
    const lead = await createAgent(`${RUN_TAG} ${tag} Lead`, leadExtra);
    const worker = await createAgent(`${RUN_TAG} ${tag} Worker`);
    const team = await createTeam(`${RUN_TAG} ${tag}`, {
      leadAgentId: lead.id,
      memberAgentIds: [lead.id, worker.id],
    });
    return { lead, worker, team };
  }

  it("queues an owner-confirmed Talk hand-off and records it in Inbox", async () => {
    const { lead, worker, team } = await buildTeam("TalkRelay");
    const [handoffMemory] = await db
      .insert(memoriesTable)
      .values({
        agentId: lead.id,
        workspaceId: wsId,
        kind: "context",
        content: `${RUN_TAG} alert logs use correlation code BLUE-LANTERN-47.`,
      })
      .returning();
    await db.insert(memoriesTable).values([
      {
        agentId: lead.id,
        workspaceId: wsId,
        kind: "context",
        content: `${RUN_TAG} BLUE-LANTERN-47 disabled private secret.`,
        disabled: true,
      },
      {
        agentId: null,
        workspaceId: wsId,
        kind: "context",
        content: `${RUN_TAG} BLUE-LANTERN-47 shared office context.`,
      },
      {
        agentId: lead.id,
        workspaceId: wsId,
        kind: "context",
        content: `${RUN_TAG} unrelated pinned breakfast preference.`,
        pinned: true,
      },
    ]);
    const priorSetting = await request(app).get("/api/voice/status");
    expect(priorSetting.status).toBe(200);
    const setting = await request(app)
      .put("/api/voice/settings")
      .send({ autoApproveTalkTasks: true });
    expect(setting.status).toBe(200);
    try {
      const res = await request(app)
        .post(`/api/agents/${lead.id}/delegate-from-talk`)
        .send({
          targetAgentId: worker.id,
          // No RUN_TAG here on purpose: the tag's tokens appear in every
          // seeded memory, so a tagged objective would rank the unrelated
          // pinned memory as "relevant" purely through fixture boilerplate.
          objective: "Check the alert logs and report back",
          note: "Please check the latest logs and report back.",
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        agentId: worker.id,
        depth: 1,
        teamId: team.id,
        delegatedByAgentId: lead.id,
        status: "queued",
      });

      const task = await getTaskRow(res.body.id);
      expect(task).toMatchObject({
        talkMode: true,
        talkAutoApprove: true,
        teamId: team.id,
        delegatedByAgentId: lead.id,
      });
      expect(task.handoffContext).toContain("BLUE-LANTERN-47");
      expect(task.handoffContext).toContain(
        "Please check the latest logs and report back.",
      );
      expect(task.handoffSources).toEqual([
        expect.objectContaining({
          id: handoffMemory!.id,
          label: "H1",
          sourceAgentId: lead.id,
          sourceAgentName: lead.name,
        }),
      ]);
      expect(task.handoffContext).not.toContain("disabled private secret");
      expect(task.handoffContext).not.toContain("shared office context");
      expect(task.handoffContext).not.toContain("breakfast preference");
      expect(res.body.handoffContext).toBeUndefined();
      expect(res.body.handoffSources).toEqual(task.handoffSources);
      const messages = await request(app)
        .get("/api/messages")
        .query({ taskId: res.body.id });
      expect(messages.status).toBe(200);
      expect(messages.body[0]).toMatchObject({
        kind: "delegation",
        fromAgentId: lead.id,
        toAgentId: worker.id,
        body: "Please check the latest logs and report back.",
      });
    } finally {
      await request(app).put("/api/voice/settings").send({
        autoApproveTalkTasks: priorSetting.body.autoApproveTalkTasks,
      });
    }
  });

  it("refuses a Talk hand-off from a sandboxed source", async () => {
    const { lead, worker } = await buildTeam("TalkSandboxSource", {
      sensitiveDataSandbox: true,
    });
    const res = await request(app)
      .post(`/api/agents/${lead.id}/delegate-from-talk`)
      .send({
        targetAgentId: worker.id,
        objective: `${RUN_TAG} forbidden outbound work`,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sensitive data sandbox/i);
  });

  it("refuses a Talk hand-off to a sandboxed target", async () => {
    const { lead, worker } = await buildTeam("TalkSandboxTarget");
    const patched = await request(app)
      .patch(`/api/agents/${worker.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(patched.status).toBe(200);

    const res = await request(app)
      .post(`/api/agents/${lead.id}/delegate-from-talk`)
      .send({
        targetAgentId: worker.id,
        objective: `${RUN_TAG} forbidden inbound work`,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sensitive data sandbox/i);
  });

  it("refuses a Talk hand-off when the source does not lead the target", async () => {
    const { lead, worker } = await buildTeam("TalkLeadership");
    const res = await request(app)
      .post(`/api/agents/${worker.id}/delegate-from-talk`)
      .send({
        targetAgentId: lead.id,
        objective: `${RUN_TAG} unauthorized hand-off`,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/team it leads/i);
  });

  it("creates a sub-task with lineage and a delegation message", async () => {
    const { lead, worker, team } = await buildTeam("Echo");
    const parent = await insertTask(lead.id, { teamId: team.id });

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({
        agentId: worker.id,
        objective: `${RUN_TAG} please draft the summary`,
        note: "Focus on the numbers.",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agentId: worker.id,
      parentTaskId: parent.id,
      rootTaskId: parent.id,
      depth: 1,
      teamId: team.id,
      delegatedByAgentId: lead.id,
      status: "queued",
    });

    const messages = await request(app)
      .get("/api/messages")
      .query({ taskId: res.body.id });
    expect(messages.status).toBe(200);
    expect(messages.body[0]).toMatchObject({
      kind: "delegation",
      fromAgentName: lead.name,
      toAgentName: worker.name,
      body: "Focus on the numbers.",
    });
  });

  it("refuses delegation to an agent outside the lead's team", async () => {
    const { lead, team } = await buildTeam("Foxtrot");
    const stranger = await createAgent(`${RUN_TAG} Stranger`);
    const parent = await insertTask(lead.id, { teamId: team.id });

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: stranger.id, objective: `${RUN_TAG} do something` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/members of a team it leads/i);
  });

  it("refuses delegation from an agent that does not lead the team", async () => {
    const { worker, team } = await buildTeam("Golf");
    const other = await createAgent(`${RUN_TAG} Golf Other`);
    await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ agentId: other.id });
    // `worker` is a member, not the lead, so it may not hand work on.
    const parent = await insertTask(worker.id, { teamId: team.id });

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: other.id, objective: `${RUN_TAG} pass it on` });
    expect(res.status).toBe(403);
  });

  it("refuses delegation from a lead in the sensitive data sandbox", async () => {
    const { lead, worker, team } = await buildTeam("SandboxLead", {
      sensitiveDataSandbox: true,
    });
    const parent = await insertTask(lead.id, { teamId: team.id });
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} leak attempt` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sensitive data sandbox/i);
  });

  it("refuses delegation to a target in the sensitive data sandbox", async () => {
    const { lead, worker, team } = await buildTeam("SandboxTarget");
    // Sandbox the target after team formation — membership alone must not
    // let work reach a sandboxed agent.
    const patched = await request(app)
      .patch(`/api/agents/${worker.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(patched.status).toBe(200);
    const parent = await insertTask(lead.id, { teamId: team.id });
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} steer attempt` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sensitive data sandbox/i);
  });

  it("refuses delegation when the preset forbids it", async () => {
    const { lead, worker, team } = await buildTeam("Hotel", {
      securityPreset: "observer",
    });
    const parent = await insertTask(lead.id, { teamId: team.id });
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} not allowed` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed to delegate/i);
  });

  it("enforces the delegation depth limit", async () => {
    // maxDelegationDepth 1: a task already one level deep cannot delegate further.
    const { lead, worker, team } = await buildTeam("India", {
      permissionOverrides: { maxDelegationDepth: 1 },
    });
    const root = await insertTask(lead.id, { teamId: team.id });
    const child = await insertTask(lead.id, {
      teamId: team.id,
      parentTaskId: root.id,
      rootTaskId: root.id,
      depth: 1,
    });

    const res = await request(app)
      .post(`/api/tasks/${child.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} too deep` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/delegation chain/i);
  });

  it("enforces the sub-task limit per task", async () => {
    const { lead, worker, team } = await buildTeam("Juliet", {
      permissionOverrides: { maxSubtasksPerTask: 1 },
    });
    const parent = await insertTask(lead.id, { teamId: team.id });

    const first = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} first slice` });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} second slice` });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatch(/limit of 1/i);
  });

  it("holds the sub-task limit under concurrent hand-offs", async () => {
    const { lead, worker, team } = await buildTeam("Mike", {
      permissionOverrides: { maxSubtasksPerTask: 2 },
    });
    const parent = await insertTask(lead.id, { teamId: team.id });

    // Five simultaneous requests must not race past the limit of 2.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(app)
          .post(`/api/tasks/${parent.id}/delegate`)
          .send({ agentId: worker.id, objective: `${RUN_TAG} racer ${index}` }),
      ),
    );
    const created = results.filter((result) => result.status === 201);
    expect(created).toHaveLength(2);
    expect(results.filter((result) => result.status === 403)).toHaveLength(3);

    const children = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.parentTaskId, parent.id));
    expect(children).toHaveLength(2);
  });

  it("refuses to delegate from a task that is already finished", async () => {
    const { lead, worker, team } = await buildTeam("November");
    const parent = await insertTask(lead.id, {
      teamId: team.id,
      status: "completed",
    });

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} after the fact` });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/completed/i);
  });

  it("refuses to delegate on behalf of a retired lead", async () => {
    const { lead, worker, team } = await buildTeam("Oscar");
    const parent = await insertTask(lead.id, { teamId: team.id });
    await request(app).post(`/api/agents/${lead.id}/retire`).send({});

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} from beyond` });
    // Retiring also parks the lead's open work, so either guard may answer
    // first; what matters is that no new work is queued behind a departure.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(
      /no longer works here|cannot hand out new work/i,
    );
    const children = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.parentTaskId, parent.id));
    expect(children).toHaveLength(0);
  });

  it("returns the whole delegation tree from any node", async () => {
    const { lead, worker, team } = await buildTeam("Kilo");
    const parent = await insertTask(lead.id, { teamId: team.id });
    const child = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({ agentId: worker.id, objective: `${RUN_TAG} branch work` });
    expect(child.status).toBe(201);

    // Asking from the child still returns the root and all descendants.
    const tree = await request(app).get(`/api/tasks/${child.body.id}/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body.rootTaskId).toBe(parent.id);
    expect(tree.body.nodes).toHaveLength(2);
    const childNode = tree.body.nodes.find(
      (node: { id: string }) => node.id === child.body.id,
    );
    expect(childNode).toMatchObject({
      parentTaskId: parent.id,
      depth: 1,
      agentName: worker.name,
      delegatedByAgentName: lead.name,
    });
  });

  it("reports the delegated result back to the lead when the sub-task finishes", async () => {
    const { lead, worker, team } = await buildTeam("Lima");
    await db.insert(memoriesTable).values({
      agentId: lead.id,
      workspaceId: wsId,
      kind: "decision",
      content: `${RUN_TAG} PLATYPUS-92 summaries must lead with the launch metric.`,
    });
    const parent = await insertTask(lead.id, { teamId: team.id });
    const child = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({
        agentId: worker.id,
        objective: `${RUN_TAG} summarize PLATYPUS-92`,
        budgetCents: 10,
      });
    expect(child.status).toBe(201);

    mockOpenRouterSuccess("The summary is ready.");
    const claimed = await claimNextTask(scopeFor(worker.id));
    expect(claimed?.task.id).toBe(child.body.id);
    await runTask(claimed!);

    expect((await getTaskRow(child.body.id)).status).toBe("completed");
    const messages = await request(app)
      .get("/api/messages")
      .query({ taskId: child.body.id });
    const result = messages.body.find(
      (message: { kind: string }) => message.kind === "result",
    );
    expect(result).toMatchObject({
      fromAgentName: worker.name,
      toAgentName: lead.name,
    });
    expect(result.body).toContain("The summary is ready.");

    const providerMessages = lastCompletionBody.messages as Array<{
      role: string;
      content: string;
    }>;
    const system = providerMessages.find(
      (message) => message.role === "system",
    );
    expect(system?.content).toContain("PLATYPUS-92 summaries");
    expect(system?.content).toContain("[H1]");
  });

  it("withholds an existing handoff if the target enters the sandbox before execution", async () => {
    const { lead, worker, team } = await buildTeam("HandoffSandbox");
    await db.insert(memoriesTable).values({
      agentId: lead.id,
      workspaceId: wsId,
      kind: "context",
      content: `${RUN_TAG} NARWHAL-81 private launch code.`,
    });
    const parent = await insertTask(lead.id, { teamId: team.id });
    const child = await request(app)
      .post(`/api/tasks/${parent.id}/delegate`)
      .send({
        agentId: worker.id,
        objective: `${RUN_TAG} inspect NARWHAL-81`,
        budgetCents: 10,
      });
    expect(child.status).toBe(201);
    expect((await getTaskRow(child.body.id)).handoffContext).toContain(
      "NARWHAL-81 private launch code",
    );

    const patched = await request(app)
      .patch(`/api/agents/${worker.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(patched.status).toBe(200);

    mockOpenRouterSuccess("Handled without cross-agent context.");
    const claimed = await claimNextTask(scopeFor(worker.id));
    expect(claimed?.task.id).toBe(child.body.id);
    await runTask(claimed!);

    const providerMessages = lastCompletionBody.messages as Array<{
      role: string;
      content: string;
    }>;
    const system = providerMessages.find(
      (message) => message.role === "system",
    );
    expect(system?.content).not.toContain("NARWHAL-81 private launch code");
    expect((await getTaskRow(child.body.id)).status).toBe("completed");
  });
});

describe("runtime limits and health", () => {
  it("caps output tokens at the agent's limit", async () => {
    const agent = await createAgent(`${RUN_TAG} Capped`, {
      permissionOverrides: { maxOutputTokens: 64 },
    });
    const task = await insertTask(agent.id);
    mockOpenRouterSuccess();

    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);

    expect(lastCompletionBody.max_tokens).toBe(64);
  });

  it("blocks a task assigned to a runtime that is not installed", async () => {
    const agent = await createAgent(`${RUN_TAG} Openclaw`);
    const task = await insertTask(agent.id, { runtime: "openclaw" });
    mockOpenRouterSuccess();

    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("runtime_unavailable");
    expect(row.errorMessage).toMatch(/not installed/i);
  });

  it("blocks a task whose runtime id is not recognized at all", async () => {
    const agent = await createAgent(`${RUN_TAG} Unknown Runtime`);
    const task = await insertTask(agent.id, { runtime: "some-future-engine" });
    mockOpenRouterSuccess();

    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);

    const row = await getTaskRow(task.id);
    // Never silently downgraded to the built-in runtime.
    expect(row.status).toBe("blocked");
    expect(row.errorKind).toBe("runtime_unavailable");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("chat/completions"),
      ),
    ).toBe(false);
  });

  it("blocks before any provider call when the attempt limit is zero", async () => {
    const agent = await createAgent(`${RUN_TAG} No Attempts`, {
      permissionOverrides: { maxAttempts: 0 },
    });
    const task = await insertTask(agent.id);
    mockOpenRouterSuccess();

    const claimed = await claimNextTask(scopeFor(agent.id));
    await runTask(claimed!);

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("blocked");
    expect(row.errorMessage).toMatch(/attempt limit is 0/i);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("chat/completions"),
      ),
    ).toBe(false);
  });

  it("refuses to execute on the uninstalled runtime even if dispatched directly", async () => {
    await expect(
      getRuntime("openclaw").execute({
        workspaceId: wsId,
        provider: "openrouter",
        model: "test-vendor/test-model",
        system: "s",
        prompt: "p",
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not installed/i);
  });

  it("reports every runtime honestly, with only the built-in one accepting work", async () => {
    const runtimes = await listRuntimeHealth(wsId);
    const native = runtimes.find((runtime) => runtime.id === "native");
    const openclaw = runtimes.find((runtime) => runtime.id === "openclaw");
    expect(native?.acceptsWork).toBe(true);
    expect(openclaw).toMatchObject({
      status: "not_installed",
      acceptsWork: false,
    });
  });

  it("exposes queue depth and worker state over HTTP", async () => {
    const agent = await createAgent(`${RUN_TAG} Queue`);
    await insertTask(agent.id);

    const res = await request(app).get("/api/runtime/health");
    expect(res.status).toBe(200);
    expect(res.body.activeRuntime).toBe("native");
    expect(res.body.queue.queued).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.worker.leaseHeld).toBe("boolean");
    // Liveness state: active (owns the queue) vs standby (polling for
    // takeover), plus the durable ownership row with its staleness flag.
    expect(["active", "standby"]).toContain(res.body.worker.state);
    expect(res.body.worker.leaseHeld).toBe(res.body.worker.state === "active");
    expect(typeof res.body.worker.instanceId).toBe("string");
    expect(typeof res.body.worker.renewalFailures).toBe("number");
    expect(typeof res.body.worker.takeovers).toBe("number");
    expect(typeof res.body.worker.ownership.stale).toBe("boolean");
    expect(res.body.runtimes).toHaveLength(2);

    const direct = await queueHealth();
    expect(direct.queued).toBeGreaterThanOrEqual(1);
  });
});
