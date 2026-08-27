import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkTelegramText,
  registerTelegramWebhook,
  sendTelegramText,
  telegramFeatureStatus,
} from "./client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configureTelegram() {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456789:AAUnitTestBotTokenSecretValue");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "unit-test-webhook-secret");
}

describe("Telegram client configuration", () => {
  it("stays off unless both infrastructure secrets are configured", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect(telegramFeatureStatus()).toEqual(
      expect.objectContaining({ available: false }),
    );
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "token-only");
    expect(telegramFeatureStatus()).toEqual(
      expect.objectContaining({ available: false }),
    );
  });

  it("does not register or make a network call when the feature is off", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerTelegramWebhook()).resolves.toEqual(
      expect.objectContaining({ registered: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Telegram messages", () => {
  it("chunks long replies at paragraph or whitespace boundaries", () => {
    const chunks = chunkTelegramText(
      `${"first ".repeat(20)}\n\n${"second ".repeat(20)}`,
      50,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 50)).toBe(true);
    expect(chunks.join(" ")).toContain("first");
    expect(chunks.join(" ")).toContain("second");
  });

  it("puts approval buttons only on the final chunk", async () => {
    configureTelegram();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await sendTelegramText("123", "x".repeat(4_100), {
      approvalId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const last = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(first.reply_markup).toBeUndefined();
    expect(last.reply_markup.inline_keyboard[0]).toEqual([
      expect.objectContaining({
        callback_data: "approve:11111111-1111-4111-8111-111111111111",
      }),
      expect.objectContaining({
        callback_data: "reject:11111111-1111-4111-8111-111111111111",
      }),
    ]);
  });

  it("registers the fixed update types against an explicit HTTPS URL", async () => {
    configureTelegram();
    vi.stubEnv(
      "TELEGRAM_WEBHOOK_URL",
      "https://homard.example/api/telegram/webhook",
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerTelegramWebhook()).resolves.toEqual({
      registered: true,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      url: "https://homard.example/api/telegram/webhook",
      secret_token: "unit-test-webhook-secret",
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  });
});
