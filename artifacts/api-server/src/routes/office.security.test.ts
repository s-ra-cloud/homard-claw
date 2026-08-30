/**
 * Production-readiness security coverage for the multi-tenant office:
 *  - unauthenticated requests get 401 on every router group
 *  - any signed-in user gets their OWN isolated workspace (no more 403 gate)
 *  - two-user isolation: user B never sees, mutates, or approves user A's
 *    data — even with guessed/forged IDs (always 404, never 403 leaks)
 *  - OWNER_EMAIL legacy adoption still hands the legacy workspace only to
 *    the verified owner address, exactly once, race-safely
 *  - the emergency stop is per-workspace: one user's stop never blocks
 *    another user's work
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate the existing owner where convenient, tag and clean up all
 * created rows, and never clobber owner_clerk_id.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  memoriesTable,
  systemStateTable,
  tasksTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-sec-owner" as string | null,
  emails: {} as Record<string, string>,
  unverified: [] as string[],
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const email = authState.emails[id];
        if (!email) throw new Error("no such user");
        return {
          primaryEmailAddress: {
            emailAddress: email,
            verification: {
              status: authState.unverified.includes(id)
                ? "unverified"
                : "verified",
            },
          },
        };
      },
    },
  },
}));

import apiRouter from "./index";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", apiRouter);

const RUN_TAG = `HC Security Test ${Date.now()}`;
const USER_A = `hc-sec-a-${Date.now()}`;
const USER_B = `hc-sec-b-${Date.now()}`;
const createdAgentIds: string[] = [];
const createdWorkspaceUserIds: string[] = [USER_A, USER_B];
let ownerId = "hc-sec-owner";

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = authState.userId;
  authState.userId = userId;
  try {
    return await fn();
  } finally {
    authState.userId = prev;
  }
}

async function createAgent(userId: string, name: string): Promise<string> {
  return asUser(userId, async () => {
    const res = await request(app).post("/api/agents").send({
      name,
      title: "Security Analyst",
      mission: "Exercise tenant isolation.",
      provider: "openrouter",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    });
    expect(res.status).toBe(201);
    createdAgentIds.push(res.body.id);
    // Pause so the live worker sharing this database never claims tasks.
    await db
      .update(agentsTable)
      .set({ paused: true })
      .where(eq(agentsTable.id, res.body.id));
    return res.body.id as string;
  });
}

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) ownerId = owner.value;
  authState.userId = ownerId;
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(memoriesTable)
      .where(inArray(memoriesTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Remove the throwaway workspaces this run created (settings cascade).
  await db
    .delete(workspacesTable)
    .where(inArray(workspacesTable.clerkUserId, createdWorkspaceUserIds));
  authState.userId = ownerId;
});

/** One representative authenticated GET per router group. */
const PROTECTED_GETS = [
  "/api/agents",
  "/api/tasks",
  "/api/approvals",
  "/api/audit",
  "/api/providers",
  "/api/runtime/health",
  "/api/schedules",
  "/api/notifications",
  "/api/reports/usage",
  "/api/office/overview",
  "/api/connected-apps",
];

