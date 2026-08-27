const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TIMEOUT_MS = 15_000;

export type TelegramFeatureStatus =
  | {
      available: true;
      reason: null;
      botUsername: string | null;
    }
  | {
      available: false;
      reason: string;
      botUsername: null;
    };

type TelegramConfig = {
  token: string;
  webhookSecret: string;
  botUsername: string | null;
};

export class TelegramConfigError extends Error {}
export class TelegramApiError extends Error {}

function cleanBotUsername(value: string | undefined): string | null {
  const username = value?.trim().replace(/^@/, "") ?? "";
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
}

export function telegramFeatureStatus(): TelegramFeatureStatus {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !webhookSecret) {
    const missing = [
      !token ? "TELEGRAM_BOT_TOKEN" : null,
      !webhookSecret ? "TELEGRAM_WEBHOOK_SECRET" : null,
    ].filter(Boolean);
    return {
      available: false,
      reason: `Telegram is not configured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.`,
      botUsername: null,
    };
  }
  return {
    available: true,
    reason: null,
    botUsername: cleanBotUsername(process.env.TELEGRAM_BOT_USERNAME),
  };
}

function telegramConfig(): TelegramConfig {
  const status = telegramFeatureStatus();
  if (!status.available) throw new TelegramConfigError(status.reason);
  return {
    token: process.env.TELEGRAM_BOT_TOKEN!.trim(),
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!.trim(),
    botUsername: status.botUsername,
  };
}

export function telegramWebhookSecret(): string | null {
  const status = telegramFeatureStatus();
  return status.available ? telegramConfig().webhookSecret : null;
}

/** Split at paragraph boundaries, falling back to whitespace then hard caps. */
export function chunkTelegramText(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const paragraph of clean.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    flush();
    let rest = paragraph;
    while (rest.length > limit) {
      const window = rest.slice(0, limit + 1);
      const newline = window.lastIndexOf("\n");
      const space = window.lastIndexOf(" ");
      const preferred = Math.max(newline, space);
      const cut = preferred >= Math.floor(limit * 0.6) ? preferred : limit;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    current = rest;
  }
  flush();
  return chunks;
}

async function telegramCall(
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { token } = telegramConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${TELEGRAM_API_ORIGIN}/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new TelegramApiError(
        `Telegram rejected ${method} with HTTP ${response.status}.`,
      );
    }
    const result = (await response.json().catch(() => null)) as {
      ok?: unknown;
    } | null;
    if (result?.ok !== true) {
      throw new TelegramApiError(`Telegram rejected ${method}.`);
    }
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    if (error instanceof TelegramConfigError) throw error;
    throw new TelegramApiError(
      error instanceof Error && error.name === "AbortError"
        ? `Telegram ${method} timed out.`
        : `Telegram ${method} could not be reached.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegramText(
  chatId: string,
  text: string,
  options?: {
    approvalId?: string;
  },
): Promise<void> {
  const chunks = chunkTelegramText(text);
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...(isLast && options?.approvalId
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Approve",
                    callback_data: `approve:${options.approvalId}`,
                  },
                  {
                    text: "Reject",
                    callback_data: `reject:${options.approvalId}`,
                  },
                ],
              ],
            },
          }
        : {}),
    });
  }
}

export async function answerTelegramCallback(
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await telegramCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 200),
    show_alert: showAlert,
  });
}

function derivedWebhookUrl(): string | null {
  const configured = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }
  const host = [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_DEV_DOMAIN ?? "",
  ]
    .map((value) => value.trim())
    .find(Boolean);
  return host ? `https://${host}/api/telegram/webhook` : null;
}

export async function registerTelegramWebhook(): Promise<
  { registered: true } | { registered: false; reason: string }
> {
  const status = telegramFeatureStatus();
  if (!status.available) return { registered: false, reason: status.reason };
  const url = derivedWebhookUrl();
  if (!url) {
    return {
      registered: false,
      reason:
        "Telegram is configured, but no public HTTPS webhook URL could be derived. Set TELEGRAM_WEBHOOK_URL or register it manually.",
    };
  }
  await telegramCall("setWebhook", {
    url,
    secret_token: telegramConfig().webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  return { registered: true };
}
