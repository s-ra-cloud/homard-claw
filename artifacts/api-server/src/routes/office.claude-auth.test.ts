/**
 * Claude Code setup-token authentication.
 *
 * The properties under test: a setup token is validated for shape before it
 * is stored, saved tokens are probed and executed with the exact OAuth
 * contract Anthropic requires of the Claude Code CLI (Bearer auth, both
 * beta capabilities, CLI identity headers, the mandatory identity system
 * block), authentication failures map to fixed remediation text that never
 * echoes provider bodies or credential material, replacing or removing a
 * credential immediately refreshes health, and no path — response, task
 * row, or task log — ever leaks the token.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  providerCredentialsTable,
  taskLogsTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-claude-unset" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// All provider traffic is mocked; no test may reach a real vendor.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { runTask } from "../worker";
import { clearProviderCaches } from "../providers";
import {
  getProviderCredential,
  saveProviderCredential,
} from "../provider-credentials";
import {
  CLAUDE_CODE_SYSTEM_IDENTITY,
} from "../claude-oauth";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC ClaudeAuth ${Date.now()}`;
// Fixture tokens: correct setup-token shape, obviously not real secrets.
const TOKEN_A = "sk-ant-oat01-hc-test-fixture-workspace-a";
const TOKEN_B = "sk-ant-oat01-hc-test-fixture-workspace-b";

let userA = "";
let userB = "";
let wsA = "";
let wsB = "";
const createdAgentIds: string[] = [];

/** Create a paused claude_max agent while authenticated as the given user. */
async function createAgentAs(userId: string, name: string) {
  authState.userId = userId;
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Setup Token Tester",
      mission: "Prove the Claude Code OAuth contract end to end.",
      provider: "claude_max",
      model: "claude-haiku-4-5",
      securityPreset: "assistant",
      // These tests exercise the authentication contract, not policy: run
      // fully autonomous with unlimited caps so approvals and spend
      // ceilings never intercept the provider call under test.
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  await request(app).post(`/api/agents/${res.body.id}/pause`).send({ paused: true });
  return res.body as { id: string };
}

async function insertTask(workspaceId: string, agentId: string) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      workspaceId,
      agentId,
      objective: `${RUN_TAG} scripted objective`,
      provider: "claude_max",
      model: "claude-haiku-4-5",
      budgetCents: 100,
      status: "running",
      attempts: 1,
    })
    .returning();
  return task!;
}

async function loadAgent(agentId: string) {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return agent!;
}

async function getTaskRow(id: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return task!;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    model?: string;
    max_tokens?: number;
    system?: Array<{ type?: string; text?: string }>;
    messages?: unknown;
  };
};

/**
 * Anthropic stub: captures every /v1/messages request and answers with the
 * given status. Success responses look like a real messages payload.
 */
function mockAnthropic(status = 200, responseBody?: unknown) {
  const requests: CapturedRequest[] = [];
  fetchMock.mockImplementation(
    async (
      url: unknown,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      if (!String(url).includes("api.anthropic.com/v1/messages")) {
        throw new Error(`unexpected fetch in test: ${String(url)}`);
      }
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : {},
      });
      if (status === 200) {
        return jsonResponse(
          responseBody ?? {
            content: [{ type: "text", text: "Done." }],
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        );
      }
      return jsonResponse(
        responseBody ?? { type: "error", error: { type: "authentication_error", message: "SENSITIVE-UPSTREAM-BODY" } },
        status,
      );
    },
  );
  return { requests };
}

async function putCredential(userId: string, credential: string) {
  authState.userId = userId;
  return request(app)
    .put("/api/providers/claude_max/credential")
    .send({ credential });
}

async function claudeStatus(userId: string) {
  authState.userId = userId;
  const res = await request(app).get("/api/providers");
  expect(res.status).toBe(200);
  return res.body.find(
    (p: { provider: string }) => p.provider === "claude_max",
  ) as {
    configured: boolean;
    healthy: boolean;
    message: string;
    usesSubscriptionAllowance?: boolean;
  };
}

