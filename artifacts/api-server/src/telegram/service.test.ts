import { createHash } from "node:crypto";
import {
  agentsTable,
  db,
  pool,
  telegramLinkCodesTable,
  telegramLinksTable,
  workspacesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Keep the integration fixture deletable without touching the append-only
// audit chain. Route/service audit behavior is covered by existing suites.
vi.mock("../audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { consumeTelegramLinkCode, createTelegramLinkCode } from "./service";

const RUN_TAG = `HC Telegram ${Date.now()}`;
const workspaceIds: string[] = [];
let workspaceId = "";
let otherWorkspaceId = "";
let agentId = "";
let otherAgentId = "";
const priorToken = process.env.TELEGRAM_BOT_TOKEN;
const priorSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

async function createWorkspaceWithAgent(suffix: string) {
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `${RUN_TAG} ${suffix}` })
    .returning({ id: workspacesTable.id });
  workspaceIds.push(workspace!.id);
  const [agent] = await db
    .insert(agentsTable)
    .values({
      workspaceId: workspace!.id,
      name: `${RUN_TAG} Agent ${suffix}`,
      title: "Telegram Test Agent",
      mission: "Test Telegram workspace binding.",
      securityPreset: "assistant",
      autonomy: "autonomous",
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
      paused: true,
    })
    .returning({ id: agentsTable.id });
  return { workspaceId: workspace!.id, agentId: agent!.id };
}

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123456789:AAIntegrationTestBotTokenSecret";
  process.env.TELEGRAM_WEBHOOK_SECRET = "integration-webhook-secret";
  const first = await createWorkspaceWithAgent("one");
  const second = await createWorkspaceWithAgent("two");
  workspaceId = first.workspaceId;
  agentId = first.agentId;
  otherWorkspaceId = second.workspaceId;
  otherAgentId = second.agentId;
});

afterAll(async () => {
  for (const id of workspaceIds) {
    await db.delete(workspacesTable).where(eq(workspacesTable.id, id));
  }
  if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = priorToken;
  if (priorSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = priorSecret;
  await pool.end();
});

describe("Telegram link proofs", () => {
  it("stores only a hash and consumes a short-lived code exactly once", async () => {
    const issued = await createTelegramLinkCode({ workspaceId, agentId });
    const [stored] = await db
      .select()
      .from(telegramLinkCodesTable)
      .where(eq(telegramLinkCodesTable.workspaceId, workspaceId))
      .limit(1);
    expect(stored?.codeHash).toBe(
      createHash("sha256").update(issued.code).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(issued.code);

    await expect(
      consumeTelegramLinkCode("900000001", issued.code),
    ).resolves.toEqual({ workspaceId, agentId });
    await expect(
      consumeTelegramLinkCode("900000002", issued.code),
    ).resolves.toBeNull();

    const [link] = await db
      .select()
      .from(telegramLinksTable)
      .where(eq(telegramLinksTable.workspaceId, workspaceId))
      .limit(1);
    expect(link).toMatchObject({ chatId: "900000001", agentId });
  });

  it("will not bind an already-linked chat to another workspace", async () => {
    const issued = await createTelegramLinkCode({
      workspaceId: otherWorkspaceId,
      agentId: otherAgentId,
    });
    await expect(
      consumeTelegramLinkCode("900000001", issued.code),
    ).resolves.toBeNull();
    const links = await db
      .select()
      .from(telegramLinksTable)
      .where(eq(telegramLinksTable.workspaceId, otherWorkspaceId));
    expect(links).toHaveLength(0);
  });
});
