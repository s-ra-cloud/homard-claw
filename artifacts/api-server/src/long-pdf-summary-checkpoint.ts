import {
  db,
  longPdfSummaryCheckpointsTable,
  tasksTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  type LongPdfSummaryCheckpoint,
  validateLongPdfSummaryCheckpoint,
} from "./long-pdf-summary";

export class LongPdfCheckpointFenceError extends Error {
  constructor() {
    super("The task is no longer owned by this execution attempt.");
    this.name = "LongPdfCheckpointFenceError";
  }
}

function decode(value: unknown): LongPdfSummaryCheckpoint {
  return validateLongPdfSummaryCheckpoint(value as LongPdfSummaryCheckpoint);
}

/** Private checkpoint lookup. Do not return this state through task APIs. */
export async function loadLongPdfSummaryCheckpoint(
  taskId: string,
): Promise<LongPdfSummaryCheckpoint | null> {
  const [row] = await db
    .select({ state: longPdfSummaryCheckpointsTable.state })
    .from(longPdfSummaryCheckpointsTable)
    .where(eq(longPdfSummaryCheckpointsTable.taskId, taskId))
    .limit(1);
  return row ? decode(row.state) : null;
}

/**
 * Serialize an advance with the live task's running/attempt fence. A crashed
 * process leaves the last fully committed cursor and raw pending chunks for a
 * later claimant; a stale process cannot overwrite a newer task attempt.
 */
export async function saveLongPdfSummaryCheckpoint(input: {
  taskId: string;
  attempts: number;
  checkpoint: LongPdfSummaryCheckpoint;
}): Promise<void> {
  const checkpoint = validateLongPdfSummaryCheckpoint(input.checkpoint);
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.id, input.taskId),
          eq(tasksTable.status, "running"),
          eq(tasksTable.attempts, input.attempts),
        ),
      )
      .for("update")
      .limit(1);
    if (!task) throw new LongPdfCheckpointFenceError();
    const [existing] = await tx
      .select({ revisionToken: longPdfSummaryCheckpointsTable.revisionToken })
      .from(longPdfSummaryCheckpointsTable)
      .where(eq(longPdfSummaryCheckpointsTable.taskId, input.taskId))
      .for("update")
      .limit(1);
    if (existing && existing.revisionToken !== checkpoint.revisionToken) {
      throw new Error(
        "The stored PDF checkpoint revision does not match the attempted update.",
      );
    }
    if (existing) {
      await tx
        .update(longPdfSummaryCheckpointsTable)
        .set({ state: checkpoint, updatedAt: new Date() })
        .where(eq(longPdfSummaryCheckpointsTable.taskId, input.taskId));
    } else {
      await tx.insert(longPdfSummaryCheckpointsTable).values({
        taskId: input.taskId,
        state: checkpoint,
        revisionToken: checkpoint.revisionToken,
      });
    }
  });
}