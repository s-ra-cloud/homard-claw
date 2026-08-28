import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import {
  ApprovalDecisionError,
  decideApproval,
  type ApprovalDecision,
} from "../approvals";
import { logger } from "../lib/logger";
import { ConverseWithAgentError, converseWithAgent } from "../routes/voice";
import {
  answerTelegramCallback,
  sendTelegramText,
  telegramFeatureStatus,
  telegramWebhookSecret,
} from "./client";
import {
  consumeTelegramLinkCode,
  resolveTelegramLink,
  telegramTalkHistory,
} from "./service";

type TelegramChat = { id?: number | string };
type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
};
type TelegramCallbackQuery = {
  id?: string;
  data?: string;
  message?: { chat?: TelegramChat };
};
type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

const router: IRouter = Router();
const GENERIC_UNBOUND_REPLY =
  "This chat is not connected. Open Crustabox and create a new Telegram link code.";

let rejectedWebhookSecrets = 0;

/** Exposed for health/diagnostic tests; no secret or chat metadata is retained. */
export function rejectedTelegramWebhookCount(): number {
  return rejectedWebhookSecrets;
}

export function validTelegramWebhookSecret(
  presented: string | undefined,
  expected: string,
): boolean {
  if (!presented) return false;
  // Hash first so timingSafeEqual always receives equal-length buffers; a
  // wrong-length header therefore does not create a secret-length shortcut.
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function chatIdOf(chat: TelegramChat | undefined): string | null {
  if (chat?.id === undefined || chat.id === null) return null;
  const value = String(chat.id);
  return /^-?\d{1,24}$/.test(value) ? value : null;
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = chatIdOf(message.chat);
  const text = message.text?.trim();
  if (!chatId || !text) return;

  const start = /^\/start(?:@[A-Za-z0-9_]{5,32})?\s+([^\s]+)\s*$/.exec(text);
  if (start) {
    const proof = await consumeTelegramLinkCode(chatId, start[1]!);
    await sendTelegramText(
      chatId,
      proof
        ? "Telegram is connected to Crustabox. Messages here now go to your selected Crustabot."
        : GENERIC_UNBOUND_REPLY,
    );
    return;
  }

  const link = await resolveTelegramLink(chatId);
  if (!link) {
    await sendTelegramText(chatId, GENERIC_UNBOUND_REPLY);
    return;
  }
  if (!Number.isSafeInteger(message.message_id)) return;
  const history = await telegramTalkHistory(link.agentId);
  try {
    const reply = await converseWithAgent({
      workspaceId: link.workspaceId,
      agentId: link.agentId,
      text,
      clientMessageId: `${chatId}:${message.message_id}`,
      history,
    });
    await sendTelegramText(chatId, reply.reply);
  } catch (error) {
    // Telegram may retry while the first delivery is still running. The
    // durable Talk claim will produce the authoritative replay on that retry.
    if (error instanceof ConverseWithAgentError && error.kind === "in_flight") {
      return;
    }
    await sendTelegramText(
      chatId,
      error instanceof ConverseWithAgentError
        ? error.message
        : "The agent could not answer right now. Please try again shortly.",
    );
  }
}

function parseApprovalCallback(
  value: string | undefined,
): { decision: ApprovalDecision; approvalId: string } | null {
  const match =
    /^(approve|reject):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      value ?? "",
    );
  if (!match) return null;
  return {
    decision: match[1] === "approve" ? "approved" : "rejected",
    approvalId: match[2]!,
  };
}

async function handleCallback(query: TelegramCallbackQuery): Promise<void> {
  if (!query.id) return;
  const chatId = chatIdOf(query.message?.chat);
  const parsed = parseApprovalCallback(query.data);
  if (!chatId || !parsed) {
    await answerTelegramCallback(query.id, "This action is not available.");
    return;
  }
  const link = await resolveTelegramLink(chatId);
  if (!link) {
    await answerTelegramCallback(query.id, "This action is not available.");
    return;
  }
  try {
    await decideApproval({
      workspaceId: link.workspaceId,
      approvalId: parsed.approvalId,
      decision: parsed.decision,
    });
    await answerTelegramCallback(
      query.id,
      parsed.decision === "approved" ? "Approved." : "Rejected.",
    );
  } catch (error) {
    if (error instanceof ApprovalDecisionError) {
      await answerTelegramCallback(
        query.id,
        "This approval is no longer pending.",
      );
      return;
    }
    throw error;
  }
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  if (update.message) await handleMessage(update.message);
}

router.post("/telegram/webhook", (req: Request, res) => {
  const status = telegramFeatureStatus();
  const expected = telegramWebhookSecret();
  if (!status.available || !expected) {
    res.status(503).json({ ok: false });
    return;
  }
  if (
    !validTelegramWebhookSecret(
      req.get("X-Telegram-Bot-Api-Secret-Token"),
      expected,
    )
  ) {
    rejectedWebhookSecrets += 1;
    res.status(401).json({ ok: false });
    return;
  }

  // Telegram expects a prompt acknowledgement. Slow provider work continues
  // after the response; claim/replay makes a retried delivery idempotent.
  const update: TelegramUpdate =
    req.body && typeof req.body === "object"
      ? (req.body as TelegramUpdate)
      : {};
  res.status(200).json({ ok: true });
  void processUpdate(update).catch((error) => {
    logger.warn(
      {
        failureKind:
          error instanceof Error ? error.constructor.name : "UnknownError",
        updateKind: update.callback_query ? "callback" : "message",
      },
      "Telegram update processing failed",
    );
  });
});

export default router;
