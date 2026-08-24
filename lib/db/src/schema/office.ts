import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type AvatarConfig = {
  shellColor: string;
  deskStyle: string;
  accessory: string;
  expression?: string;
};

/**
 * Budgets and limits governing what an agent may do. All costs are in
 * cents; null means "no limit" for caps and "any" for providers.
 */
export type AgentPermissions = {
  /** Hard per-task spending cap; tasks estimated above it are denied. */
  maxTaskBudgetCents: number | null;
  /** Rolling per-day spending cap across the agent's tasks. */
  dailyBudgetCents: number | null;
  /** Maximum task attempts the agent may start per day. */
  maxTasksPerDay: number | null;
  /** Estimated cost above which a task needs owner approval (limited autonomy). */
  approvalThresholdCents: number | null;
  /** Providers the agent may use; null allows any configured provider. */
  allowedProviders: string[] | null;
  /** Wall-clock ceiling for a single run before it is interrupted. */
  maxRunSeconds: number | null;
  /** Hard ceiling on output tokens the agent may request per run. */
  maxOutputTokens: number | null;
  /** Attempts a task may make before it stops retrying. */
  maxAttempts: number | null;
  /** How deep a delegation chain rooted at this agent may go; 0 = no delegating. */
  maxDelegationDepth: number | null;
  /** Iteration guard: how many sub-tasks one task may spawn. */
  maxSubtasksPerTask: number | null;
};

/** Owner-set overrides on top of the security-preset profile. */
export type AgentPermissionOverrides = Partial<AgentPermissions>;

export const agentsTable = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    mission: text("mission").notNull(),
    specialization: text("specialization"),
    personality: text("personality"),
    goals: text("goals"),
    instructions: text("instructions"),
    // Null means "follow the workspace default provider".
    provider: text("provider"),
    model: text("model"),
    voiceStyle: text("voice_style"),
    status: text("status").notNull().default("idle"),
    securityPreset: text("security_preset").notNull(),
    // supervised: every task needs approval. limited: tasks above the
    // approval threshold (or with unknown cost) need approval. autonomous:
    // runs anything within its hard budget limits.
    autonomy: text("autonomy").notNull().default("limited"),
    // Custom budgets/limits overriding the securityPreset profile.
    permissionOverrides: jsonb("permission_overrides")
      .$type<AgentPermissionOverrides>(),
    avatar: jsonb("avatar").$type<AvatarConfig>().notNull(),
    paused: boolean("paused").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    retired: boolean("retired").notNull().default(false),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One name per workforce, case-insensitively, across active, archived,
    // and retired agents.
    uniqueIndex("agents_name_lower_unique").on(sql`lower(${table.name})`),
  ],
);

/**
 * A working group. The lead is the only member allowed to delegate, and it
 * may only delegate to other members of the same team — membership IS the
 * delegation authorization list.
 */
export const teamsTable = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    mission: text("mission"),
    leadAgentId: uuid("lead_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("teams_name_lower_unique").on(sql`lower(${table.name})`)],
);

export const teamMembersTable = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.agentId] })],
);

export type TaskFile = {
  name: string;
  content: string;
};

/** A memory or knowledge-file source injected into a task's prompt. */
export type TaskSource = {
  type: "memory" | "file";
  id: string;
  label: string;
  title: string;
};

