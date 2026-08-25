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
    // Nullable only for pre-workspace legacy rows; the startup migration
    // backfills them to the original owner's workspace. Every code path
    // scopes by this column.
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
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
    // Codex-specific routing preferences. Kept separate from `model` so an
    // agent that pins Claude Code or OpenRouter today keeps a remembered
    // Codex model/reasoning choice for when it is switched over.
    codexModel: text("codex_model"),
    codexReasoning: text("codex_reasoning"),
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
    // Sensitive-data sandbox: a server-enforced isolation mode for agents
    // that read confidential email/files. When true the agent keeps its
    // granted READ operations but loses connected-app drafts/writes, all
    // network access under Codex, delegation in both directions, and any
    // shared/global memory or knowledge in its prompt. Always opt-in.
    sensitiveDataSandbox: boolean("sensitive_data_sandbox")
      .notNull()
      .default(false),
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
    // One name per workspace's workforce, case-insensitively, across active,
    // archived, and retired agents.
    uniqueIndex("agents_ws_name_lower_unique").on(
      table.workspaceId,
      sql`lower(${table.name})`,
    ),
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
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    mission: text("mission"),
    leadAgentId: uuid("lead_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teams_ws_name_lower_unique").on(
      table.workspaceId,
      sql`lower(${table.name})`,
    ),
  ],
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
  /**
   * The durable owner of this task's work. Stamped from the agent's
   * workspace at creation and never changed: background execution, approval
   * continuations, retries, and crash recovery all resolve credentials from
   * this column, never from a browser session.
   */
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
    onDelete: "cascade",
  }),
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
  // Set when this task was launched by a durable schedule; notification
  // preferences for the task's lifecycle events come from that schedule.
  scheduleId: uuid("schedule_id"),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("queued"),
  priority: text("priority").notNull().default("normal"),
  budgetCents: doublePrecision("budget_cents"),
  provider: text("provider").notNull(),
  model: text("model"),
  /** Codex reasoning effort selected for this run; null for other providers. */
  reasoningEffort: text("reasoning_effort"),
  /**
   * Fine-grained execution phase inside a coarse `status`. queued |
   * starting | running | waiting_approval | completed | rate_limited |
   * auth_required | failed | cancelled. `status` stays authoritative for
   * the lifecycle; this is what the office displays.
   */
  providerPhase: text("provider_phase"),
  /** Provider-side conversation the task ran in (Codex thread continuity). */
  conversationId: uuid("conversation_id"),
  /** Thread id emitted by the provider SDK for this run, when it has one. */
  providerThreadId: text("provider_thread_id"),
  estimatedTokens: integer("estimated_tokens"),
  estimatedCostCents: doublePrecision("estimated_cost_cents"),
  actualInputTokens: integer("actual_input_tokens"),
  actualOutputTokens: integer("actual_output_tokens"),
  actualCostCents: doublePrecision("actual_cost_cents"),
  /** Granular usage as reported by the provider; null when not exposed. */
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteInputTokens: integer("cache_write_input_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  /** Wall-clock milliseconds spent waiting in the queue / executing. */
  queuedMs: integer("queued_ms"),
  runMs: integer("run_ms"),
  /** Set when this task was moved off its original provider by a fallback. */
  fallbackFromProvider: text("fallback_from_provider"),
  fallbackReason: text("fallback_reason"),
  /** When the owner authorized a paid fallback for this specific task. */
  paidFallbackApprovedAt: timestamp("paid_fallback_approved_at", {
    withTimezone: true,
  }),
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

/** Which lifecycle events a schedule (or the office default) reports on. */
export type NotifyPrefs = {
  onCompleted: boolean;
  onFailed: boolean;
  onBlocked: boolean;
  onApprovalNeeded: boolean;
};

/**
 * Durable dispatch schedules: one-time (`once` + runAt) or recurring
 * (`daily`/`weekly`/`monthly` + timeOfDay in the schedule's IANA timezone).
 * `nextRunAt` is precomputed in UTC so the worker can claim due schedules
 * with a single indexed comparison; after firing, the next occurrence is
 * computed strictly after "now" — a schedule missed while the server was
 * down fires once (catch-up), never once per missed occurrence.
 */
export const schedulesTable = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    objective: text("objective").notNull(),
    priority: text("priority").notNull().default("normal"),
    // Null = follow the agent's own routing.
    providerOverride: text("provider_override"),
    modelOverride: text("model_override"),
    budgetCents: doublePrecision("budget_cents"),
    // once | daily | weekly | monthly
    cadence: text("cadence").notNull(),
    /** IANA timezone the wall-clock fields below are interpreted in. */
    timezone: text("timezone").notNull().default("UTC"),
    /** For `once`: the absolute UTC instant to fire. */
    runAt: timestamp("run_at", { withTimezone: true }),
    /** For recurring cadences: "HH:MM" wall time in `timezone`. */
    timeOfDay: text("time_of_day"),
    /** For `weekly`: days 0 (Sunday) – 6 (Saturday). */
    daysOfWeek: jsonb("days_of_week").$type<number[]>(),
    /** For `monthly`: 1–31, clamped to the month's last day. */
    dayOfMonth: integer("day_of_month"),
    notify: jsonb("notify").$type<NotifyPrefs>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * Two-phase firing marker: set when an occurrence is claimed, cleared
     * when the launch is finalized. A stale claim (crash between the two)
     * is recovered by checking whether the task row exists.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastTaskId: uuid("last_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("schedules_due_idx").on(table.enabled, table.nextRunAt)],
);

/**
 * In-app notification feed. Rows are written by the worker on task
 * lifecycle transitions (completed/failed/blocked/approval-needed);
 * schedule-launched tasks honor their schedule's notify preferences.
 */
export const notificationsTable = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
    // task_completed | task_failed | task_blocked | approval_needed | schedule_error
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    taskId: uuid("task_id").references(() => tasksTable.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("notifications_read_created_idx").on(table.readAt, table.createdAt)],
);

