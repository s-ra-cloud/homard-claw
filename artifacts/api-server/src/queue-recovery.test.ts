import { afterAll, describe, expect, it } from "vitest";
import {
  agentsTable,
  db,
  pool,
  tasksTable,
  taskLogsTable,
  workerOwnershipTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  performQueueRecovery,
  runOwnershipRecoveryOnce,
  setOwnershipForTest,
  setRecoveryImplForTest,
  type OwnershipFence,
} from "./worker";
import {
  acquireOrRenewOwnership,
  getOwnershipSnapshot,
  renewOwnership,
  withOwnershipFence,
  WORKER_INSTANCE_ID,
} from "./worker-ownership";

/**
 * The owner's "Recover queue" escape hatch. Every test binds the recovery
 * skeleton to its own run-unique ownership key: the production row
 * ("queue-worker") belongs to the live development server's worker and
 * must never be touched from a test.
 */

const RUN = `test-qr-${Date.now()}`;
const usedKeys: string[] = [];
function testKey(name: string): string {
  const key = `${RUN}-${name}`;
  usedKeys.push(key);
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let wsId = "";
let agentId = "";
const createdTaskIds: string[] = [];

/** A workspace + agent of our own, so task rows never touch real data. */
async function ensureFixtures(): Promise<void> {
  if (wsId) return;
  const [ws] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `${RUN}-owner` })
    .returning({ id: workspacesTable.id });
  wsId = ws.id;
  const [agent] = await db
    .insert(agentsTable)
    .values({
      workspaceId: wsId,
      name: `${RUN} agent`,
      title: "Recovery Tester",
      mission: "Exercise manual queue recovery.",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    })
    .returning({ id: agentsTable.id });
  agentId = agent.id;
}

/** Insert a task that looks abandoned mid-run by a dead worker. */
async function insertRunningTask(): Promise<string> {
  await ensureFixtures();
  const [task] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId: wsId,
      objective: `${RUN} orphaned objective`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "running",
      providerPhase: "running",
      attempts: 1,
    })
    .returning({ id: tasksTable.id });
  createdTaskIds.push(task.id);
  return task.id;
}