// Task lifecycle: queued (pending) → running → completed | failed |
// cancelled, with waiting_approval and blocked as holding states. Blocked
// tasks carry an errorKind/errorMessage explaining why and can be retried.
export const tasksTable = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id),
  // Delegation lineage. parentTaskId is the task that spawned this one,
  // rootTaskId the top of the tree (itself for owner-created tasks), and
  // depth the delegation distance from the root, capped by policy.
  parentTaskId: uuid("parent_task_id"),
  rootTaskId: uuid("root_task_id"),
  depth: integer("depth").notNull().default(0),
  teamId: uuid("team_id").references(() => teamsTable.id, {
    onDelete: "set null",
  }),
  delegatedByAgentId: uuid("delegated_by_agent_id").references(
    () => agentsTable.id,
    { onDelete: "set null" },
  ),
  // Which execution runtime should run this task. "native" is the built-in
  // provider runner; other adapters can be registered without a migration.
  runtime: text("runtime").notNull().default("native"),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("queued"),
  priority: text("priority").notNull().default("normal"),
  budgetCents: doublePrecision("budget_cents"),
  provider: text("provider").notNull(),
  model: text("model"),
  estimatedTokens: integer("estimated_tokens"),
  estimatedCostCents: doublePrecision("estimated_cost_cents"),
  actualInputTokens: integer("actual_input_tokens"),
  actualOutputTokens: integer("actual_output_tokens"),
  actualCostCents: doublePrecision("actual_cost_cents"),
  output: text("output"),
  files: jsonb("files").$type<TaskFile[]>().notNull().default([]),
  errorKind: text("error_kind"),
  errorMessage: text("error_message"),
  attempts: integer("attempts").notNull().default(0),
  // Which memories/knowledge files were injected into the prompt, so the
  // UI can show where the result drew from ([M1]/[F1] citations).
  contextSources: jsonb("context_sources").$type<TaskSource[]>(),
  // Earliest time the worker may (re)claim this task; used for rate-limit
  // backoff between attempts.
  notBefore: timestamp("not_before", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const taskLogsTable = pgTable("task_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const approvalsTable = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id),
  // The real task waiting on this approval; the task resumes or cancels
  // when the approval is decided. Null on legacy rows only.
  taskId: uuid("task_id").references(() => tasksTable.id, {
    onDelete: "cascade",
  }),
  action: text("action").notNull(),
  details: text("details").notNull(),
  status: text("status").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Tamper-evident audit log: each event is hash-chained to its predecessor
// (hash = sha256 over prevHash + fields), so any edit or deletion breaks
// verification of every later event. seq gives the chain a total order.
export const auditEventsTable = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  seq: bigserial("seq", { mode: "number" }).notNull().unique(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Messages exchanged around delegated work: a lead briefing a teammate, a
 * teammate reporting back, or the office narrating what happened. A null
 * agent id on either side means the owner/system rather than an agent.
 */
export const agentMessagesTable = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromAgentId: uuid("from_agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    toAgentId: uuid("to_agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    taskId: uuid("task_id").references(() => tasksTable.id, {
      onDelete: "cascade",
    }),
    // delegation | result | note | voice
    kind: text("kind").notNull().default("note"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("agent_messages_task_idx").on(table.taskId)],
);

export const systemStateTable = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Durable agent memory. agentId null = shared office-wide memory available
// to every agent. Disabled memories are kept but never injected into
// prompts; pinned memories are always injected for their scope.
export const memoriesTable = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull().default("fact"),
    content: text("content").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    disabled: boolean("disabled").notNull().default(false),
    // Set when the memory was captured from a finished task.
    sourceTaskId: uuid("source_task_id").references(() => tasksTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memories_content_fts").using(
      "gin",
      sql`to_tsvector('english', ${table.content})`,
    ),
  ],
);

// Owner-uploaded knowledge documents (extracted text only; binaries are
// rejected at upload). Agents only see files explicitly assigned to them.
export const knowledgeFilesTable = pgTable(
  "knowledge_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    description: text("description"),
    content: text("content").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    wordCount: integer("word_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_files_content_fts").using(
      "gin",
      sql`to_tsvector('english', ${table.content})`,
    ),
  ],
);

/** Which agents are authorized to use which knowledge files. */
export const agentKnowledgeTable = pgTable(
  "agent_knowledge",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => knowledgeFilesTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.fileId] })],
);

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  id: true,
  paused: true,
  archived: true,
  archivedAt: true,
  retired: true,
  retiredAt: true,
  createdAt: true,
});
export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  id: true,
  createdAt: true,
});
export const insertApprovalSchema = createInsertSchema(approvalsTable).omit({
  id: true,
  createdAt: true,
});
export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit({
  id: true,
  createdAt: true,
});

export const insertTeamSchema = createInsertSchema(teamsTable).omit({
  id: true,
  createdAt: true,
});

export type TeamRecord = typeof teamsTable.$inferSelect;
export type TeamMemberRecord = typeof teamMembersTable.$inferSelect;
export type AgentMessageRecord = typeof agentMessagesTable.$inferSelect;
export type AgentRecord = typeof agentsTable.$inferSelect;
export type TaskRecord = typeof tasksTable.$inferSelect;
export type TaskLogRecord = typeof taskLogsTable.$inferSelect;
export type ApprovalRecord = typeof approvalsTable.$inferSelect;
export type MemoryRecord = typeof memoriesTable.$inferSelect;
export type KnowledgeFileRecord = typeof knowledgeFilesTable.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertApproval = z.infer<typeof insertApprovalSchema>;