/**
 * A provider-side conversation owned by one agent.
 *
 * Codex threads are stateful: resuming one replays the previous turns. A
 * row here is HomardClaw's record of that thread — which agent owns it,
 * which provider issued it, and the isolated working directory its runs
 * are confined to. HomardClaw stays authoritative for identity, memory,
 * permissions, files, and history; this table only tracks continuity.
 */
export const providerConversationsTable = pgTable(
  "provider_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** Emitted by the SDK on the first turn; null until then. */
    threadId: text("thread_id"),
    /** Absolute path of this conversation's isolated workspace. */
    workspacePath: text("workspace_path").notNull(),
    /** Cleared when the thread can no longer be resumed. */
    resumable: boolean("resumable").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("provider_conversations_agent_idx").on(
      table.agentId,
      table.provider,
      table.lastUsedAt,
    ),
  ],
);

/**
 * One person's Codex sign-in, owned by them and stored by us.
 *
 * Codex authenticates as a ChatGPT account through an `auth.json` the Codex
 * CLI writes and then rewrites on every token refresh. A published app has
 * no durable disk, so the database — not the filesystem — is the source of
 * truth: the credential is written out to a private directory only for the
 * duration of a run, and whatever Codex refreshed is read back here.
 *
 * `authJson` is encrypted before it ever reaches this table; nothing here
 * is readable from a database dump alone. The plaintext is never logged,
 * returned by any endpoint, or exposed to an agent's tools.
 */
