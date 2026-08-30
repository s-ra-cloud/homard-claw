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
    if (existing) return ensureConversationWorkspace(existing);
  }
  const [createdRow] = await db
    .insert(providerConversationsTable)
    .values({
      agentId,
      provider,
      threadId: null,
      // Filled in immediately below; the row id names the directory.
      workspacePath: "",
    })
    .returning();
  const created = createdRow!;
  const workspacePath = await ensureCodexWorkspace(agentId, created.id);
  const [updated] = await db
    .update(providerConversationsTable)
    .set({ workspacePath })
    .where(eq(providerConversationsTable.id, created.id))
    .returning();
  return updated ?? { ...created, workspacePath };
}

/**
 * Recreate a conversation's isolated directory if it has gone missing.
 *
 * Workspaces live under scratch storage, so a server restart or a
 * temporary-directory sweep can delete them while the conversation row —
 * and its resumable thread id — survive in the database. Every reuse of an
 * existing conversation must therefore re-ensure the directory, exactly as
 * the account's Codex home is re-materialized before each run; otherwise a
 * resumed task hands the SDK a working directory that no longer exists and
 * the run dies before producing anything.
 *
 * The directory is derived from the agent and conversation ids (the same
 * derivation that named it at creation), so a row whose stored path has
 * drifted is healed to the canonical location.
 */
export async function ensureConversationWorkspace(
  conversation: ProviderConversationRecord,
): Promise<ProviderConversationRecord> {
  const workspacePath = await ensureCodexWorkspace(
    conversation.agentId,
    conversation.id,
  );
  if (conversation.workspacePath === workspacePath) return conversation;
  const [updated] = await db
    .update(providerConversationsTable)
    .set({ workspacePath })
    .where(eq(providerConversationsTable.id, conversation.id))
    .returning();
  return updated ?? { ...conversation, workspacePath };
}

/**
 * Persist the SDK-issued thread id the moment it is emitted. A freshly
 * issued thread id is resumable by definition, so recording one also heals
 * a conversation that was previously marked unresumable (a pinned task that
 * started a new thread after its old one's session files were wiped).
 */
export async function recordThreadId(
  conversationId: string,
  threadId: string,
): Promise<void> {
  await db
    .update(providerConversationsTable)
    .set({ threadId, resumable: true, lastUsedAt: new Date() })
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
