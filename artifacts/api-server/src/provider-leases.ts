import { db, providerLeasesTable } from "@workspace/db";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * Durable, provider-scoped serialization.
 *
 * Some providers cannot tolerate concurrent execution against one
 * credential. Codex is the first: its ChatGPT session lives in a single
 * `auth.json` that the CLI rewrites on every refresh, so two simultaneous
 * runs race on that file and double-spend the allowance.
 *
 * The lease lives in Postgres rather than in memory or an advisory lock so
 * it survives a restart and is visible to the owner. It expires, so a
 * process that dies mid-run cannot wedge the queue; and it is renewed while
 * work is in flight, so a slow-but-alive run is never stolen.
 *
 * Claude Code and OpenRouter take no lease: their concurrency rules are
 * unchanged.
 */

/** This process's identity, so a lease can be recognized as our own. */
export const LEASE_HOLDER = `${process.pid}-${randomUUID().slice(0, 8)}`;

export type LeaseOutcome =
  | { acquired: true }
  | { acquired: false; heldByTaskId: string | null; expiresAt: Date };

export function codexLeaseKey(authFingerprint: string): string {
  return `codex:${authFingerprint}`;
}

/**
 * Take the lease, or report who holds it. A single conditional upsert:
 * insert when free, steal only when the previous holder's lease has
 * expired or when it is our own row for the same task (idempotent retry).
 */
export async function acquireProviderLease(
  key: string,
  taskId: string,
  ttlMs: number,
): Promise<LeaseOutcome> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const [row] = await db
    .insert(providerLeasesTable)
    .values({
      key,
      taskId,
      holder: LEASE_HOLDER,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: providerLeasesTable.key,
      set: {
        taskId,
        holder: LEASE_HOLDER,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
      },
      setWhere: or(
        lt(providerLeasesTable.expiresAt, now),
        and(
          eq(providerLeasesTable.holder, LEASE_HOLDER),
          eq(providerLeasesTable.taskId, taskId),
        ),
      ),
    })
    .returning({ holder: providerLeasesTable.holder });
  if (row) return { acquired: true };
  const [current] = await db
    .select()
    .from(providerLeasesTable)
    .where(eq(providerLeasesTable.key, key))
    .limit(1);
  return {
    acquired: false,
    heldByTaskId: current?.taskId ?? null,
    expiresAt: current?.expiresAt ?? new Date(now.getTime() + ttlMs),
  };
}

/** Push the expiry out while the holder is still working. */
export async function renewProviderLease(
  key: string,
  taskId: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(providerLeasesTable)
    .set({ heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(
      and(
        eq(providerLeasesTable.key, key),
        eq(providerLeasesTable.holder, LEASE_HOLDER),
        eq(providerLeasesTable.taskId, taskId),
      ),
    )
    .returning({ key: providerLeasesTable.key });
  return rows.length > 0;
}

/** Release only our own lease; never another holder's. */
export async function releaseProviderLease(
  key: string,
  taskId: string,
): Promise<void> {
  await db
    .delete(providerLeasesTable)
    .where(
      and(
        eq(providerLeasesTable.key, key),
        eq(providerLeasesTable.holder, LEASE_HOLDER),
        eq(providerLeasesTable.taskId, taskId),
      ),
    );
}

/**
 * Drop leases this process left behind before it restarted. Called once
 * when the worker lease is acquired: our own stale rows can be cleared
 * immediately instead of waiting out their TTL.
 */
export async function releaseOwnStaleLeases(): Promise<number> {
  const rows = await db
    .delete(providerLeasesTable)
    .where(eq(providerLeasesTable.holder, LEASE_HOLDER))
    .returning({ key: providerLeasesTable.key });
  return rows.length;
}

export type LeaseSnapshot = {
  key: string;
  taskId: string | null;
  expiresAt: string;
  expired: boolean;
};

/** Owner-facing view of who is holding what. Contains no credential data. */
export async function listProviderLeases(
  prefix: string,
): Promise<LeaseSnapshot[]> {
  const rows = await db
    .select()
    .from(providerLeasesTable)
    .where(sql`${providerLeasesTable.key} like ${`${prefix}%`}`);
  const now = Date.now();
  return rows.map((row) => ({
    key: row.key,
    taskId: row.taskId,
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() < now,
  }));
}
