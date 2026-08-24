import { createHash } from "node:crypto";
import { auditEventsTable, db } from "@workspace/db";
import { asc, desc, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * Tamper-evident audit log. Every event written through recordAudit is
 * hash-chained to its predecessor: hash = sha256(prevHash | kind | summary
 * | createdAt). Editing or deleting any chained row breaks verification of
 * every row after it, so the history is inspectable AND its integrity is
 * checkable. Rows written before chaining existed have a null hash and are
 * excluded from verification.
 */

/** Anchor value for the first chained event. */
const GENESIS = "genesis";

/** Advisory lock key serializing chain appends across processes. */
// Distinct from the worker singleton lease (0x484f4d41), which is held for
// the whole process lifetime — sharing that key would deadlock every append.
const AUDIT_CHAIN_LOCK = 872_003;

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
 * Append a hash-chained audit event. Pass the surrounding transaction when
 * the event must commit atomically with the operation it describes; the
 * advisory xact lock serializes concurrent appends so the chain never
 * forks. Never insert into auditEventsTable directly.
 */
export async function recordAudit(
  kind: string,
  summary: string,
  tx?: Tx,
): Promise<void> {
  const work = async (executor: Tx): Promise<void> => {
    await executor.execute(
      sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`,
    );
    const [prev] = await executor
      .select({ hash: auditEventsTable.hash })
      .from(auditEventsTable)
      .orderBy(desc(auditEventsTable.seq))
      .limit(1);
    const prevHash = prev?.hash ?? GENESIS;
    const createdAt = new Date();
    await executor.insert(auditEventsTable).values({
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
 * Recompute the whole chain in seq order. Any edited summary/kind/time,
 * deleted row, or reordered row surfaces as the first invalid event. The
 * first chained row must anchor to the genesis marker, so the chain's
 * start cannot be silently rewritten either.
 *
 * Known limitation: deleting ONLY the newest rows (tail truncation) is
 * undetectable from inside the database — catching that would require an
 * externally anchored copy of the latest hash. `checked` shrinking
 * between runs is the observable hint.
 */
export async function verifyAuditChain(tx?: Tx): Promise<AuditVerification> {
  const executor = tx ?? db;
  const rows = await executor
    .select()
    .from(auditEventsTable)
    .where(isNotNull(auditEventsTable.hash))
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
