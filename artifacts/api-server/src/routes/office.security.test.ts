/**
 * Production-readiness security coverage:
 *  - unauthenticated requests get 401 on every router group
 *  - a non-owner identity gets 403 everywhere once an owner exists
 *  - the emergency-stop endpoint blocks queued work, blocks new dispatch,
 *    and released tasks can be retried
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate the existing owner, tag and clean up all created rows, and
 * never clobber owner_clerk_id.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  db,
  systemStateTable,
  tasksTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-sec-owner" as string | null }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
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
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let ownerId = "hc-sec-owner";

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) {
    ownerId = owner.value;
  } else {
    await db
      .insert(systemStateTable)
      .values({ key: "owner_clerk_id", value: ownerId });
    createdOwnerRow = true;
  }
  authState.userId = ownerId;
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  if (createdOwnerRow) {
    await db
      .delete(systemStateTable)
      .where(eq(systemStateTable.key, "owner_clerk_id"));
  }
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
];

describe("authentication and ownership", () => {
  it("returns 401 for unauthenticated requests on every router group", async () => {
    authState.userId = null;
    try {
      for (const path of PROTECTED_GETS) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(401);
      }
      // Mutating endpoints are equally gated.
      const post = await request(app)
        .post("/api/emergency-stop")
        .send({ active: true });
      expect(post.status).toBe(401);
      const sse = await request(app).get("/api/events");
      expect(sse.status).toBe(401);
    } finally {
      authState.userId = ownerId;
    }
  });

  it("returns 403 for a non-owner identity on every router group", async () => {
    authState.userId = "hc-sec-intruder";
    try {
      for (const path of PROTECTED_GETS) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(403);
      }
      const post = await request(app)
        .post("/api/emergency-stop")
        .send({ active: true });
      expect(post.status).toBe(403);
      // The intruder attempt must not have replaced the owner.
      const [owner] = await db
        .select()
        .from(systemStateTable)
        .where(eq(systemStateTable.key, "owner_clerk_id"))
        .limit(1);
      expect(owner?.value).toBe(ownerId);
    } finally {
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
  it("blocks queued work, refuses new dispatch, and releases for retry", async () => {
    // Snapshot unrelated queued/running tasks so we can restore them: the
    // endpoint is global by design.
    const preExisting = await db
      .select({
        id: tasksTable.id,
        status: tasksTable.status,
        errorKind: tasksTable.errorKind,
        errorMessage: tasksTable.errorMessage,
      })
      .from(tasksTable)
      .where(inArray(tasksTable.status, ["queued", "running"]));

    const [stopBefore] = await db
      .select()
      .from(systemStateTable)
      .where(eq(systemStateTable.key, "emergency_stop"))
      .limit(1);

    const agentRes = await request(app).post("/api/agents").send({
      name: `${RUN_TAG} Stopper`,
      title: "Security Analyst",
      mission: "Verify the emergency stop.",
      provider: "claude_max",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    });
    expect(agentRes.status).toBe(201);
    createdAgentIds.push(agentRes.body.id);
    // Pause the agent so the live worker never claims the queued row.
    await request(app)
      .post(`/api/agents/${agentRes.body.id}/pause`)
      .send({ paused: true });

    // Insert the queued row directly: dispatch would immediately block it
    // with not_configured when no provider credential is present in the
    // test environment, and this test needs a genuinely queued task.
    const [seeded] = await db
      .insert(tasksTable)
      .values({
        agentId: agentRes.body.id as string,
        objective: `${RUN_TAG}: sit in the queue`,
        provider: "openrouter",
        model: "test-vendor/test-model",
        status: "queued",
        estimatedCostCents: 1,
      })
      .returning();
    const taskId = seeded.id;

    try {
      const engage = await request(app)
        .post("/api/emergency-stop")
        .send({ active: true });
      expect(engage.status).toBe(200);

      const [blocked] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1);
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.errorKind).toBe("emergency_stop");

      // New dispatch while engaged must not produce runnable work.
      const during = await request(app).post("/api/tasks").send({
        agentId: agentRes.body.id,
        objective: `${RUN_TAG}: created during stop`,
      });
      if (during.status === 201) {
        const [row] = await db
          .select()
          .from(tasksTable)
          .where(eq(tasksTable.id, during.body.id))
          .limit(1);
        expect(row?.status).toBe("blocked");
        expect(row?.errorKind).toBe("emergency_stop");
      } else {
        expect([409, 423, 503]).toContain(during.status);
      }

      const release = await request(app)
        .post("/api/emergency-stop")
        .send({ active: false });
      expect(release.status).toBe(200);

      const retry = await request(app).post(`/api/tasks/${taskId}/retry`);
      expect(retry.status).toBe(200);
      const [requeued] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1);
      expect(requeued?.status).toBe("queued");
    } finally {
      // Restore the global flag, but only if it still holds the value our
      // release wrote — never clobber a concurrent operator change.
      if (stopBefore) {
        await db
          .update(systemStateTable)
          .set({ value: stopBefore.value })
          .where(
            and(
              eq(systemStateTable.key, "emergency_stop"),
              eq(systemStateTable.value, "false"),
            ),
          );
      } else {
        await db
          .delete(systemStateTable)
          .where(
            and(
              eq(systemStateTable.key, "emergency_stop"),
              eq(systemStateTable.value, "false"),
            ),
          );
      }
      // Undo only what the global stop itself did to unrelated tasks: rows
      // still blocked with emergency_stop. Anything that transitioned
      // through other means while the test ran is left untouched.
      for (const prior of preExisting) {
        await db
          .update(tasksTable)
          .set({
            status: prior.status,
            errorKind: prior.errorKind,
            errorMessage: prior.errorMessage,
          })
          .where(
            and(
              eq(tasksTable.id, prior.id),
              eq(tasksTable.status, "blocked"),
              eq(tasksTable.errorKind, "emergency_stop"),
            ),
          );
      }
    }
  });
});
