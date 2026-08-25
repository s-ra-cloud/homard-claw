/**
 * Workspace credential isolation.
 *
 * Two workspaces, two sets of provider keys. The security property under
 * test: an execution in one workspace can only ever spend that workspace's
 * own stored credential — never another workspace's, and never a shared
 * server key (there is none). A workspace without a credential fails
 * closed, and a credential that cannot be decrypted asks for re-entry
 * rather than falling back to anything.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  providerCredentialsTable,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-iso-unset" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// All provider traffic is mocked; no test may reach a real vendor.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { runTask } from "../worker";
import { clearProviderCaches } from "../providers";
import { saveProviderCredential } from "../provider-credentials";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Isolation ${Date.now()}`;
const KEY_A = "ws-a-openrouter-key-aaaa";
const KEY_B = "ws-b-openrouter-key-bbbb";

let userA = "";
let userB = "";
let wsA = "";
let wsB = "";
const createdAgentIds: string[] = [];

/** Create a paused agent while authenticated as the given user. */
async function createAgentAs(userId: string, name: string) {
  authState.userId = userId;
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Isolation Tester",
      mission: "Prove credentials never cross workspaces.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      // These tests exercise credential resolution, not policy: run fully
      // autonomous with unlimited caps so approvals and spend ceilings
      // never intercept the provider call under test.
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
      provider: "openrouter",
      model: "test-vendor/test-model",
      // A budget bounds the spend so autonomy policy allows the run; the
      // credential paths under test sit past that gate.
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

/**
 * Priced catalog plus successful completions; records every Authorization
 * header presented to the completion endpoint.
 */
function mockOpenRouter(): { authHeaders: string[] } {
  const authHeaders: string[] = [];
  fetchMock.mockImplementation(
    async (url: unknown, init?: { headers?: Record<string, string> }) => {
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
      if (String(url).includes("/chat/completions")) {
        authHeaders.push(init?.headers?.Authorization ?? "");
        return jsonResponse({
          choices: [{ message: { content: "Finished the isolated work." } }],
          usage: { prompt_tokens: 1200, completion_tokens: 340 },
        });
      }
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    },
  );
  return { authHeaders };
}

beforeAll(async () => {
  const stamp = Date.now();
  userA = `hc-iso-a-${stamp}`;
  userB = `hc-iso-b-${stamp}`;
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
    await db.delete(tasksTable).where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Cascade removes provider credential rows for both throwaway workspaces.
  await db.delete(workspacesTable).where(inArray(workspacesTable.id, [wsA, wsB]));
});

describe("workspace credential isolation", () => {
  it("runs with the workspace's own key and never another workspace's", async () => {
    await saveProviderCredential(wsA, "openrouter", KEY_A);
    await saveProviderCredential(wsB, "openrouter", KEY_B);
    const agentA = await createAgentAs(userA, `${RUN_TAG} Runner A`);
    const agentB = await createAgentAs(userB, `${RUN_TAG} Runner B`);
    const provider = mockOpenRouter();

    const taskA = await insertTask(wsA, agentA.id);
    await runTask({ task: taskA, agent: await loadAgent(agentA.id) });
    const taskB = await insertTask(wsB, agentB.id);
    await runTask({ task: taskB, agent: await loadAgent(agentB.id) });

    expect((await getTaskRow(taskA.id)).status).toBe("completed");
    expect((await getTaskRow(taskB.id)).status).toBe("completed");
    expect(provider.authHeaders).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
  });

  it("fails closed when the workspace has no key, even if another workspace has one", async () => {
    await saveProviderCredential(wsA, "openrouter", KEY_A);
    const agentB = await createAgentAs(userB, `${RUN_TAG} Keyless B`);
    const provider = mockOpenRouter();

    const task = await insertTask(wsB, agentB.id);
    await runTask({ task, agent: await loadAgent(agentB.id) });

    const blocked = await getTaskRow(task.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.errorKind).toBe("not_configured");
    // Workspace A's key was never presented anywhere.
    expect(provider.authHeaders).toHaveLength(0);
  });

  it("asks for re-entry when the stored credential cannot be decrypted", async () => {
    // A row that is not valid ciphertext: decryption must fail closed with a
    // clear re-enter message, never fall back to another key.
    await db
      .insert(providerCredentialsTable)
      .values({
        workspaceId: wsB,
        provider: "openrouter",
        credentialEnc: "v1.bm90.YXJlYWw=.Y3JlZGVudGlhbA==",
      })
      .onConflictDoUpdate({
        target: [
          providerCredentialsTable.workspaceId,
          providerCredentialsTable.provider,
        ],
        set: { credentialEnc: "v1.bm90.YXJlYWw=.Y3JlZGVudGlhbA==" },
      });
    const agentB = await createAgentAs(userB, `${RUN_TAG} Corrupt B`);
    const provider = mockOpenRouter();

    const task = await insertTask(wsB, agentB.id);
    await runTask({ task, agent: await loadAgent(agentB.id) });

    const failed = await getTaskRow(task.id);
    expect(failed.status).not.toBe("completed");
    expect(failed.errorMessage ?? "").toMatch(/enter the key again/i);
    expect(provider.authHeaders).toHaveLength(0);
  });

  it("reports provider configuration per workspace, not globally", async () => {
    await saveProviderCredential(wsA, "openrouter", KEY_A);
    mockOpenRouter();

    authState.userId = userA;
    const asA = await request(app).get("/api/providers");
    expect(asA.status).toBe(200);
    const openrouterA = asA.body.find(
      (p: { provider: string }) => p.provider === "openrouter",
    );
    expect(openrouterA.configured).toBe(true);

    clearProviderCaches();
    authState.userId = userB;
    const asB = await request(app).get("/api/providers");
    expect(asB.status).toBe(200);
    const openrouterB = asB.body.find(
      (p: { provider: string }) => p.provider === "openrouter",
    );
    expect(openrouterB.configured).toBe(false);
  });

  it("keeps voice availability per workspace", async () => {
    await saveProviderCredential(wsA, "openai_voice", "ws-a-voice-key-aaaa");

    authState.userId = userA;
    const asA = await request(app).get("/api/voice/status");
    expect(asA.body.available).toBe(true);

    authState.userId = userB;
    const asB = await request(app).get("/api/voice/status");
    expect(asB.body.available).toBe(false);
  });
});
