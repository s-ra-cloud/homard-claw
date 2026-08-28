import { db, workerOwnershipTable } from "@workspace/db";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * Durable, expiring queue-worker ownership.
 *
 * Exactly one API instance may drive the task queue (recovery, approvals,
 * schedules, claims). Ownership used to be a session-scoped Postgres
 * advisory lock, but Autoscale can leave the lock-holding instance idle or
 * frozen without closing its connection — the lock never drops, the queue
 * never drains, and only a redeploy recovers. This module stores ownership
 * as a row instead: the holder renews it while healthy, it expires when
 * heartbeats stop, and any standby instance takes over an expired row.
 *
 * `generation` increments on every change of holder AND whenever an expired
 * row is re-acquired — even by its previous holder. Expiry is an epoch
 * boundary: a stale instance that thaws after its lease lapsed fails its
 * next renewal (renewals require an unexpired row) and must abort its local
 * work; a claim it somehow completed before thawing is fenced by the
 * per-attempt check in the worker.
 */

/** The single production ownership row. Tests use their own keys. */
export const QUEUE_OWNERSHIP_KEY = "queue-worker";

/** This process's identity, so ownership can be recognized as our own. */
export const WORKER_INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

export type OwnershipOutcome =
  | {
      state: "acquired";
      generation: number;
      expiresAt: Date;
      /** Set when this acquisition displaced a different (expired) holder. */
      takeoverFrom: string | null;
    }
  | {
      state: "standby";
      holder: string;
      heartbeatAt: Date;
      expiresAt: Date;
    };

/**
 * Acquire, renew, or observe queue ownership in one conditional upsert:
 * - no row → insert ours at generation 1
 * - our FRESH row → renew the heartbeat and expiry, generation unchanged
 * - any EXPIRED row → take over at generation + 1, even when the expired
 *   holder is ourselves: expiry is an epoch boundary, so a process that
 *   thaws after its lease lapsed must start a new generation (and rerun
 *   recovery) rather than silently reviving the old one
 * - another holder's fresh row → standby, report who holds it
 *
 * The upsert's WHERE clause makes acquisition atomic under races: of two
 * instances competing for an expired row, exactly one update applies.
 */
export async function acquireOrRenewOwnership(
  key: string,
  holder: string,
  ttlMs: number,
): Promise<OwnershipOutcome> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  // Read first purely to name the displaced holder in takeover logs; the
  // decision itself is made atomically by the conditional upsert below.
  const [before] = await db
    .select({ holder: workerOwnershipTable.holder })
    .from(workerOwnershipTable)
    .where(eq(workerOwnershipTable.key, key))
    .limit(1);
  const [row] = await db
    .insert(workerOwnershipTable)
    .values({
      key,
      holder,
      generation: 1,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: workerOwnershipTable.key,
      set: {
        holder,
        heartbeatAt: now,
        expiresAt,
        // Only an unexpired renewal by the same holder keeps the generation
        // and original acquisition time. Everything else — a different
        // holder, or the same holder returning to an expired row — is a new
        // generation, so stale local state can never pass a generation check.
        generation: sql`case when ${workerOwnershipTable.holder} = ${holder} and ${workerOwnershipTable.expiresAt} > ${now.toISOString()}::timestamptz then ${workerOwnershipTable.generation} else ${workerOwnershipTable.generation} + 1 end`,
        acquiredAt: sql`case when ${workerOwnershipTable.holder} = ${holder} and ${workerOwnershipTable.expiresAt} > ${now.toISOString()}::timestamptz then ${workerOwnershipTable.acquiredAt} else ${now.toISOString()}::timestamptz end`,
      },
      setWhere: or(
        lt(workerOwnershipTable.expiresAt, now),
        eq(workerOwnershipTable.holder, holder),
      ),
    })
    .returning({
      generation: workerOwnershipTable.generation,
      expiresAt: workerOwnershipTable.expiresAt,
    });
  if (row) {
    return {
      state: "acquired",
      generation: row.generation,
      expiresAt: row.expiresAt,
      takeoverFrom:
        before && before.holder !== holder && row.generation > 1
          ? before.holder
          : null,
    };
  }
  const [current] = await db
    .select()
    .from(workerOwnershipTable)
    .where(eq(workerOwnershipTable.key, key))
    .limit(1);
  if (!current) {
    // The row vanished between our upsert and this read (holder released
    // cleanly). The next poll will acquire it; report standby for now.
    return {
      state: "standby",
      holder: "unknown",
      heartbeatAt: now,
      expiresAt: now,
    };
  }
  return {
    state: "standby",
    holder: current.holder,
    heartbeatAt: current.heartbeatAt,
    expiresAt: current.expiresAt,
  };
}

/**
 * Push the expiry out — but only while the row is still ours at the same
 * generation AND unexpired. An expired lease can never be renewed, even by
 * its original holder: once the TTL lapses the standbys are entitled to
 * take over, so the holder must go back through acquisition (which starts
 * a new generation) instead of racing them back to life. Returns false
 * when ownership has moved on or lapsed: the caller must treat that as
 * fencing and abort local work immediately.
 */
export async function renewOwnership(
  key: string,
  holder: string,
  generation: number,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(workerOwnershipTable)
    .set({ heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(
      and(
        eq(workerOwnershipTable.key, key),
        eq(workerOwnershipTable.holder, holder),
        eq(workerOwnershipTable.generation, generation),
        gt(workerOwnershipTable.expiresAt, now),
      ),
    )
    .returning({ key: workerOwnershipTable.key });
  return rows.length > 0;
}

/**
 * Clean handoff on shutdown: delete only our own row so the next instance
 * can acquire immediately instead of waiting out the TTL. Never touches a
 * row another holder has already taken over.
 */
export async function releaseOwnership(
  key: string,
  holder: string,
): Promise<boolean> {
  const rows = await db
    .delete(workerOwnershipTable)
    .where(
      and(
        eq(workerOwnershipTable.key, key),
        eq(workerOwnershipTable.holder, holder),
      ),
    )
    .returning({ key: workerOwnershipTable.key });
  return rows.length > 0;
}

export type OwnershipSnapshot = {
  holder: string;
  generation: number;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  /** Expired: heartbeats stopped and any instance may take over. */
  stale: boolean;
};

/** Operator-facing view of the durable ownership row. */
export async function getOwnershipSnapshot(
  key: string,
): Promise<OwnershipSnapshot | null> {
  const [row] = await db
    .select()
    .from(workerOwnershipTable)
    .where(eq(workerOwnershipTable.key, key))
    .limit(1);
  if (!row) return null;
  return {
    holder: row.holder,
    generation: row.generation,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    stale: row.expiresAt.getTime() < Date.now(),
  };
}

/** Test cleanup helper: remove a test-scoped ownership row regardless of holder. */
export async function deleteOwnershipRow(key: string): Promise<void> {
  await db
    .delete(workerOwnershipTable)
    .where(eq(workerOwnershipTable.key, key));
}