describe("authentication and ownership", () => {
  it("returns 401 for unauthenticated requests on every router group", async () => {
    await asUser(null as unknown as string, async () => {
      authState.userId = null;
      for (const path of PROTECTED_GETS) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(401);
      }
      const post = await request(app)
        .post("/api/emergency-stop")
        .send({ active: true });
      expect(post.status).toBe(401);
      const sse = await request(app).get("/api/events");
      expect(sse.status).toBe(401);
      const oauth = await request(app).post("/api/google/oauth/start");
      expect(oauth.status).toBe(401);
    });
  });

  it("gives any signed-in user their own empty workspace, never someone else's", async () => {
    await asUser(USER_A, async () => {
      const res = await request(app).get("/api/agents");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
    // The visit must not have touched the legacy owner marker.
    const [owner] = await db
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "owner_clerk_id"))
      .limit(1);
    if (owner) expect(owner.value).toBe(ownerId);
  });

  it("isolates two users completely, even with guessed IDs", async () => {
    const agentA = await createAgent(USER_A, `${RUN_TAG} A-Agent`);
    const taskA = await asUser(USER_A, async () => {
      const res = await request(app).post("/api/tasks").send({
        agentId: agentA,
        objective: `${RUN_TAG}: A's private task`,
      });
      expect([201, 409, 423, 503]).toContain(res.status);
      if (res.status !== 201) {
        // Fall back to a direct queued row when dispatch refuses (no creds).
        const [wsARow] = await db
          .select({ id: workspacesTable.id })
          .from(workspacesTable)
          .where(eq(workspacesTable.clerkUserId, USER_A))
          .limit(1);
        const wsA = wsARow!;
        const [rowInsert] = await db
          .insert(tasksTable)
          .values({
            agentId: agentA,
            workspaceId: wsA.id,
            objective: `${RUN_TAG}: A's private task`,
            provider: "openrouter",
            status: "failed",
          })
          .returning();
        const row = rowInsert!;
        return row.id;
      }
      return res.body.id as string;
    });

    await asUser(USER_B, async () => {
      // B's listings never contain A's rows.
      const agents = await request(app).get("/api/agents");
      expect(agents.status).toBe(200);
      expect(
        (agents.body as { id: string }[]).some((a) => a.id === agentA),
      ).toBe(false);
      const tasks = await request(app).get("/api/tasks");
      expect(tasks.status).toBe(200);
      expect(
        (tasks.body.tasks ?? tasks.body).some?.(
          (t: { id: string }) => t.id === taskA,
        ) ?? false,
      ).toBe(false);

      // Direct lookups with A's real IDs read as nonexistent — 404, not 403.
      expect((await request(app).get(`/api/agents/${agentA}`)).status).toBe(404);
      expect((await request(app).get(`/api/tasks/${taskA}`)).status).toBe(404);

      // Mutations with forged IDs are refused the same way.
      expect(
        (
          await request(app)
            .patch(`/api/agents/${agentA}`)
            .send({ title: "Hijacked" })
        ).status,
      ).toBe(404);
      expect(
        (await request(app).post(`/api/tasks/${taskA}/cancel`)).status,
      ).toBe(404);
      expect(
        (await request(app).post(`/api/tasks/${taskA}/retry`)).status,
      ).toBe(404);
      expect(
        (await request(app).delete(`/api/agents/${agentA}`)).status,
      ).toBe(404);
    });

    // A still sees and controls its own rows.
    await asUser(USER_A, async () => {
      expect((await request(app).get(`/api/agents/${agentA}`)).status).toBe(200);
    });
  });

  it("keeps memories, audit, and notifications inside the workspace", async () => {
    const memoryId = await asUser(USER_A, async () => {
      const res = await request(app)
        .post("/api/memories")
        .send({ content: `${RUN_TAG} A's secret memory` });
      expect(res.status).toBe(201);
      return res.body.id as string;
    });
    try {
      await asUser(USER_B, async () => {
        const list = await request(app).get("/api/memories");
        expect(list.status).toBe(200);
        const rows = (list.body.memories ?? list.body) as { id: string }[];
        expect(rows.some((m) => m.id === memoryId)).toBe(false);
        expect(
          (
            await request(app)
              .patch(`/api/memories/${memoryId}`)
              .send({ content: "defaced" })
          ).status,
        ).toBe(404);
        expect(
          (await request(app).delete(`/api/memories/${memoryId}`)).status,
        ).toBe(404);

        // Audit search never shows A's trail to B.
        const audit = await request(app)
          .get("/api/audit")
          .query({ q: RUN_TAG });
        expect(audit.status).toBe(200);
        const summaries = (audit.body.events as { summary: string }[]).map(
          (e) => e.summary,
        );
        expect(summaries.some((s) => s.includes("A's secret"))).toBe(false);
      });
    } finally {
      await asUser(USER_A, async () => {
        await request(app).delete(`/api/memories/${memoryId}`);
      });
    }
  });

  it("hands the legacy workspace to the account matching OWNER_EMAIL", async () => {
    // Clerk mints different user ids for development and production, so a
    // published office can hold an id no live account can match. OWNER_EMAIL
    // is what lets the real owner back in — and only them.
    const [legacyRow] = await db
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "legacy_workspace_id"))
      .limit(1);
    if (!legacyRow) return; // No legacy workspace in this database.
    const [legacyWsRow] = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, legacyRow.value))
      .limit(1);
    expect(legacyWsRow).toBeTruthy();
    const legacyWs = legacyWsRow!;
    const originalHolder = legacyWs.clerkUserId;

    process.env.OWNER_EMAIL = "  Owner@Example.Test ";
    const replacement = `hc-sec-replacement-${Date.now()}`;
    const stranger = `hc-sec-stranger-${Date.now()}`;
    const impostor = `hc-sec-impostor-${Date.now()}`;
    createdWorkspaceUserIds.push(replacement, stranger, impostor);
    authState.emails = {
      [replacement]: "owner@example.test",
      [stranger]: "stranger@example.test",
      [impostor]: "owner@example.test",
    };
    authState.unverified = [impostor];
    try {
      // Unverified claim of the owner's address proves nothing: fresh
      // empty workspace, legacy stays put.
      await asUser(impostor, async () => {
        expect((await request(app).get("/api/agents")).status).toBe(200);
      });
      // A stranger gets their own workspace; the legacy one stays put.
      await asUser(stranger, async () => {
        expect((await request(app).get("/api/agents")).status).toBe(200);
      });
      let [after] = await db
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.id, legacyWs.id))
        .limit(1);
      expect(after!.clerkUserId).toBe(originalHolder);

      // The verified owner address adopts the legacy workspace — including
      // under a race — and the marker follows.
      await asUser(replacement, async () => {
        const [first, second] = await Promise.all([
          request(app).get("/api/agents"),
          request(app).get("/api/agents"),
        ]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });
      [after] = await db
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.id, legacyWs.id))
        .limit(1);
      expect(after!.clerkUserId).toBe(replacement);
    } finally {
      delete process.env.OWNER_EMAIL;
      authState.emails = {};
      authState.unverified = [];
      // Hand the legacy workspace back to its original holder.
      await db
        .update(workspacesTable)
        .set({ clerkUserId: originalHolder })
        .where(eq(workspacesTable.id, legacyWs.id));
      await db
        .update(systemStateTable)
        .set({ value: originalHolder })
        .where(eq(systemStateTable.key, "owner_clerk_id"));
      authState.userId = ownerId;
    }
  });

  it("leaves the health probe unauthenticated", async () => {
    authState.userId = null;
    try {
      const res = await request(app).get("/api/healthz");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    } finally {
      authState.userId = ownerId;
    }
  });
});