beforeAll(async () => {
  const stamp = Date.now();
  userA = `hc-claude-a-${stamp}`;
  userB = `hc-claude-b-${stamp}`;
  const rows = await db
    .insert(workspacesTable)
    .values([{ clerkUserId: userA }, { clerkUserId: userB }])
    .returning({ id: workspacesTable.id, clerkUserId: workspacesTable.clerkUserId });
  wsA = rows.find((r) => r.clerkUserId === userA)!.id;
  wsB = rows.find((r) => r.clerkUserId === userB)!.id;
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  // Every test states its own credential facts from a clean slate.
  await db
    .delete(providerCredentialsTable)
    .where(inArray(providerCredentialsTable.workspaceId, [wsA, wsB]));
  clearProviderCaches();
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    const taskRows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    if (taskRows.length > 0) {
      await db
        .delete(taskLogsTable)
        .where(inArray(taskLogsTable.taskId, taskRows.map((t) => t.id)));
    }
    await db.delete(tasksTable).where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Cascade removes provider credential rows for both throwaway workspaces.
  await db.delete(workspacesTable).where(inArray(workspacesTable.id, [wsA, wsB]));
});

describe("setup-token shape validation before storage", () => {
  it("rejects a Console API key with wrong-credential-type guidance and stores nothing", async () => {
    const probe = mockAnthropic();
    const res = await putCredential(
      userA,
      "sk-ant-api03-not-a-setup-token-aaaaaaaa",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/console api key/i);
    expect(res.body.error).toMatch(/setup-token/i);
    // The submitted value is never echoed and nothing was stored or probed.
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-api03");
    expect(await getProviderCredential(wsA, "claude_max")).toBeNull();
    expect(probe.requests).toHaveLength(0);
  });

  it("rejects a refresh token and an unrecognizable string with remediation", async () => {
    const refresh = await putCredential(userA, "sk-ant-ort01-refresh-material");
    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toMatch(/refresh token/i);

    const garbage = await putCredential(userA, "definitely-not-a-token-123456");
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toMatch(/setup-token/i);
    expect(JSON.stringify(garbage.body)).not.toContain("definitely-not-a-token");
    expect(await getProviderCredential(wsA, "claude_max")).toBeNull();
  });
});

describe("setup-token save and immediate health probe", () => {
  it("probes /v1/messages with the full Claude Code OAuth contract", async () => {
    const probe = mockAnthropic(200);
    const res = await putCredential(userA, TOKEN_A);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.healthy).toBe(true);
    expect(res.body.usesSubscriptionAllowance).toBe(true);
    // The stored token never appears in the response.
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_A);

    expect(probe.requests).toHaveLength(1);
    const sent = probe.requests[0]!;
    expect(sent.method).toBe("POST");
    // The OAuth contract: Bearer auth (never x-api-key), both beta
    // capabilities, and the CLI identity headers.
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(sent.headers["x-api-key"]).toBeUndefined();
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(sent.headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(sent.headers["user-agent"]).toMatch(/^claude-cli\//);
    expect(sent.headers["x-app"]).toBe("cli");
    // A minimal real message: the identity sentence must be the entire
    // first system block.
    expect(sent.body.max_tokens).toBe(1);
    expect(sent.body.system?.[0]?.text).toBe(CLAUDE_CODE_SYSTEM_IDENTITY);
  });

  it("maps HTTP 401 to expired/revoked guidance without echoing the body or token", async () => {
    mockAnthropic(401);
    const res = await putCredential(userA, TOKEN_A);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.healthy).toBe(false);
    expect(res.body.message).toMatch(/expired or been revoked/i);
    expect(res.body.message).toMatch(/setup-token/i);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("SENSITIVE-UPSTREAM-BODY");
    expect(serialized).not.toContain(TOKEN_A);
  });

  it("treats rate limiting as proof the token authenticates", async () => {
    mockAnthropic(429, { type: "error", error: { type: "rate_limit_error" } });
    const res = await putCredential(userA, TOKEN_A);
    expect(res.body.healthy).toBe(true);
    expect(res.body.message).toMatch(/rate limiting/i);
  });

  it("flags HTTP 400 as a protocol problem, not a credential problem", async () => {
    mockAnthropic(400, { type: "error", error: { type: "invalid_request_error", message: "Error" } });
    const res = await putCredential(userA, TOKEN_A);
    expect(res.body.healthy).toBe(false);
    expect(res.body.message).toMatch(/protocol change/i);
    expect(res.body.message).not.toMatch(/expired/i);
  });
});

