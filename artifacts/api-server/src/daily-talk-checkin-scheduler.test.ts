import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentMessagesTable,
  agentsTable,
  dailyTalkCheckinsTable,
  db,
  memoriesTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  randomDailyTalkTime,
  runDueDailyTalkCheckins,
} from "./daily-talk-checkin-scheduler";
import { ProviderCallError } from "./execution";
import { abortProactiveTalk } from "./proactive-talk-runtime";

const RUN = `daily-talk-${Date.now()}`;
const workspaceIds: string[] = [];
let workspaceOne = "";
let workspaceTwo = "";
let agentOne = "";
let agentTwo = "";

async function insertWorkspace(suffix: string): Promise<string> {
  const [row] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `${RUN}-${suffix}` })
    .returning({ id: workspacesTable.id });
  workspaceIds.push(row.id);
  return row.id;
}

async function insertAgent(
  workspaceId: string,
  suffix: string,
): Promise<string> {
  const [row] = await db
    .insert(agentsTable)
    .values({
      workspaceId,
      name: `${RUN} ${suffix}`,
      title: "Reef correspondent",
      mission: "Keep a friendly connection with the owner",
      specialization: "Remembering conversations",
      personality: "Warm, curious, and dryly funny",
      goals: "Ask thoughtful follow-up questions",
      instructions: "Stay concise and in character",
      provider: "openrouter",
      securityPreset: "assistant",
      paused: true,
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
    })
    .returning({ id: agentsTable.id });
  return row.id;
}

async function insertDue(
  workspaceId: string,
  day: string,
  now: Date,
  agentId: string | null = null,
  claimedAt: Date | null = null,
): Promise<string> {
  const [row] = await db
    .insert(dailyTalkCheckinsTable)
    .values({
      workspaceId,
      dayKey: day,
      nextRunAt: new Date(now.getTime() - 60_000),
      agentId,
      claimedAt,
    })
    .returning({ id: dailyTalkCheckinsTable.id });
  return row.id;
}

beforeAll(async () => {
  workspaceOne = await insertWorkspace("one");
  workspaceTwo = await insertWorkspace("two");
  agentOne = await insertAgent(workspaceOne, "Alice");
  agentTwo = await insertAgent(workspaceTwo, "Bob");
});

afterAll(async () => {
  await db
    .delete(workspacesTable)
    .where(inArray(workspacesTable.id, workspaceIds));
  await pool.end();
});

