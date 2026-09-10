import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  pool,
  systemStateTable,
  tasksTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { DOCUMENTATION_AGENT_KEY } from "./documentation";
import { DESK_SEAT_COUNT, OFFICE_DESK_ORDER_SETTING } from "../office-desk-order";

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

const RUN_TAG = `HC Desk ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let ownerId = "";
let wsId = "";
let createdWorkspace = false;
let priorDocumentationAgentId: string | undefined;

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Test Analyst",
      mission: "Sit wherever the office assigns.",
      provider: "claude_max",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      ...extra,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  return res.body as { id: string; name: string };
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
  ownerId = authState.userId;
  const [existingWorkspace] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, ownerId))
    .limit(1);
  const boot = await request(app).get("/api/agents");
  expect(boot.status).toBe(200);
  const [ws] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, ownerId))
    .limit(1);
  wsId = ws.id;
  createdWorkspace = !existingWorkspace;
  const [documentationSetting] = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        eq(workspaceSettingsTable.key, DOCUMENTATION_AGENT_KEY),
      ),
    )
    .limit(1);
  priorDocumentationAgentId = documentationSetting?.value;
});

afterAll(async () => {
  await db
    .delete(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        eq(workspaceSettingsTable.key, OFFICE_DESK_ORDER_SETTING),
      ),
    );
  if (priorDocumentationAgentId) {
    await db
      .insert(workspaceSettingsTable)
      .values({
        workspaceId: wsId,
        key: DOCUMENTATION_AGENT_KEY,
        value: priorDocumentationAgentId,
      })
      .onConflictDoUpdate({
        target: [workspaceSettingsTable.workspaceId, workspaceSettingsTable.key],
        set: { value: priorDocumentationAgentId },
      });
  } else {
    await db
      .delete(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, DOCUMENTATION_AGENT_KEY),
        ),
      );
  }
  if (createdAgentIds.length > 0) {
    await db.delete(tasksTable).where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  if (createdOwnerRow) {
    await db
      .delete(systemStateTable)
      .where(
        and(
          eq(systemStateTable.key, "owner_clerk_id"),
          eq(systemStateTable.value, ownerId),
        ),
      );
  }
  if (createdWorkspace) {
    await db.delete(workspacesTable).where(eq(workspacesTable.id, wsId));
  }
  await pool.end();
});

describe("desk assignment", () => {
  it("404s for an agent that does not exist", async () => {
    const res = await request(app).post(
      "/api/agents/00000000-0000-0000-0000-000000000000/assign-first-desk",
    );
    expect(res.status).toBe(404);
  });

  it("refuses an archived, retired, or sandboxed agent", async () => {
    const archived = await createAgent(`${RUN_TAG} Archived`);
    await db
      .update(agentsTable)
      .set({ archived: true })
      .where(eq(agentsTable.id, archived.id));
    expect(
      (await request(app).post(`/api/agents/${archived.id}/assign-first-desk`))
        .status,
    ).toBe(409);

    const sandboxed = await createAgent(`${RUN_TAG} Sandboxed`, {
      sensitiveDataSandbox: true,
    });
    expect(
      (await request(app).post(`/api/agents/${sandboxed.id}/assign-first-desk`))
        .status,
    ).toBe(409);
  });

  it("refuses an agent on duty at its own station", async () => {
    const guide = await createAgent(`${RUN_TAG} Documentation Guide`);
    await request(app)
      .put("/api/documentation/settings")
      .send({ agentId: guide.id });
    const res = await request(app).post(
      `/api/agents/${guide.id}/assign-first-desk`,
    );
    expect(res.status).toBe(409);
  });

  it("seats a floor-sitting Crustabot at the first desk and shifts occupants right, bumping the fourth off", async () => {
    // With no explicit order yet, the first DESK_SEAT_COUNT eligible agents
    // (alphabetically) default onto a desk, same as the office UI's fallback.
    // Filling all four with agents that sort before "Seat *" guarantees each
    // "Seat *" agent created below starts out floor-sitting.
    for (let index = 1; index <= DESK_SEAT_COUNT; index += 1) {
      await createAgent(`${RUN_TAG} Filler ${index}`);
    }

    const seatOrder: { id: string; name: string }[] = [];
    for (let index = 1; index <= DESK_SEAT_COUNT + 1; index += 1) {
      const agent = await createAgent(`${RUN_TAG} Seat ${index}`);
      seatOrder.push(agent);
      const res = await request(app).post(
        `/api/agents/${agent.id}/assign-first-desk`,
      );
      expect(res.status).toBe(200);
      expect(res.body.agentIds[0]).toBe(agent.id);
      expect(res.body.agentIds.length).toBeLessThanOrEqual(DESK_SEAT_COUNT);
    }
    // After DESK_SEAT_COUNT + 1 sequential assignments, the desk order is
    // fully determined by our own agents regardless of anything already at
    // a desk before this test ran: the most recent DESK_SEAT_COUNT agents,
    // most recently seated first, with the very first one bumped off.
    const expected = seatOrder
      .slice(1)
      .reverse()
      .map((agent) => agent.id);
    const current = await request(app).get("/api/office/desk-order");
    expect(current.status).toBe(200);
    expect(current.body.agentIds).toEqual(expected);

    // Already at a desk: re-assigning the current first occupant is refused.
    const alreadySeated = seatOrder[seatOrder.length - 1]!;
    const repeat = await request(app).post(
      `/api/agents/${alreadySeated.id}/assign-first-desk`,
    );
    expect(repeat.status).toBe(409);

    // The agent bumped off in the very first round is free to be reseated.
    const bumped = seatOrder[0]!;
    const reseated = await request(app).post(
      `/api/agents/${bumped.id}/assign-first-desk`,
    );
    expect(reseated.status).toBe(200);
    expect(reseated.body.agentIds[0]).toBe(bumped.id);
  });
});
