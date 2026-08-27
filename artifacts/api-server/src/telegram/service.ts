import { createHash, randomBytes } from "node:crypto";
import {
  agentMessagesTable,
  agentsTable,
  approvalsTable,
  db,
  telegramLinkCodesTable,
  telegramLinksTable,
} from "@workspace/db";
import { and, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import { recordAudit } from "../audit";
import type { ConverseTurn } from "../routes/voice";
import {
  sendTelegramText,
  telegramFeatureStatus,
  type TelegramFeatureStatus,
} from "./client";

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 20;

export class TelegramLinkError extends Error {
  constructor(
    readonly kind: "not_configured" | "agent_not_found",
    message: string,
  ) {
    super(message);
    this.name = "TelegramLinkError";
  }
}

function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function requireTelegram(): Extract<
  TelegramFeatureStatus,
  { available: true }
> {
  const status = telegramFeatureStatus();
  if (!status.available) {
    throw new TelegramLinkError("not_configured", status.reason);
  }
  return status;
}

export async function getTelegramStatus(workspaceId: string) {
  const status = telegramFeatureStatus();
  if (!status.available) {
    return {
      available: false,
      reason: status.reason,
      linked: false,
      agentId: null,
      agentName: null,
      verifiedAt: null,
      botUsername: null,
    };
  }
  const [link] = await db
    .select({
      agentId: telegramLinksTable.agentId,
      agentName: agentsTable.name,
      verifiedAt: telegramLinksTable.verifiedAt,
    })
    .from(telegramLinksTable)
    .innerJoin(agentsTable, eq(telegramLinksTable.agentId, agentsTable.id))
    .where(eq(telegramLinksTable.workspaceId, workspaceId))
    .limit(1);
  return {
    available: status.available,
    reason: status.reason,
    linked: Boolean(link),
    agentId: link?.agentId ?? null,
    agentName: link?.agentName ?? null,
    verifiedAt: link?.verifiedAt.toISOString() ?? null,
    botUsername: status.botUsername,
  };
}

export async function createTelegramLinkCode(input: {
  workspaceId: string;
  agentId: string;
}) {
  const status = requireTelegram();
  const [agent] = await db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.id, input.agentId),
        eq(agentsTable.workspaceId, input.workspaceId),
        eq(agentsTable.retired, false),
        eq(agentsTable.archived, false),
      ),
    )
    .limit(1);
  if (!agent) {
    throw new TelegramLinkError(
      "agent_not_found",
      "Choose an active agent from this workspace.",
    );
  }
  const code = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db.transaction(async (tx) => {
    await tx
      .delete(telegramLinkCodesTable)
      .where(
        or(
          eq(telegramLinkCodesTable.workspaceId, input.workspaceId),
          lt(telegramLinkCodesTable.expiresAt, new Date()),
        ),
      );
    await tx.insert(telegramLinkCodesTable).values({
      codeHash: codeHash(code),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      expiresAt,
    });
    await recordAudit(
      input.workspaceId,
      "telegram.link_code_created",
      `A short-lived Telegram link code was created for ${agent.name}.`,
      tx,
    );
  });
  return {
    code,
    expiresAt: expiresAt.toISOString(),
    botUsername: status.botUsername,
  };
}