describe("health state stays current", () => {
  it("replacing a rejected token immediately reflects the new probe result", async () => {
    mockAnthropic(401);
    const bad = await putCredential(userA, TOKEN_A);
    expect(bad.body.healthy).toBe(false);
    // Cached failure must not shadow the replacement token's success.
    mockAnthropic(200);
    const good = await putCredential(userA, TOKEN_B);
    expect(good.body.healthy).toBe(true);
    expect(good.body.message).toMatch(/accepted/i);
  });

  it("removing the credential immediately reports unconfigured", async () => {
    mockAnthropic(200);
    await putCredential(userA, TOKEN_A);
    expect((await claudeStatus(userA)).configured).toBe(true);

    authState.userId = userA;
    const removed = await request(app).delete("/api/providers/claude_max/credential");
    expect(removed.status).toBe(200);
    expect(removed.body.configured).toBe(false);
    expect((await claudeStatus(userA)).configured).toBe(false);
  });

  it("keeps health per workspace: one workspace's token never shows for another", async () => {
    mockAnthropic(200);
    await putCredential(userA, TOKEN_A);
    expect((await claudeStatus(userA)).configured).toBe(true);
    expect((await claudeStatus(userB)).configured).toBe(false);
  });
});

describe("execution uses the identical OAuth contract", () => {
  it("runs each task with its own workspace's token, identity block first", async () => {
    await saveProviderCredential(wsA, "claude_max", TOKEN_A);
    await saveProviderCredential(wsB, "claude_max", TOKEN_B);
    const agentA = await createAgentAs(userA, `${RUN_TAG} Runner A`);
    const agentB = await createAgentAs(userB, `${RUN_TAG} Runner B`);
    const anthropic = mockAnthropic(200);

    const taskA = await insertTask(wsA, agentA.id);
    await runTask({ task: taskA, agent: await loadAgent(agentA.id) });
    const taskB = await insertTask(wsB, agentB.id);
    await runTask({ task: taskB, agent: await loadAgent(agentB.id) });

    expect((await getTaskRow(taskA.id)).status).toBe("completed");
    expect((await getTaskRow(taskB.id)).status).toBe("completed");
    expect(anthropic.requests.map((r) => r.headers.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
    for (const sent of anthropic.requests) {
      // Execution presents the exact contract the health check validated.
      expect(sent.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
      expect(sent.headers["anthropic-beta"]).toContain("claude-code-20250219");
      expect(sent.headers["user-agent"]).toMatch(/^claude-cli\//);
      expect(sent.headers["x-app"]).toBe("cli");
      expect(sent.body.system?.[0]?.text).toBe(CLAUDE_CODE_SYSTEM_IDENTITY);
      // The real agent prompt rides along as its own separate block.
      expect(sent.body.system!.length).toBeGreaterThan(1);
      expect(sent.body.system?.[1]?.text ?? "").not.toBe("");
    }
  });

  it("maps an execution 401 to sanitized setup-token guidance with no leakage", async () => {
    await saveProviderCredential(wsA, "claude_max", TOKEN_A);
    const agent = await createAgentAs(userA, `${RUN_TAG} Expired`);
    mockAnthropic(401);

    const task = await insertTask(wsA, agent.id);
    await runTask({ task, agent: await loadAgent(agent.id) });

    const failed = await getTaskRow(task.id);
    expect(failed.status).not.toBe("completed");
    expect(failed.errorKind).toBe("auth");
    expect(failed.errorMessage ?? "").toMatch(/expired or been revoked/i);
    expect(failed.errorMessage ?? "").toMatch(/setup-token/i);
    // Neither the task row nor any task log carries token or body material.
    expect(failed.errorMessage ?? "").not.toContain(TOKEN_A);
    expect(failed.errorMessage ?? "").not.toContain("SENSITIVE-UPSTREAM-BODY");
    const logs = await db
      .select()
      .from(taskLogsTable)
      .where(eq(taskLogsTable.taskId, task.id));
    const logText = logs.map((l) => l.message).join("\n");
    expect(logText).not.toContain(TOKEN_A);
    expect(logText).not.toContain("SENSITIVE-UPSTREAM-BODY");
  });
});
