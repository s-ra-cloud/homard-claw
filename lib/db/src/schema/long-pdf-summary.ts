import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tasksTable } from "./office";

/**
 * Private, revision-bound state for the server-owned complete-PDF summary
 * runner. This intentionally does not live on `tasks`: task rows are returned
 * by several public API shapes while this state contains extracted document
 * text waiting to be synthesized.
 */
export const longPdfSummaryCheckpointsTable = pgTable(
  "long_pdf_summary_checkpoints",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    /**
     * Versioned JSON so a checkpoint can be rejected rather than guessed at
     * after an incompatible server upgrade.
     */
    state: jsonb("state").notNull(),
    // Drive's opaque signed revision token is not necessarily a UUID.
    revisionToken: text("revision_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("long_pdf_summary_checkpoints_updated_idx").on(table.updatedAt)],
);