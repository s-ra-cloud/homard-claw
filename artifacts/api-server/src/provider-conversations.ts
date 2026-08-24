import { db, providerConversationsTable } from "@workspace/db";
import type { ProviderConversationRecord } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { ensureCodexWorkspace } from "./codex/execute";
import type { ProviderId } from "./providers";

/**
 * Conversation continuity for providers that keep server-side threads.
 *
 * HomardClaw remains authoritative for identity, memory, permissions,
 * files, and task history — a conversation row holds only the provider's
 * thread id and the isolated directory its runs are confined to. Threads
 * are never shared between agents, and a new conversation always gets a
 * fresh directory.
 */

export type ConversationMode = "new" | "continue";

export async function latestConversation(
  agentId: string,
  provider: ProviderId,
): Promise<ProviderConversationRecord | null> {
  const [row] = await db
    .select()
    .from(providerConversationsTable)
    .where(
      and(
        eq(providerConversationsTable.agentId, agentId),
        eq(providerConversationsTable.provider, provider),
        eq(providerConversationsTable.resumable, true),
      ),
    )
    .orderBy(desc(providerConversationsTable.lastUsedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the conversation a Codex task should run in. "continue" reuses
 * the agent's most recent resumable thread when one exists; anything else
 * starts a fresh thread in a fresh workspace.
 */
export async function resolveConversation(
  agentId: string,
  provider: ProviderId,
  mode: ConversationMode,
): Promise<ProviderConversationRecord> {
  if (mode === "continue") {
    const existing = await latestConversation(agentId, provider);
    if (existing) return existing;
  }
  const [created] = await db
    .insert(providerConversationsTable)
    .values({
      agentId,
      provider,
      threadId: null,
      // Filled in immediately below; the row id names the directory.
      workspacePath: "",
    })
    .returning();
  const workspacePath = await ensureCodexWorkspace(agentId, created.id);
  const [updated] = await db
    .update(providerConversationsTable)
    .set({ workspacePath })
    .where(eq(providerConversationsTable.id, created.id))
    .returning();
  return updated ?? { ...created, workspacePath };
}

/** Persist the SDK-issued thread id the first time it is emitted. */
export async function recordThreadId(
  conversationId: string,
  threadId: string,
): Promise<void> {
  await db
    .update(providerConversationsTable)
    .set({ threadId, lastUsedAt: new Date() })
    .where(eq(providerConversationsTable.id, conversationId));
}

export async function touchConversation(conversationId: string): Promise<void> {
  await db
    .update(providerConversationsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(providerConversationsTable.id, conversationId));
}

/**
 * Mark a thread unresumable. Used when the provider reports the thread is
 * gone, so the next task starts cleanly instead of failing forever.
 */
export async function markConversationUnresumable(
  conversationId: string,
): Promise<void> {
  await db
    .update(providerConversationsTable)
    .set({ resumable: false })
    .where(eq(providerConversationsTable.id, conversationId));
}

export async function getConversation(
  conversationId: string,
): Promise<ProviderConversationRecord | null> {
  const [row] = await db
    .select()
    .from(providerConversationsTable)
    .where(eq(providerConversationsTable.id, conversationId))
    .limit(1);
  return row ?? null;
}