describe("daily proactive Talk check-ins", () => {
  it("chooses a persisted random time inside the requested UTC day", () => {
    const now = new Date("2099-01-01T10:00:00.000Z");
    expect(
      randomDailyTalkTime("2099-01-01", now, true, () => 0).toISOString(),
    ).toBe("2099-01-01T10:02:00.000Z");
    expect(
      randomDailyTalkTime("2099-01-02", now, false, () => 0.999).toISOString(),
    ).toMatch(/^2099-01-02T23:5[34]:/);
  });

  it("sends only once under concurrent ticks and includes character context", async () => {
    const now = new Date("2099-01-03T12:00:00.000Z");
    const checkinId = await insertDue(workspaceOne, "2099-01-03", now);
    await db.insert(agentMessagesTable).values([
      {
        fromAgentId: null,
        toAgentId: agentOne,
        kind: "voice",
        body: `${RUN} owner mentioned a difficult presentation`,
      },
      {
        fromAgentId: agentOne,
        toAgentId: null,
        kind: "voice",
        body: `${RUN} agent asked how preparation was going`,
      },
    ]);
    await db.insert(memoriesTable).values({
      workspaceId: workspaceOne,
      agentId: agentOne,
      kind: "preference",
      content: `${RUN} ask gently about presentations`,
      pinned: true,
    });

    const generate = vi.fn(
      async (
        _workspaceId: string,
        agent: typeof agentsTable.$inferSelect,
        history: Array<{ fromAgentId: string | null; body: string }>,
        pinned: string | null,
      ) => {
        expect(agent.personality).toContain("Warm");
        expect(history.map((message) => message.body).join(" ")).toContain(
          "difficult presentation",
        );
        expect(pinned).toContain("ask gently about presentations");
        return "How did that presentation preparation go, and what’s up today?";
      },
    );
    const opts = {
      workspaceIds: [workspaceOne],
      checkinIds: [checkinId],
      includePausedAgents: true,
      providerReady: async () => true,
      generate,
      random: () => 0,
    };
    const results = await Promise.all([
      runDueDailyTalkCheckins(now, opts),
      runDueDailyTalkCheckins(now, opts),
    ]);

    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    const [occurrence] = await db
      .select()
      .from(dailyTalkCheckinsTable)
      .where(eq(dailyTalkCheckinsTable.id, checkinId));
    expect(occurrence.completedAt).not.toBeNull();
    const messages = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.dailyTalkCheckinId, checkinId));
    expect(messages).toHaveLength(1);
    expect(messages[0].fromAgentId).toBe(agentOne);
    expect(messages[0].kind).toBe("voice");
  });

  it("retries provider failure without switching the selected agent", async () => {
    const now = new Date("2099-01-04T12:00:00.000Z");
    const checkinId = await insertDue(
      workspaceOne,
      "2099-01-04",
      now,
      agentOne,
    );
    await runDueDailyTalkCheckins(now, {
      workspaceIds: [workspaceOne],
      checkinIds: [checkinId],
      includePausedAgents: true,
      providerReady: async () => true,
      generate: async () => {
        const error = new ProviderCallError(
          "rate_limit",
          "temporary provider failure",
        );
        error.turnStarted = false;
        throw error;
      },
    });

    const [occurrence] = await db
      .select()
      .from(dailyTalkCheckinsTable)
      .where(eq(dailyTalkCheckinsTable.id, checkinId));
    expect(occurrence.agentId).toBe(agentOne);
    expect(occurrence.attemptCount).toBe(1);
    expect(occurrence.claimedAt).toBeNull();
    expect(occurrence.completedAt).toBeNull();
    expect(occurrence.nextRunAt.toISOString()).toBe("2099-01-04T12:15:00.000Z");
  });

  it("does not mistake an unrelated Talk message for crash evidence", async () => {
    const now = new Date("2099-01-05T12:00:00.000Z");
    const staleClaim = new Date(now.getTime() - 10 * 60_000);
    const checkinId = await insertDue(
      workspaceOne,
      "2099-01-05",
      now,
      agentOne,
      staleClaim,
    );
    await db.insert(agentMessagesTable).values({
      fromAgentId: agentOne,
      toAgentId: null,
      kind: "voice",
      body: `${RUN} unrelated message`,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const generate = vi.fn(async () => "What’s up after our last chat?");

    await runDueDailyTalkCheckins(now, {
      workspaceIds: [workspaceOne],
      checkinIds: [checkinId],
      includePausedAgents: true,
      providerReady: async () => true,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const linked = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.dailyTalkCheckinId, checkinId));
    expect(linked).toHaveLength(1);
  });

  it("does not process another workspace when explicitly scoped", async () => {
    const now = new Date("2099-01-06T12:00:00.000Z");
    const first = await insertDue(workspaceOne, "2099-01-06", now, agentOne);
    const second = await insertDue(workspaceTwo, "2099-01-06", now, agentTwo);

    await runDueDailyTalkCheckins(now, {
      workspaceIds: [workspaceOne],
      checkinIds: [first],
      includePausedAgents: true,
      providerReady: async () => true,
      generate: async () => "How are things going?",
    });

    const rows = await db
      .select({
        id: dailyTalkCheckinsTable.id,
        completedAt: dailyTalkCheckinsTable.completedAt,
      })
      .from(dailyTalkCheckinsTable)
      .where(
        and(
          inArray(dailyTalkCheckinsTable.id, [first, second]),
          inArray(dailyTalkCheckinsTable.workspaceId, [
            workspaceOne,
            workspaceTwo,
          ]),
        ),
      );
    expect(rows.find((row) => row.id === first)?.completedAt).not.toBeNull();
    expect(rows.find((row) => row.id === second)?.completedAt).toBeNull();
  });

  it("aborts an in-flight check-in without replaying an uncertain turn", async () => {
    const now = new Date("2099-01-07T12:00:00.000Z");
    const checkinId = await insertDue(
      workspaceOne,
      "2099-01-07",
      now,
      agentOne,
    );
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runDueDailyTalkCheckins(now, {
      workspaceIds: [workspaceOne],
      checkinIds: [checkinId],
      includePausedAgents: true,
      providerReady: async () => true,
      generate: async (_workspace, _agent, _history, _pinned, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new ProviderCallError(
                "cancelled",
                "emergency stop",
              );
              error.turnStarted = true;
              reject(error);
            },
            { once: true },
          );
        });
        return "unreachable";
      },
    });
    await providerStarted;
    expect(abortProactiveTalk(workspaceOne)).toBe(1);
    expect(await run).toBe(0);

    const [occurrence] = await db
      .select()
      .from(dailyTalkCheckinsTable)
      .where(eq(dailyTalkCheckinsTable.id, checkinId));
    expect(occurrence.completedAt).not.toBeNull();
    expect(occurrence.attemptCount).toBe(1);
    const linked = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.dailyTalkCheckinId, checkinId));
    expect(linked).toHaveLength(0);
  });
});