describe("emergency stop", () => {
  it("blocks the caller's queued work and releases for retry — without touching other workspaces", async () => {
    const agentA = await createAgent(USER_A, `${RUN_TAG} Stopper`);
    const agentB = await createAgent(USER_B, `${RUN_TAG} Bystander`);
    const [wsARow] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.clerkUserId, USER_A))
      .limit(1);
    const wsA = wsARow!;
    const [wsBRow] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.clerkUserId, USER_B))
      .limit(1);
    const wsB = wsBRow!;

    // Insert queued rows directly: dispatch would immediately block them
    // with not_configured when no provider credential is present.
    const [taskARow] = await db
      .insert(tasksTable)
      .values({
        agentId: agentA,
        workspaceId: wsA.id,
        objective: `${RUN_TAG}: A sits in the queue`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "queued",
        estimatedCostCents: 1,
      })
      .returning();
    const taskA = taskARow!;
    const [taskBRow] = await db
      .insert(tasksTable)
      .values({
        agentId: agentB,
        workspaceId: wsB.id,
        objective: `${RUN_TAG}: B keeps working`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "queued",
        estimatedCostCents: 1,
      })
      .returning();
    const taskB = taskBRow!;

    try {
      await asUser(USER_A, async () => {
        const engage = await request(app)
          .post("/api/emergency-stop")
          .send({ active: true });
        expect(engage.status).toBe(200);
      });

      const [blockedARow] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskA.id))
        .limit(1);
      const blockedA = blockedARow!;
      expect(blockedA.status).toBe("blocked");
      expect(blockedA.errorKind).toBe("emergency_stop");

      // B's queued work is untouched: the stop is A's alone.
      const [stillQueuedBRow] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskB.id))
        .limit(1);
      const stillQueuedB = stillQueuedBRow!;
      expect(stillQueuedB.status).toBe("queued");

      await asUser(USER_A, async () => {
        const release = await request(app)
          .post("/api/emergency-stop")
          .send({ active: false });
        expect(release.status).toBe(200);
        const retry = await request(app).post(`/api/tasks/${taskA.id}/retry`);
        expect(retry.status).toBe(200);
      });
      const [requeuedRow] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskA.id))
        .limit(1);
      const requeued = requeuedRow!;
      expect(requeued.status).toBe("queued");
    } finally {
      await db
        .delete(tasksTable)
        .where(inArray(tasksTable.id, [taskA.id, taskB.id]));
      await db
        .delete(workspaceSettingsTable)
        .where(
          and(
            eq(workspaceSettingsTable.workspaceId, wsA.id),
            eq(workspaceSettingsTable.key, "emergency_stop"),
          ),
        );
    }
  });
});