async function taskStatus(id: string): Promise<string> {
  const [row] = await db
    .select({ status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return row!.status;
}

/**
 * Bind the recovery skeleton's acquisition step to a scoped key, exactly
 * the way production binds it to the live key via ensureWorkerOwnership.
 */
function scopedAcquire(key: string, holder: string, ttlMs = 60_000) {
  return async () => {
    const outcome = await acquireOrRenewOwnership(key, holder, ttlMs);
    if (outcome.state === "acquired") {
      return { owned: true as const, generation: outcome.generation, holder };
    }
    const row = await getOwnershipSnapshot(key);
    return {
      owned: false as const,
      generation: row?.generation ?? null,
      holder: row?.holder ?? null,
    };
  };
}

/** Requeue only this suite's orphaned running tasks, never real rows. */
async function requeueOwnOrphans(): Promise<number> {
  const rows = await db
    .update(tasksTable)
    .set({ status: "queued", providerPhase: "queued" })
    .where(
      and(eq(tasksTable.workspaceId, wsId), eq(tasksTable.status, "running")),
    )
    .returning({ id: tasksTable.id });
  return rows.length;
}

/**
 * A workspace-scoped recovery impl that still runs under the REAL
 * ownership fence: the production pass requeues running tasks across the
 * whole database, which a test must never do against shared data.
 */
function scopedRecoveryImpl(fence: OwnershipFence) {
  return withOwnershipFence(fence.key, fence.holder, fence.generation, (tx) =>
    tx
      .update(tasksTable)
      .set({ status: "queued", providerPhase: "queued" })
      .where(
        and(eq(tasksTable.workspaceId, wsId), eq(tasksTable.status, "running")),
      )
      .returning({
        id: tasksTable.id,
        workspaceId: tasksTable.workspaceId,
        threadId: tasksTable.providerThreadId,
      }),
  );
}

afterAll(async () => {
  setOwnershipForTest(null);
  setRecoveryImplForTest(null);
  if (usedKeys.length > 0) {
    await db
      .delete(workerOwnershipTable)
      .where(inArray(workerOwnershipTable.key, usedKeys));
  }
  if (createdTaskIds.length > 0) {
    await db
      .delete(taskLogsTable)
      .where(inArray(taskLogsTable.taskId, createdTaskIds));
    await db.delete(tasksTable).where(inArray(tasksTable.id, createdTaskIds));
  }
  if (wsId) {
    await db.delete(agentsTable).where(eq(agentsTable.workspaceId, wsId));
    await db.delete(workspacesTable).where(eq(workspacesTable.id, wsId));
  }
  await pool.end();
});

describe("refusing to disrupt a healthy worker", () => {
  it("reports healthy_elsewhere and never runs orphan recovery while the holder is fresh", async () => {
    const key = testKey("healthy");
    await acquireOrRenewOwnership(key, "healthy-worker", 60_000);

    let recoveries = 0;
    const result = await performQueueRecovery({
      previousGeneration: null,
      acquire: scopedAcquire(key, "clicking-server"),
      recoverOrphans: async () => {
        recoveries += 1;
        return 0;
      },
    });

    expect(result).toMatchObject({
      outcome: "healthy_elsewhere",
      ownershipChanged: false,
      recoveredTasks: 0,
      holder: "healthy-worker",
      generation: 1,
    });
    expect(recoveries).toBe(0);
    // The healthy holder is untouched: same generation, still renewable.
    const row = await getOwnershipSnapshot(key);
    expect(row?.holder).toBe("healthy-worker");
    expect(row?.generation).toBe(1);
    expect(await renewOwnership(key, "healthy-worker", 1, 60_000)).toBe(true);
  });
});

describe("taking over a stalled worker", () => {
  it("acquires under a new generation, fences the dead holder, and requeues its orphaned task", async () => {
    const key = testKey("stale");
    // The "dead" worker acquired ownership, started a task, then froze.
    await acquireOrRenewOwnership(key, "dead-worker", 40);
    const orphanId = await insertRunningTask();
    await sleep(60);

    const result = await performQueueRecovery({
      previousGeneration: null,
      acquire: scopedAcquire(key, "rescuer"),
      recoverOrphans: requeueOwnOrphans,
    });

    expect(result).toMatchObject({
      outcome: "recovered",
      ownershipChanged: true,
      recoveredTasks: 1,
      holder: "rescuer",
      generation: 2,
    });
    expect(await taskStatus(orphanId)).toBe("queued");
    // The dead worker's epoch is fenced: it can never renew generation 1,
    // so even if it thaws it cannot write results as the queue owner.
    expect(await renewOwnership(key, "dead-worker", 1, 60_000)).toBe(false);
  });

  it("treats repeated clicks as no-ops once the queue is healthy again", async () => {
    const key = testKey("repeat");
    await acquireOrRenewOwnership(key, "dead-worker", 40);
    await sleep(60);

    let recoveries = 0;
    const countingRecovery = async () => {
      recoveries += 1;
      return 0;
    };

    const first = await performQueueRecovery({
      previousGeneration: null,
      acquire: scopedAcquire(key, "rescuer"),
      recoverOrphans: countingRecovery,
    });
    expect(first.outcome).toBe("recovered");
    expect(recoveries).toBe(1);

    // Same server clicks again: it now holds a fresh lease at the same
    // generation, so nothing is reset and recovery does not run again.
    const again = await performQueueRecovery({
      previousGeneration: first.generation,
      acquire: scopedAcquire(key, "rescuer"),
      recoverOrphans: countingRecovery,
    });
    expect(again).toMatchObject({
      outcome: "already_active",
      ownershipChanged: false,
      recoveredTasks: 0,
      generation: first.generation,
    });
    expect(recoveries).toBe(1);

    // A different server clicking now sees a healthy holder and backs off.
    const rival = await performQueueRecovery({
      previousGeneration: null,
      acquire: scopedAcquire(key, "other-server"),
      recoverOrphans: countingRecovery,
    });
    expect(rival.outcome).toBe("healthy_elsewhere");
    expect(rival.holder).toBe("rescuer");
    expect(recoveries).toBe(1);
  });
});

/** Install a durable ownership row so the recovery fence can verify it. */
async function insertOwnershipRow(
  key: string,
  holder: string,
  generation: number,
  ttlMs: number,
): Promise<void> {
  const now = new Date();
  await db.insert(workerOwnershipTable).values({
    key,
    holder,
    generation,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
}

describe("single-flight orphan recovery", () => {
  it("shares one real recovery pass between concurrent triggers and requeues the orphan exactly once", async () => {
    const key = testKey("single-flight");
    const orphanId = await insertRunningTask();
    // Local ownership installed directly (loop not running): the epoch is
    // fresh but has not run its recovery pass yet. The matching durable row
    // must exist because the requeue is fenced against it.
    await insertOwnershipRow(key, WORKER_INSTANCE_ID, 7, 60_000);
    setOwnershipForTest(
      { key, generation: 7, expiresAtMs: Date.now() + 60_000 },
      { recovered: false },
    );
    setRecoveryImplForTest(scopedRecoveryImpl);
    try {
      // Tick loop and manual click racing: both must ride the same pass.
      const [a, b] = await Promise.all([
        runOwnershipRecoveryOnce(),
        runOwnershipRecoveryOnce(),
      ]);
      expect(a).toBe(b);
      expect(a.some((row) => row.id === orphanId)).toBe(true);
      expect(await taskStatus(orphanId)).toBe("queued");

      // The epoch is now recovered: a later trigger is a pure no-op. (A
      // second full pass would have requeued tasks a claimer may already
      // be running again.)
      expect(await runOwnershipRecoveryOnce()).toEqual([]);
    } finally {
      setOwnershipForTest(null);
      setRecoveryImplForTest(null);
    }
  });

  it("aborts without touching tasks when ownership was taken over mid-epoch", async () => {
    const key = testKey("fence-lost");
    const orphanId = await insertRunningTask();
    // This process believes it holds generation 3 with time left on the
    // lease — but the durable row says a successor already took over at
    // generation 4 (its lease expired while a recovery pass was pending).
    await insertOwnershipRow(key, "usurper", 4, 60_000);
    setOwnershipForTest(
      { key, generation: 3, expiresAtMs: Date.now() + 60_000 },
      { recovered: false },
    );
    setRecoveryImplForTest(scopedRecoveryImpl);
    try {
      // The fence sees the foreign generation and aborts: the orphan stays
      // running for the usurper's own recovery pass, and this epoch is NOT
      // marked recovered (there is nothing left for it to own).
      expect(await runOwnershipRecoveryOnce()).toEqual([]);
      expect(await taskStatus(orphanId)).toBe("running");
    } finally {
      setOwnershipForTest(null);
      // Leave no running rows behind for later suites' global passes.
      await db
        .update(tasksTable)
        .set({ status: "failed", providerPhase: "done" })
        .where(eq(tasksTable.id, orphanId));
    }
  });
});
