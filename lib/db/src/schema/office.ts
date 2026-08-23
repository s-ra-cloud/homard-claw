import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
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

export const agentsTable = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  mission: text("mission").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  status: text("status").notNull().default("idle"),
  securityPreset: text("security_preset").notNull(),
  avatar: jsonb("avatar").$type<AvatarConfig>().notNull(),
  paused: boolean("paused").notNull().default(false),
  retired: boolean("retired").notNull().default(false),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tasksTable = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("queued"),
  provider: text("provider").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const approvalsTable = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id),
  action: text("action").notNull(),
  details: text("details").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const auditEventsTable = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const systemStateTable = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  id: true,
  paused: true,
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

export type AgentRecord = typeof agentsTable.$inferSelect;
export type TaskRecord = typeof tasksTable.$inferSelect;
export type ApprovalRecord = typeof approvalsTable.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertApproval = z.infer<typeof insertApprovalSchema>;