export const codexCredentialsTable = pgTable("codex_credentials", {
  /** The Clerk account whose ChatGPT allowance these runs draw on. */
  clerkUserId: text("clerk_user_id").primaryKey(),
  /** AES-256-GCM ciphertext of the whole auth.json. */
  authJson: text("auth_json").notNull(),
  /** "chatgpt" or "api_key", classified when stored. Never a guess. */
  authMode: text("auth_mode").notNull(),
  /**
   * Changes on every write. A run folds its refreshed session back only
   * when this still matches what it started from, so reconnecting or
   * disconnecting mid-run is never undone by the run finishing.
   */
  revision: text("revision")
    .notNull()
    .default(sql`gen_random_uuid()::text`),
  /** `last_refresh` as Codex last wrote it, for staleness reporting. */
  lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CodexCredentialRecord = typeof codexCredentialsTable.$inferSelect;

/**
 * Durable, provider-scoped mutual exclusion.
 *
 * Codex runs against a single ChatGPT auth file; two concurrent runs
 * against it corrupt refreshed credentials and burn the allowance twice.
 * The lease key identifies the resource (for Codex: a hash of the auth
 * file path), never the credential itself. Leases expire so a crashed
 * process cannot wedge the queue forever, and the holder heartbeats while
 * it works. Claude Code and OpenRouter do not take leases.
 */
export const providerLeasesTable = pgTable("provider_leases", {
  key: text("key").primaryKey(),
  taskId: uuid("task_id"),
  holder: text("holder").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
  // Chain scope: each workspace has its own hash chain. Legacy rows are
  // backfilled to the original owner's workspace, preserving one chain.
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
    onDelete: "cascade",
  }),
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

/**
 * Durable idempotency for Talk text messages: each client-generated message
 * id maps to at most one exchange per workspace/agent. A row is claimed
 * (status "pending") before the provider is called and finalized with the
 * response payload; a resend that finds a finished row replays the stored
 * response instead of generating and persisting a duplicate exchange.
 */
export const talkExchangesTable = pgTable(
  "talk_exchanges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    clientMessageId: text("client_message_id").notNull(),
    // pending | done
    status: text("status").notNull().default("pending"),
    responseJson: text("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("talk_exchanges_client_msg_idx").on(
      table.workspaceId,
      table.agentId,
      table.clientMessageId,
    ),
  ],
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
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
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
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
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

/**
 * External applications agents can be granted access to. The catalog is
 * deliberately closed: every app here maps to a Replit-managed connector the
 * workspace owner connects once, and the server refuses anything else.
 */
export const CONNECTED_APP_IDS = ["gmail", "google_drive", "github"] as const;
export type ConnectedAppId = (typeof CONNECTED_APP_IDS)[number];

/**
 * Ordered access levels: read < draft < write. "draft" covers preparing
 * content that stays invisible outside the workspace account (email drafts,
 * new Drive files); "write" is anything another human could see.
 */
export const APP_ACCESS_LEVELS = ["read", "draft", "write"] as const;
export type AppAccessLevel = (typeof APP_ACCESS_LEVELS)[number];

/**
 * Which external apps an agent may touch, and how deeply. No row means no
 * access — grants are explicit per agent and per app, never inherited.
 */
export const agentAppGrantsTable = pgTable(
  "agent_app_grants",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    accessLevel: text("access_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.app] })],
);

/**
 * DEPRECATED global switch table from the single-owner era. Kept only so the
 * startup migration can copy its rows into workspace-scoped settings; no
 * production code path reads or writes it anymore.
 */
export const connectedAppSettingsTable = pgTable("connected_app_settings", {
  app: text("app").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Per-workspace switch per app. A missing row means enabled: the switch
 * exists so a user can cut every one of their agents off from an app at
 * once without touching individual grants.
 */
export const workspaceConnectedAppsTable = pgTable(
  "workspace_connected_apps",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.app] })],
);
/**
 * Durable record of every connected-app action an agent requested. The status
 * column doubles as the exactly-once fence for externally visible writes:
 * waiting_approval → approved → executing → executed/failed, with the
 * approved→executing transition done via a guarded UPDATE so a write can
 * never run twice. Read/draft actions jump straight to executed/denied.
 */
export const appActionsTable = pgTable(
  "app_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    operation: text("operation").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>(),
    /** Human-readable "what/where" shown on approvals and in the audit log. */
    targetSummary: text("target_summary").notNull(),
    // denied | executed | failed | waiting_approval | approved | executing |
    // rejected | expired
    status: text("status").notNull(),
    approvalId: uuid("approval_id").references(() => approvalsTable.id, {
      onDelete: "set null",
    }),
    resultSummary: text("result_summary"),
    errorMessage: text("error_message"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /**
     * When the row last entered "executing" (claim or direct insert). Crash
     * recovery uses it to judge whether a provider's eventually-consistent
     * search has had time to index the interrupted write.
     */
    executingAt: timestamp("executing_at", { withTimezone: true }),
    /**
     * Set the one time crash recovery re-queues a verified-absent approved
     * write. A second crash on the same row settles as unknown instead of
     * re-queueing again — the durable single-retry fence.
     */
    recoveryRequeuedAt: timestamp("recovery_requeued_at", {
      withTimezone: true,
    }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("app_actions_task_idx").on(table.taskId)],
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

export type ScheduleRecord = typeof schedulesTable.$inferSelect;
export type NotificationRecord = typeof notificationsTable.$inferSelect;
export type TeamRecord = typeof teamsTable.$inferSelect;
export type TeamMemberRecord = typeof teamMembersTable.$inferSelect;
export type AgentMessageRecord = typeof agentMessagesTable.$inferSelect;
export type AgentRecord = typeof agentsTable.$inferSelect;
export type TaskRecord = typeof tasksTable.$inferSelect;
export type TaskLogRecord = typeof taskLogsTable.$inferSelect;
export type ApprovalRecord = typeof approvalsTable.$inferSelect;
export type MemoryRecord = typeof memoriesTable.$inferSelect;
export type ProviderConversationRecord =
  typeof providerConversationsTable.$inferSelect;
export type ProviderLeaseRecord = typeof providerLeasesTable.$inferSelect;
export type KnowledgeFileRecord = typeof knowledgeFilesTable.$inferSelect;
export type AgentAppGrantRecord = typeof agentAppGrantsTable.$inferSelect;
export type ConnectedAppSettingRecord =
  typeof connectedAppSettingsTable.$inferSelect;
export type AppActionRecord = typeof appActionsTable.$inferSelect;

export type WorkspaceRecord = typeof workspacesTable.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertApproval = z.infer<typeof insertApprovalSchema>;

/**
 * One personal workspace per Clerk user. Every user-owned root row carries a
 * workspace_id; a user can only ever see or act on rows in their own
 * workspace. The row is created on a user's first authenticated request.
 */
export const workspacesTable = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The Clerk account this workspace belongs to. */
    clerkUserId: text("clerk_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("workspaces_clerk_user_unique").on(table.clerkUserId)],
);

export type GoogleAccountRecord = typeof googleAccountsTable.$inferSelect;

/**
 * One personal Google (Gmail) connection per workspace, created through the
 * in-app OAuth flow. Only the encrypted refresh token is stored; access
 * tokens live in memory for minutes and are never persisted. The row is
 * bound to both the Clerk user and the immutable Google account id (`sub`),
 * so a credential can never silently start serving a different mailbox.
 */
export const googleAccountsTable = pgTable("google_accounts", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull(),
  /** Immutable Google account id from the verified ID token. */
  googleSub: text("google_sub").notNull(),
  /** Safe display label (the Gmail address); never a credential. */
  email: text("email").notNull(),
  /** AES-256-GCM ciphertext of the refresh token. Never logged/returned. */
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  /** Space-separated scopes actually granted at consent time. */
  scopes: text("scopes").notNull(),
  /**
   * Changes on every credential write. Refresh rotation folds a new token
   * back only when the revision still matches what the refresh started
   * from, so a concurrent reconnect/disconnect is never undone.
   */
  revision: text("revision")
    .notNull()
    .default(sql`gen_random_uuid()::text`),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GoogleOauthStateRecord =
  typeof googleOauthStatesTable.$inferSelect;

export type GithubAccountRecord = typeof githubAccountsTable.$inferSelect;

/**
 * One personal GitHub connection per workspace, created through the in-app
 * OAuth flow. GitHub OAuth-app tokens do not expire on a schedule, so only
 * the encrypted access token is stored; it is decrypted per operation and
 * never logged or returned.
 */
export const githubAccountsTable = pgTable("github_accounts", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull(),
  /** Immutable numeric GitHub account id (as text), from GET /user. */
  githubUserId: text("github_user_id").notNull(),
  /** Safe display label (the GitHub login); never a credential. */
  login: text("login").notNull(),
  /** AES-256-GCM ciphertext of the OAuth access token. Never logged. */
  accessTokenEnc: text("access_token_enc").notNull(),
  /** Comma/space-separated scopes granted at consent time. */
  scopes: text("scopes").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GithubOauthStateRecord =
  typeof githubOauthStatesTable.$inferSelect;

/**
 * Single-use GitHub OAuth authorization states, mirroring the Google state
 * table: minted at start, bound to workspace + Clerk session, consumed
 * exactly once by a guarded UPDATE at callback.
 */
export const githubOauthStatesTable = pgTable("github_oauth_states", {
  state: text("state").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull(),
  /** Exact redirect URI the flow started with; token exchange reuses it. */
  redirectUri: text("redirect_uri").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/**
 * Per-workspace key/value preferences (emergency stop, voice transcripts,
 * provider routing settings). Replaces the formerly global system_state keys
 * for anything a user controls; system_state remains for true globals.
 */
export const workspaceSettingsTable = pgTable(
  "workspace_settings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.key] })],
);

export type WorkspaceSettingRecord = typeof workspaceSettingsTable.$inferSelect;

/**
 * Single-use OAuth authorization states. A row proves HomardClaw started
 * the flow for this workspace/session; the callback consumes it exactly
 * once (guarded UPDATE on used_at) and rejects expired or replayed states.
 */
export const googleOauthStatesTable = pgTable("google_oauth_states", {
  /** Random URL-safe state token; primary key so replays collide. */
  state: text("state").primaryKey(),
  /**
   * Which app this consent was started for: "gmail" or "google_drive".
   * The callback validates the granted scopes against exactly this set.
   */
  service: text("service").notNull().default("gmail"),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  /** The Clerk session user that started the flow; must match at callback. */
  clerkUserId: text("clerk_user_id").notNull(),
  /** PKCE code verifier (server-held; useless without the client secret). */
  codeVerifier: text("code_verifier").notNull(),
  /** Nonce echoed inside the Google ID token. */
  nonce: text("nonce").notNull(),
  /** Exact redirect URI the flow started with; token exchange reuses it. */
  redirectUri: text("redirect_uri").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export type WorkspaceConnectedAppRecord =
  typeof workspaceConnectedAppsTable.$inferSelect;
