import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: true,
  consumeCode: vi.fn(),
  resolveLink: vi.fn(),
  history: vi.fn(),
  converse: vi.fn(),
  decide: vi.fn(),
  send: vi.fn(),
  answer: vi.fn(),
}));

vi.mock("./client", () => ({
  telegramFeatureStatus: () =>
    mocks.available
      ? { available: true, reason: null, botUsername: null }
      : { available: false, reason: "not configured", botUsername: null },
  telegramWebhookSecret: () =>
    mocks.available ? "correct-webhook-secret" : null,
  sendTelegramText: mocks.send,
  answerTelegramCallback: mocks.answer,
}));

vi.mock("./service", () => ({
  consumeTelegramLinkCode: mocks.consumeCode,
  resolveTelegramLink: mocks.resolveLink,
  telegramTalkHistory: mocks.history,
}));

vi.mock("../routes/voice", () => ({
  ConverseWithAgentError: class ConverseWithAgentError extends Error {
    constructor(
      readonly status: number,
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  },
  converseWithAgent: mocks.converse,
}));

vi.mock("../approvals", () => ({
  ApprovalDecisionError: class ApprovalDecisionError extends Error {
    constructor(
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  },
  decideApproval: mocks.decide,
}));

import { ApprovalDecisionError } from "../approvals";
import telegramWebhookRouter, { validTelegramWebhookSecret } from "./webhook";

const app = express();
app.use(express.json());
app.use("/api", telegramWebhookRouter);

const signedPost = (body: unknown) =>
  request(app)
    .post("/api/telegram/webhook")
    .set("X-Telegram-Bot-Api-Secret-Token", "correct-webhook-secret")
    .send(body);

beforeEach(() => {
  mocks.available = true;
  vi.clearAllMocks();
  mocks.consumeCode.mockResolvedValue(null);
  mocks.resolveLink.mockResolvedValue(null);
  mocks.history.mockResolvedValue([]);
  mocks.converse.mockResolvedValue({ reply: "Agent reply" });
  mocks.decide.mockResolvedValue({ status: "approved" });
  mocks.send.mockResolvedValue(undefined);
  mocks.answer.mockResolvedValue(undefined);
});

describe("Telegram webhook authentication", () => {
  it("uses an exact constant-time-compatible comparison", () => {
    expect(validTelegramWebhookSecret("same", "same")).toBe(true);
    expect(validTelegramWebhookSecret("different", "same")).toBe(false);
    expect(validTelegramWebhookSecret(undefined, "same")).toBe(false);
  });

  it("rejects a bad secret before any chat lookup", async () => {
    const response = await request(app)
      .post("/api/telegram/webhook")
      .set("X-Telegram-Bot-Api-Secret-Token", "wrong")
      .send({ message: { message_id: 1, text: "hello", chat: { id: 1 } } });
    expect(response.status).toBe(401);
    expect(mocks.resolveLink).not.toHaveBeenCalled();
  });

  it("refuses the route without contacting Telegram when unconfigured", async () => {
    mocks.available = false;
    const response = await signedPost({});
    expect(response.status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("Telegram inbound routing", () => {
  it("gives an unknown chat one generic reply and performs no conversation", async () => {
    const response = await signedPost({
      message: { message_id: 7, text: "hello", chat: { id: 123 } },
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.converse).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0]![1]).not.toMatch(/workspace|agent exists/i);
  });

  it("binds only through a valid one-time start proof", async () => {
    mocks.consumeCode.mockResolvedValue({
      workspaceId: "ws-1",
      agentId: "a-1",
    });
    await signedPost({
      message: {
        message_id: 8,
        text: "/start one-time-code",
        chat: { id: 123 },
      },
    });
    await vi.waitFor(() =>
      expect(mocks.consumeCode).toHaveBeenCalledWith("123", "one-time-code"),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      "123",
      expect.stringMatching(/connected/i),
    );
  });

  it("preserves Telegram's delivery identity for durable Talk replay", async () => {
    mocks.resolveLink.mockResolvedValue({
      workspaceId: "ws-1",
      agentId: "a-1",
    });
    const update = {
      message: { message_id: 42, text: "Status?", chat: { id: -987 } },
    };
    await signedPost(update);
    await signedPost(update);
    await vi.waitFor(() => expect(mocks.converse).toHaveBeenCalledTimes(2));
    for (const [input] of mocks.converse.mock.calls) {
      expect(input).toEqual(
        expect.objectContaining({
          workspaceId: "ws-1",
          agentId: "a-1",
          clientMessageId: "-987:42",
        }),
      );
    }
  });

  it("derives approval authority from the chat binding", async () => {
    mocks.resolveLink.mockResolvedValue({
      workspaceId: "bound-workspace",
      agentId: "a-1",
    });
    const approvalId = "11111111-1111-4111-8111-111111111111";
    await signedPost({
      callback_query: {
        id: "callback-1",
        data: `approve:${approvalId}`,
        message: { chat: { id: 321 } },
      },
    });
    await vi.waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(1));
    expect(mocks.decide).toHaveBeenCalledWith({
      workspaceId: "bound-workspace",
      approvalId,
      decision: "approved",
    });
    expect(mocks.answer).toHaveBeenCalledWith("callback-1", "Approved.");
  });

  it("answers a stale approval without exposing lookup details", async () => {
    mocks.resolveLink.mockResolvedValue({
      workspaceId: "ws-1",
      agentId: "a-1",
    });
    mocks.decide.mockRejectedValue(
      new ApprovalDecisionError("not_pending", "Pending approval not found"),
    );
    await signedPost({
      callback_query: {
        id: "callback-2",
        data: "reject:11111111-1111-4111-8111-111111111111",
        message: { chat: { id: 321 } },
      },
    });
    await vi.waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(
        "callback-2",
        "This approval is no longer pending.",
      ),
    );
  });
});
