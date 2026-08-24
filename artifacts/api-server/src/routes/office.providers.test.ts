import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  pool,
  systemStateTable,
  tasksTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// Provider endpoints must never depend on external networks in tests: any
// outbound fetch fails fast and the API is expected to degrade explicitly.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    throw new Error("network disabled in tests");
  }),
);

import officeRouter from "./office";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Prov ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;

const SETTINGS_KEYS = [
  "provider.default",
  "provider.claude_max.default_model",
  "provider.openrouter.default_model",
];
let savedSettings: Array<{ key: string; value: string }> = [];

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Provider Tester",
      mission: "Exercise routing, estimates, and usage recording.",
      provider: "claude_max",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      ...extra,
    });
  if (res.status === 201) createdAgentIds.push(res.body.id);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

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
  // Provider settings are workspace-global; snapshot them for restoration.
  savedSettings = await db
    .select()
    .from(systemStateTable)
    .where(inArray(systemStateTable.key, SETTINGS_KEYS));
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Audit rows are intentionally left in place: the log is hash-chained
  // and append-only, so deleting rows would break chain verification.
  // Restore workspace provider settings exactly as they were.
  await db
    .delete(systemStateTable)
    .where(inArray(systemStateTable.key, SETTINGS_KEYS));
  for (const row of savedSettings) {
    await db.insert(systemStateTable).values(row);
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

describe("provider status and settings", () => {
  it("reports every provider with explicit availability messages", async () => {
    const res = await request(app).get("/api/providers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    for (const status of res.body) {
      expect(["claude_max", "codex_chatgpt", "openrouter"]).toContain(
        status.provider,
      );
      expect(typeof status.configured).toBe("boolean");
      expect(typeof status.healthy).toBe("boolean");
      expect(status.label.length).toBeGreaterThan(0);
      expect(["subscription", "metered"]).toContain(status.billing);
      expect(status.message.length).toBeGreaterThan(0);
      // No secret material ever appears in status payloads.
      expect(JSON.stringify(status)).not.toMatch(/sk-|Bearer|token=/i);
    }
  });

  it("labels providers for the owner and classifies how each one bills", async () => {
    const res = await request(app).get("/api/providers");
    const byId = Object.fromEntries(
      res.body.map((s: { provider: string }) => [s.provider, s]),
    );
    expect(byId.claude_max.label).toBe("Claude Code");
    expect(byId.codex_chatgpt.label).toBe("Codex via ChatGPT Plus");
    expect(byId.openrouter.label).toBe("OpenRouter");
    // Only OpenRouter is billed per token; the other two run off a plan.
    expect(byId.claude_max.billing).toBe("subscription");
    expect(byId.codex_chatgpt.billing).toBe("subscription");
    expect(byId.openrouter.billing).toBe("metered");
    // Nobody can report a remaining plan allowance, so nobody claims to.
    for (const status of res.body) {
      expect(status.allowanceBalanceKnown).toBe(false);
    }
  });

  it("round-trips workspace routing defaults and clears with null", async () => {
    const updated = await request(app).put("/api/providers/settings").send({
      defaultProvider: "openrouter",
      claudeModel: "claude-haiku-4-5",
      openrouterModel: "anthropic/claude-sonnet-4.5",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.defaultProvider).toBe("openrouter");
    expect(updated.body.claudeModel).toBe("claude-haiku-4-5");
    expect(updated.body.openrouterModel).toBe("anthropic/claude-sonnet-4.5");

    const fetched = await request(app).get("/api/providers/settings");
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(updated.body);

    const cleared = await request(app).put("/api/providers/settings").send({
      defaultProvider: "claude_max",
      claudeModel: null,
      openrouterModel: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.claudeModel).toBeNull();
    expect(cleared.body.openrouterModel).toBeNull();
  });

  it("lists the Claude model catalog and rejects unknown providers", async () => {
    const res = await request(app).get("/api/providers/claude_max/models");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("claude_max");
    expect(res.body.models.length).toBeGreaterThan(0);
    const sonnet = res.body.models.find(
      (m: { id: string }) => m.id === "claude-sonnet-4-5",
    );
    expect(sonnet).toBeTruthy();
    expect(sonnet.promptCentsPerMTok).toBeGreaterThan(0);

    const bad = await request(app).get("/api/providers/gpt_shop/models");
    expect(bad.status).toBe(400);
  });

  it("reports the OpenRouter catalog with an explicit message when unavailable", async () => {
    const res = await request(app).get("/api/providers/openrouter/models");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openrouter");
    if (!res.body.available) {
      expect(res.body.message.length).toBeGreaterThan(0);
    } else {
      expect(res.body.models.length).toBeGreaterThan(0);
    }
  });
});

describe("estimates and usage", () => {
  it("estimates a claude_max task as subscription-covered", async () => {
    const agent = await createAgent(`${RUN_TAG} Estimator`);
    const res = await request(app).post("/api/tasks/estimate").send({
      agentId: agent.id,
      objective: `${RUN_TAG} summarize the quarterly numbers`,
    });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("claude_max");
    expect(res.body.model).toBeTruthy();
    expect(res.body.estimatedTokens).toBeGreaterThan(0);
    expect(res.body.estimatedInputTokens + res.body.estimatedOutputTokens).toBe(
      res.body.estimatedTokens,
    );
    expect(res.body.estimatedCostCents).toBe(0);
    expect(res.body.costKnown).toBe(true);
    expect(res.body.note).toMatch(/subscription/i);
  });

  it("respects provider and model overrides in estimates", async () => {
    const agent = await createAgent(`${RUN_TAG} Override`);
    const res = await request(app).post("/api/tasks/estimate").send({
      agentId: agent.id,
      objective: `${RUN_TAG} run on the other network`,
      providerOverride: "openrouter",
      modelOverride: "some-vendor/some-model",
    });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openrouter");
    expect(res.body.model).toBe("some-vendor/some-model");

    const missing = await request(app).post("/api/tasks/estimate").send({
      agentId: "00000000-0000-4000-8000-000000000000",
      objective: "does not matter",
    });
    expect(missing.status).toBe(404);
  });

  it("routes agents without a provider preference to the workspace default", async () => {
    await request(app).put("/api/providers/settings").send({
      defaultProvider: "openrouter",
      openrouterModel: "workspace/default-model",
    });
    const agent = await createAgent(`${RUN_TAG} Follower`, { provider: null });
    const res = await request(app).post("/api/tasks/estimate").send({
      agentId: agent.id,
      objective: `${RUN_TAG} follow the workspace routing`,
    });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openrouter");
    expect(res.body.model).toBe("workspace/default-model");

    // Restore claude_max as the default for the remaining tests.
    await request(app).put("/api/providers/settings").send({
      defaultProvider: "claude_max",
      openrouterModel: null,
    });
  });

  it("stores routing and estimates on dispatched tasks", async () => {
    const agent = await createAgent(`${RUN_TAG} Dispatcher`, {
      model: "claude-haiku-4-5",
    });
    const res = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: `${RUN_TAG} archive the fish reports`,
    });
    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("claude_max");
    expect(res.body.model).toBe("claude-haiku-4-5");
    expect(res.body.estimatedTokens).toBeGreaterThan(0);
    expect(res.body.estimatedCostCents).toBe(0);
  });

  it("records actual usage and computes claude_max cost as zero", async () => {
    const agent = await createAgent(`${RUN_TAG} Meter`);
    const task = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: `${RUN_TAG} count the paperclips`,
    });
    expect(task.status).toBe(201);

    const usage = await request(app)
      .post(`/api/tasks/${task.body.id}/usage`)
      .send({ inputTokens: 1500, outputTokens: 700 });
    expect(usage.status).toBe(200);
    expect(usage.body.actualInputTokens).toBe(1500);
    expect(usage.body.actualOutputTokens).toBe(700);
    expect(usage.body.actualCostCents).toBe(0);

    const missing = await request(app)
      .post("/api/tasks/00000000-0000-4000-8000-000000000000/usage")
      .send({ inputTokens: 1, outputTokens: 1 });
    expect(missing.status).toBe(404);
  });

  it("accepts an explicitly reported cost", async () => {
    const agent = await createAgent(`${RUN_TAG} Biller`);
    const task = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: `${RUN_TAG} bill the client`,
      providerOverride: "openrouter",
      modelOverride: "some-vendor/some-model",
    });
    expect(task.status).toBe(201);
    expect(task.body.provider).toBe("openrouter");
    // Unknown pricing means no estimated cost was stored.
    expect(task.body.estimatedCostCents).toBeNull();

    const usage = await request(app)
      .post(`/api/tasks/${task.body.id}/usage`)
      .send({ inputTokens: 100, outputTokens: 50, costCents: 12.5 });
    expect(usage.status).toBe(200);
    expect(usage.body.actualCostCents).toBeCloseTo(12.5);
  });
});