/** Consume a code exactly once and bind the presenting chat to its workspace. */
export async function consumeTelegramLinkCode(
  chatId: string,
  code: string,
): Promise<{ workspaceId: string; agentId: string } | null> {
  if (!telegramFeatureStatus().available || !code || code.length > 64) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [proof] = await tx
      .update(telegramLinkCodesTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(telegramLinkCodesTable.codeHash, codeHash(code)),
          isNull(telegramLinkCodesTable.usedAt),
          gt(telegramLinkCodesTable.expiresAt, new Date()),
        ),
      )
      .returning({
        workspaceId: telegramLinkCodesTable.workspaceId,
        agentId: telegramLinkCodesTable.agentId,
      });
    if (!proof) return null;
    const [agent] = await tx
      .select({ id: agentsTable.id, name: agentsTable.name })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, proof.agentId),
          eq(agentsTable.workspaceId, proof.workspaceId),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, false),
        ),
      )
      .limit(1);
    if (!agent) return null;
    const [otherBinding] = await tx
      .select({ workspaceId: telegramLinksTable.workspaceId })
      .from(telegramLinksTable)
      .where(
        and(
          eq(telegramLinksTable.chatId, chatId),
          ne(telegramLinksTable.workspaceId, proof.workspaceId),
        ),
      )
      .limit(1);
    if (otherBinding) return null;
    const now = new Date();
    await tx
      .insert(telegramLinksTable)
      .values({
        workspaceId: proof.workspaceId,
        chatId,
        agentId: proof.agentId,
        verifiedAt: now,
      })
      .onConflictDoUpdate({
        target: telegramLinksTable.workspaceId,
        set: { chatId, agentId: proof.agentId, verifiedAt: now },
      });
    await recordAudit(
      proof.workspaceId,
      "telegram.linked",
      `Telegram was linked with ${agent.name} as the default Talk agent.`,
      tx,
    );
    return proof;
  });
}

export async function removeTelegramLink(
  workspaceId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx
      .delete(telegramLinkCodesTable)
      .where(eq(telegramLinkCodesTable.workspaceId, workspaceId));
    const removed = await tx
      .delete(telegramLinksTable)
      .where(eq(telegramLinksTable.workspaceId, workspaceId))
      .returning({ workspaceId: telegramLinksTable.workspaceId });
    if (removed.length > 0) {
      await recordAudit(
        workspaceId,
        "telegram.unlinked",
        "Telegram was unlinked from this workspace.",
        tx,
      );
    }
    return removed.length > 0;
  });
}

export async function resolveTelegramLink(chatId: string) {
  const [link] = await db
    .select({
      workspaceId: telegramLinksTable.workspaceId,
      agentId: telegramLinksTable.agentId,
    })
    .from(telegramLinksTable)
    .where(eq(telegramLinksTable.chatId, chatId))
    .limit(1);
  return link ?? null;
}

export async function telegramTalkHistory(
  agentId: string,
): Promise<ConverseTurn[]> {
  const rows = await db
    .select()
    .from(agentMessagesTable)
    .where(
      and(
        eq(agentMessagesTable.kind, "voice"),
        or(
          eq(agentMessagesTable.fromAgentId, agentId),
          eq(agentMessagesTable.toAgentId, agentId),
        ),
      ),
    )
    .orderBy(desc(agentMessagesTable.createdAt), desc(agentMessagesTable.id))
    .limit(HISTORY_LIMIT);
  return rows
    .reverse()
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        Number(a.fromAgentId !== null) - Number(b.fromAgentId !== null),
    )
    .map((row) => ({
      role: row.fromAgentId === null ? ("user" as const) : ("agent" as const),
      text: row.body,
    }));
}

/** Best-effort caller wraps this; no chat id is ever included in errors. */
export async function pushTelegramNotification(input: {
  workspaceId: string;
  kind: string;
  title: string;
  body: string;
  taskId?: string | null;
}): Promise<void> {
  if (!telegramFeatureStatus().available) return;
  const [link] = await db
    .select({ chatId: telegramLinksTable.chatId })
    .from(telegramLinksTable)
    .where(eq(telegramLinksTable.workspaceId, input.workspaceId))
    .limit(1);
  if (!link) return;
  let approvalId: string | undefined;
  if (input.kind === "approval_needed" && input.taskId) {
    const [approval] = await db
      .select({ id: approvalsTable.id })
      .from(approvalsTable)
      .innerJoin(agentsTable, eq(approvalsTable.agentId, agentsTable.id))
      .where(
        and(
          eq(approvalsTable.taskId, input.taskId),
          eq(approvalsTable.status, "pending"),
          gt(approvalsTable.expiresAt, new Date()),
          // The task id is globally unique, but retain an explicit tenant
          // guard at the point where a mobile approval button is created.
          eq(agentsTable.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(desc(approvalsTable.createdAt))
      .limit(1);
    approvalId = approval?.id;
  }
  await sendTelegramText(link.chatId, `${input.title}\n\n${input.body}`, {
    approvalId,
  });
}
