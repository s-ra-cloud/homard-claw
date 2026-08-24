import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  approvalsTable,
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

import officeRouter from "./office";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Test ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;

function agentInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: "Test Analyst",
    mission: "Run lifecycle checks and report back.",
    provider: "claude_max",
    securityPreset: "assistant",
    avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    ...extra,
  };
}

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/agents").send(agentInput(name, extra));
  if (res.status === 201) createdAgentIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) {
    // Impersonate the existing owner so requireOwner lets us through
    // without mutating ownership state.
    authState.userId = owner.value;
  } else {
    createdOwnerRow = true;
  }
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(approvalsTable)
      .where(inArray(approvalsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Audit rows are intentionally left in place: the log is hash-chained
  // and append-only, so deleting rows would break chain verification.
  if (createdOwnerRow) {
    // Only remove the owner row if it still holds the exact identity this
    // suite created — never touch a real owner's row.
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

describe("agent lifecycle", () => {
  it("creates an agent with full configuration", async () => {
    const res = await createAgent(`${RUN_TAG} Alpha`, {
      specialization: "Integration testing",
      personality: "Rigid and precise.",
      goals: "Keep the suite green.",
      instructions: "Never skip a check.",
      model: "claude-sonnet-4-5",
      voiceStyle: "crisp",
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${RUN_TAG} Alpha`);
    expect(res.body.specialization).toBe("Integration testing");
    expect(res.body.personality).toBe("Rigid and precise.");
    expect(res.body.goals).toBe("Keep the suite green.");
    expect(res.body.instructions).toBe("Never skip a check.");
    expect(res.body.voiceStyle).toBe("crisp");
    expect(res.body.archived).toBe(false);
    expect(res.body.status).toBe("idle");
  });

  it("persists the sensitive data sandbox flag across create, update, and detail", async () => {
    // Default off, for new and existing agents alike.
    const plain = await createAgent(`${RUN_TAG} Sandbox Default`);
    expect(plain.status).toBe(201);
    expect(plain.body.sensitiveDataSandbox).toBe(false);

    const created = await createAgent(`${RUN_TAG} Sandboxed`, {
      sensitiveDataSandbox: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.sensitiveDataSandbox).toBe(true);

    const detail = await request(app).get(`/api/agents/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.sensitiveDataSandbox).toBe(true);

    const list = await request(app).get("/api/agents");
    const listed = (list.body as { id: string; sensitiveDataSandbox: boolean }[]).find(
      (a) => a.id === created.body.id,
    );
    expect(listed?.sensitiveDataSandbox).toBe(true);

    const off = await request(app)
      .patch(`/api/agents/${created.body.id}`)
      .send({ sensitiveDataSandbox: false });
    expect(off.status).toBe(200);
    expect(off.body.sensitiveDataSandbox).toBe(false);

    const on = await request(app)
      .patch(`/api/agents/${created.body.id}`)
      .send({ sensitiveDataSandbox: true });
    expect(on.status).toBe(200);
    expect(on.body.sensitiveDataSandbox).toBe(true);

    // Duplication never inherits the sandbox: the copy starts with no
    // grants, so it starts un-sandboxed too, like any fresh agent.
    const dup = await request(app).post(`/api/agents/${created.body.id}/duplicate`);
    expect(dup.status).toBe(201);
    createdAgentIds.push(dup.body.id);
    expect(dup.body.sensitiveDataSandbox).toBe(false);
  });

  it("rejects duplicate names case-insensitively", async () => {
    const res = await createAgent(`${RUN_TAG.toUpperCase()} ALPHA`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns agent detail with task history", async () => {
    const created = await createAgent(`${RUN_TAG} Bravo`);
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;

    const task = await request(app)
      .post("/api/tasks")
      .send({ agentId, objective: `${RUN_TAG} lifecycle objective` });
    expect(task.status).toBe(201);

    const detail = await request(app).get(`/api/agents/${agentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.id).toBe(agentId);
    expect(detail.body.tasks).toHaveLength(1);
    expect(detail.body.tasks[0].objective).toBe(`${RUN_TAG} lifecycle objective`);
    expect(detail.body.tasks[0].agentName).toBe(`${RUN_TAG} Bravo`);
  });

  it("updates an agent and clears nullable fields with null", async () => {
    const created = await createAgent(`${RUN_TAG} Charlie`, {
      specialization: "Old speciality",
    });
    const agentId = created.body.id as string;

    const updated = await request(app).patch(`/api/agents/${agentId}`).send({
      title: "Promoted Analyst",
      specialization: null,
      personality: "Now cheerful.",
      securityPreset: "observer",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Promoted Analyst");
    expect(updated.body.specialization).toBeNull();
    expect(updated.body.personality).toBe("Now cheerful.");
    expect(updated.body.securityPreset).toBe("observer");
    // Untouched fields survive.
    expect(updated.body.name).toBe(`${RUN_TAG} Charlie`);
  });

  it("rejects renaming onto an existing agent's name", async () => {
    const created = await createAgent(`${RUN_TAG} Delta`);
    const res = await request(app)
      .patch(`/api/agents/${created.body.id}`)
      .send({ name: `${RUN_TAG} Alpha` });
    expect(res.status).toBe(409);
  });

  it("duplicates an agent's configuration under a new name", async () => {
    const created = await createAgent(`${RUN_TAG} Echo`, {
      specialization: "Copy fidelity",
      voiceStyle: "deep",
    });
    const res = await request(app).post(
      `/api/agents/${created.body.id}/duplicate`,
    );
    expect(res.status).toBe(201);
    createdAgentIds.push(res.body.id);
    expect(res.body.name).toBe(`${RUN_TAG} Echo Copy`);
    expect(res.body.specialization).toBe("Copy fidelity");
    expect(res.body.voiceStyle).toBe("deep");
    expect(res.body.status).toBe("idle");

    // A second duplicate picks the next free name.
    const second = await request(app).post(
      `/api/agents/${created.body.id}/duplicate`,
    );
    expect(second.status).toBe(201);
    createdAgentIds.push(second.body.id);
    expect(second.body.name).toBe(`${RUN_TAG} Echo Copy 2`);
  });

  it("survives concurrent duplicates without a server error", async () => {
    const created = await createAgent(`${RUN_TAG} India`);
    const [a, b] = await Promise.all([
      request(app).post(`/api/agents/${created.body.id}/duplicate`),
      request(app).post(`/api/agents/${created.body.id}/duplicate`),
    ]);
    for (const res of [a, b]) {
      expect(res.status).toBe(201);
      createdAgentIds.push(res.body.id);
    }
    expect(a.body.name).not.toBe(b.body.name);
  });

  it("archives and restores an agent", async () => {
    const created = await createAgent(`${RUN_TAG} Foxtrot`);
    const agentId = created.body.id as string;

    const archived = await request(app)
      .post(`/api/agents/${agentId}/archive`)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
    expect(archived.body.status).toBe("paused");
    expect(archived.body.archivedAt).toBeTruthy();

    const task = await request(app)
      .post("/api/tasks")
      .send({ agentId, objective: `${RUN_TAG} should be refused` });
    expect(task.status).toBe(409);

    // Archived agents cannot be resumed through the pause endpoint either.
    const resume = await request(app)
      .post(`/api/agents/${agentId}/pause`)
      .send({ paused: false });
    expect(resume.status).toBe(409);

    const restored = await request(app)
      .post(`/api/agents/${agentId}/archive`)
      .send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    expect(restored.body.archivedAt).toBeNull();
    expect(restored.body.status).toBe("idle");
  });

  it("keeps retirement distinct: retired agents cannot be edited, duplicated, or archived", async () => {
    const created = await createAgent(`${RUN_TAG} Golf`);
    const agentId = created.body.id as string;

    const retired = await request(app).post(`/api/agents/${agentId}/retire`);
    expect(retired.status).toBe(200);

    const edit = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Should not work" });
    expect(edit.status).toBe(409);

    const dup = await request(app).post(`/api/agents/${agentId}/duplicate`);
    expect(dup.status).toBe(409);

    const arch = await request(app)
      .post(`/api/agents/${agentId}/archive`)
      .send({ archived: true });
    expect(arch.status).toBe(409);

    // Retirement is permanent: the Island record cannot be deleted.
    const del = await request(app).delete(`/api/agents/${agentId}`);
    expect(del.status).toBe(409);
  });

  it("permanently deletes an agent along with its task history", async () => {
    const created = await createAgent(`${RUN_TAG} Hotel`);
    const agentId = created.body.id as string;

    const task = await request(app)
      .post("/api/tasks")
      .send({ agentId, objective: `${RUN_TAG} doomed task` });
    expect(task.status).toBe(201);

    const del = await request(app).delete(`/api/agents/${agentId}`);
    expect(del.status).toBe(204);

    const detail = await request(app).get(`/api/agents/${agentId}`);
    expect(detail.status).toBe(404);

    const remaining = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.agentId, agentId));
    expect(remaining).toHaveLength(0);
  });

  it("404s for unknown agents", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await request(app).get(`/api/agents/${missing}`)).status).toBe(404);
    expect(
      (await request(app).patch(`/api/agents/${missing}`).send({ title: "Xy" }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`/api/agents/${missing}`)).status).toBe(404);
  });
});
