import { createHash } from "node:crypto";
import { auditEventsTable, db } from "@workspace/db";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * Tamper-evident audit log, one hash chain per workspace. Every event
 * written through recordAudit is chained to its workspace's predecessor:
 * hash = sha256(prevHash | kind | summary | createdAt). Editing or deleting
 * any chained row breaks verification of every row after it in that
 * workspace. Rows written before chaining existed have a null hash and are
 * excluded from verification; rows written before workspaces existed were
 * backfilled to the legacy owner's workspace, so its chain stays whole.
 */

/** Anchor value for the first chained event of a workspace. */
const GENESIS = "genesis";

/**
 * Advisory lock namespace serializing chain appends per workspace. Uses the
 * two-int advisory keyspace (classid, objid) which is disjoint from the
 * single-bigint keys elsewhere (worker lease 0x484f4d41, legacy audit
 * 872003), so appends in different workspaces never serialize each other
 * and nothing can queue behind the process-lifetime worker lease.
 */
const AUDIT_CHAIN_CLASS = 872_004;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function computeAuditHash(event: {
  prevHash: string | null;
  kind: string;
  summary: string;
  createdAt: Date;
}): string {
  return createHash("sha256")
    .update(
      [
        event.prevHash ?? GENESIS,
        event.kind,
        event.summary,
        event.createdAt.toISOString(),
      ].join("|"),
    )
    .digest("hex");
}

/**
 * Append a hash-chained audit event to a workspace's chain. Pass the
 * surrounding transaction when the event must commit atomically with the
 * operation it describes; the advisory xact lock serializes concurrent
 * appends within one workspace so its chain never forks. Never insert into
 * auditEventsTable directly.
 */
export async function recordAudit(
  workspaceId: string | null | undefined,
  kind: string,
  summary: string,
  tx?: Tx,
): Promise<void> {
  // A null workspace can only be a legacy row the startup backfill has not
  // stamped yet; there is no chain to append to, so skip rather than fork.
  if (!workspaceId) return;
  const work = async (executor: Tx): Promise<void> => {
    await executor.execute(
      sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_CLASS}, hashtext(${workspaceId}))`,
    );
    const [prev] = await executor
      .select({ hash: auditEventsTable.hash })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.workspaceId, workspaceId))
      .orderBy(desc(auditEventsTable.seq))
      .limit(1);
    const prevHash = prev?.hash ?? GENESIS;
    const createdAt = new Date();
    await executor.insert(auditEventsTable).values({
      workspaceId,
      kind,
      summary,
      prevHash,
      hash: computeAuditHash({ prevHash, kind, summary, createdAt }),
      createdAt,
    });
  };
  if (tx) return work(tx);
  return db.transaction(work);
}

export type AuditVerification = {
  valid: boolean;
  checked: number;
  firstInvalidId: string | null;
};

/**
 * Recompute one workspace's chain in seq order. Any edited summary/kind/
 * time, deleted row, or reordered row surfaces as the first invalid event.
 * The workspace's first chained row must anchor to the genesis marker, so
 * the chain's start cannot be silently rewritten either.
 *
 * Known limitation: deleting ONLY the newest rows (tail truncation) is
 * undetectable from inside the database; `checked` shrinking between runs
 * is the observable hint.
 */
export async function verifyAuditChain(
  workspaceId: string,
  tx?: Tx,
): Promise<AuditVerification> {
  const executor = tx ?? db;
  const rows = await executor
    .select()
    .from(auditEventsTable)
    .where(
      and(
        isNotNull(auditEventsTable.hash),
        eq(auditEventsTable.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(auditEventsTable.seq));
  if (rows.length > 0 && rows[0]!.prevHash !== GENESIS) {
    return { valid: false, checked: 0, firstInvalidId: rows[0]!.id };
  }
  let expectedPrev: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const recomputed = computeAuditHash({
      prevHash: row.prevHash,
      kind: row.kind,
      summary: row.summary,
      createdAt: row.createdAt,
    });
    if (
      recomputed !== row.hash ||
      (expectedPrev !== null && row.prevHash !== expectedPrev)
    ) {
      return { valid: false, checked, firstInvalidId: row.id };
    }
    expectedPrev = row.hash;
    checked += 1;
  }
  return { valid: true, checked, firstInvalidId: null };
}
