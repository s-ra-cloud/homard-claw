import { afterAll, describe, expect, it } from "vitest";
import { db, pool, workerOwnershipTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  acquireOrRenewOwnership,
  deleteOwnershipRow,
  getOwnershipSnapshot,
  releaseOwnership,
  renewOwnership,
} from "./worker-ownership";

/**
 * Queue-worker ownership primitives. Every test uses its own run-unique
 * ownership key: the production row ("queue-worker") belongs to the live
 * development server's worker and must never be touched from a test.
 */

const RUN = `test-qo-${Date.now()}`;
const usedKeys: string[] = [];
function testKey(name: string): string {
  const key = `${RUN}-${name}`;
  usedKeys.push(key);
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  if (usedKeys.length > 0) {
    await db
      .delete(workerOwnershipTable)
      .where(inArray(workerOwnershipTable.key, usedKeys));
  }
  await pool.end();
});

describe("acquiring and renewing ownership", () => {
  it("acquires a free key at generation 1 and reports a fresh snapshot", async () => {
    const key = testKey("fresh");
    const outcome = await acquireOrRenewOwnership(key, "instance-a", 60_000);
    expect(outcome).toMatchObject({
      state: "acquired",
      generation: 1,
      takeoverFrom: null,
    });

    const snapshot = await getOwnershipSnapshot(key);
    expect(snapshot?.holder).toBe("instance-a");
    expect(snapshot?.generation).toBe(1);
    expect(snapshot?.stale).toBe(false);
  });

  it("renews for the same holder without bumping the generation", async () => {
    const key = testKey("renew");
    const first = await acquireOrRenewOwnership(key, "instance-a", 60_000);
    expect(first.state).toBe("acquired");

    await sleep(10);
    const again = await acquireOrRenewOwnership(key, "instance-a", 60_000);
    expect(again).toMatchObject({
      state: "acquired",
      generation: 1,
      takeoverFrom: null,
    });
    if (first.state === "acquired" && again.state === "acquired") {
      expect(again.expiresAt.getTime()).toBeGreaterThan(
        first.expiresAt.getTime(),
      );
    }

    expect(await renewOwnership(key, "instance-a", 1, 60_000)).toBe(true);
    // Wrong generation or wrong holder: the renewal must be rejected.
    expect(await renewOwnership(key, "instance-a", 2, 60_000)).toBe(false);
    expect(await renewOwnership(key, "instance-b", 1, 60_000)).toBe(false);
  });

  it("puts a competitor on standby while the holder's row is fresh", async () => {
    const key = testKey("standby");
    await acquireOrRenewOwnership(key, "instance-a", 60_000);

    const rival = await acquireOrRenewOwnership(key, "instance-b", 60_000);
    expect(rival.state).toBe("standby");
    if (rival.state === "standby") {
      expect(rival.holder).toBe("instance-a");
      expect(rival.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe("takeover of a stalled holder", () => {
  it("transfers ownership after expiry with a new generation, and fences the old holder", async () => {
    const key = testKey("takeover");
    // "Frozen" holder: acquires, then never heartbeats again.
    await acquireOrRenewOwnership(key, "frozen-instance", 40);
    await sleep(60);

    const rival = await acquireOrRenewOwnership(key, "healthy-instance", 60_000);
    expect(rival).toMatchObject({
      state: "acquired",
      generation: 2,
      takeoverFrom: "frozen-instance",
    });

    // The frozen holder thaws: its renewal is rejected (fencing), and it
    // cannot steal ownership back while the new holder is fresh.
    expect(await renewOwnership(key, "frozen-instance", 1, 60_000)).toBe(false);
    const thawed = await acquireOrRenewOwnership(key, "frozen-instance", 60_000);
    expect(thawed.state).toBe("standby");
    if (thawed.state === "standby") {
      expect(thawed.holder).toBe("healthy-instance");
    }
  });

  it("recovers within a bounded time once heartbeats stop", async () => {
    const key = testKey("bounded");
    const ttlMs = 250;
    const pollMs = 50;
    await acquireOrRenewOwnership(key, "stalling-instance", ttlMs);

    // A standby instance polling every pollMs must own the queue within
    // TTL + one poll (plus scheduling slack) — never "until redeploy".
    const startedAt = Date.now();
    let acquired = false;
    while (!acquired && Date.now() - startedAt < 5_000) {
      const outcome = await acquireOrRenewOwnership(key, "standby-instance", 60_000);
      acquired = outcome.state === "acquired";
      if (!acquired) await sleep(pollMs);
    }
    const elapsed = Date.now() - startedAt;
    expect(acquired).toBe(true);
    expect(elapsed).toBeLessThan(ttlMs + 10 * pollMs + 1_000);

    const snapshot = await getOwnershipSnapshot(key);
    expect(snapshot?.holder).toBe("standby-instance");
    expect(snapshot?.generation).toBe(2);
  });

  it("rejects an expired holder's renewal racing a standby takeover — the old generation stays dead", async () => {
    const key = testKey("expiry-race");
    await acquireOrRenewOwnership(key, "original-holder", 30);
    await sleep(50);

    // The original holder thaws and fires its renewal at the same moment a
    // standby takes over. Whatever the interleaving, the renewal must fail:
    // an expired lease can never be extended, so generation 1 cannot come
    // back to life.
    const [renewed, rival] = await Promise.all([
      renewOwnership(key, "original-holder", 1, 60_000),
      acquireOrRenewOwnership(key, "standby-instance", 60_000),
    ]);
    expect(renewed).toBe(false);
    expect(rival).toMatchObject({ state: "acquired", generation: 2 });

    const snapshot = await getOwnershipSnapshot(key);
    expect(snapshot?.holder).toBe("standby-instance");
    expect(snapshot?.generation).toBe(2);
    // And it stays dead even with no competition around.
    expect(await renewOwnership(key, "original-holder", 1, 60_000)).toBe(false);
  });

  it("treats re-acquiring an expired row as a new generation even for the same holder", async () => {
    const key = testKey("self-expiry");
    await acquireOrRenewOwnership(key, "instance-a", 30);
    await sleep(50);

    // Its own renewal is rejected once the lease lapsed...
    expect(await renewOwnership(key, "instance-a", 1, 60_000)).toBe(false);
    // ...and winning the row back starts a fresh epoch: generation bumps,
    // so anything fenced to generation 1 stays fenced.
    const revived = await acquireOrRenewOwnership(key, "instance-a", 60_000);
    expect(revived).toMatchObject({ state: "acquired", generation: 2 });
    expect(await renewOwnership(key, "instance-a", 1, 60_000)).toBe(false);
    expect(await renewOwnership(key, "instance-a", 2, 60_000)).toBe(true);
  });

  it("lets exactly one of many competing instances win an expired row", async () => {
    const key = testKey("race");
    await acquireOrRenewOwnership(key, "dead-instance", 30);
    await sleep(50);

    const outcomes = await Promise.all(
      ["r1", "r2", "r3", "r4", "r5"].map((rival) =>
        acquireOrRenewOwnership(key, rival, 60_000),
      ),
    );
    const winners = outcomes.filter((o) => o.state === "acquired");
    expect(winners).toHaveLength(1);
    // A single takeover: the generation advanced exactly once.
    const snapshot = await getOwnershipSnapshot(key);
    expect(snapshot?.generation).toBe(2);
  });

  it("marks the snapshot stale once the expiry passes", async () => {
    const key = testKey("stale");
    await acquireOrRenewOwnership(key, "instance-a", 30);
    expect((await getOwnershipSnapshot(key))?.stale).toBe(false);
    await sleep(50);
    expect((await getOwnershipSnapshot(key))?.stale).toBe(true);
  });
});

describe("release", () => {
  it("releases only the caller's own row", async () => {
    const key = testKey("release");
    await acquireOrRenewOwnership(key, "instance-a", 60_000);

    // A non-holder cannot delete the row.
    expect(await releaseOwnership(key, "instance-b")).toBe(false);
    expect(await getOwnershipSnapshot(key)).not.toBeNull();

    // The holder can — and a successor then acquires immediately, without
    // waiting out the TTL (clean-shutdown handoff).
    expect(await releaseOwnership(key, "instance-a")).toBe(true);
    expect(await getOwnershipSnapshot(key)).toBeNull();
    const successor = await acquireOrRenewOwnership(key, "instance-b", 60_000);
    expect(successor.state).toBe("acquired");
  });

  it("never lets a displaced holder delete its successor's row", async () => {
    const key = testKey("release-fenced");
    await acquireOrRenewOwnership(key, "old-instance", 30);
    await sleep(50);
    await acquireOrRenewOwnership(key, "new-instance", 60_000);

    expect(await releaseOwnership(key, "old-instance")).toBe(false);
    expect((await getOwnershipSnapshot(key))?.holder).toBe("new-instance");

    await deleteOwnershipRow(key);
    expect(await getOwnershipSnapshot(key)).toBeNull();
  });
});
