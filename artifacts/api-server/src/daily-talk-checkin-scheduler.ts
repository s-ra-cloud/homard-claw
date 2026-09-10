import {
  agentMessagesTable,
  agentsTable,
  dailyTalkCheckinsTable,
  db,
  workspaceSettingsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { publish } from "./events";
import { generateProactiveTalk } from "./routes/voice";
import { buildPinnedInstructions } from "./memory-context";
import { providerReadiness, resolveRouting } from "./providers";
import { logger } from "./lib/logger";
import { ProviderCallError } from "./execution";
import { CodexTalkError } from "./talk-codex";
import { registerProactiveTalk } from "./proactive-talk-runtime";

const CLAIM_TIMEOUT_MS = 5 * 60_000;
const PROVIDER_TIMEOUT_MS = 90_000;
const RETRY_MS = 15 * 60_000;
const MAX_ATTEMPTS = 6;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function randomDailyTalkTime(
  day: string,
  now: Date,
  today: boolean,
  random = Math.random,
): Date {
  const start = new Date(`${day}T00:05:00.000Z`).getTime();
  const end = new Date(`${day}T23:55:00.000Z`).getTime();
  const practicalStart = today
    ? Math.max(start, now.getTime() + 2 * 60_000)
    : start;
  return new Date(
    practicalStart + Math.floor(random() * Math.max(1, end - practicalStart)),
  );
}

export type RunDueDailyTalkCheckinsOptions = {
  /** Test-only scope: only initialize and process these workspaces. */
  workspaceIds?: string[];
  /** Test-only scope: only process these occurrence rows. */
  checkinIds?: string[];
  /** Deterministic random source for tests. */
  random?: () => number;
  /** Provider-call seam for focused scheduler tests. */
  generate?: typeof generateProactiveTalk;
  /** Provider-readiness seam for focused scheduler tests. */
  providerReady?: (
    workspaceId: string,
    agent: typeof agentsTable.$inferSelect,
  ) => Promise<boolean>;
  /** Tests pause their agents so the live worker cannot claim their rows. */
  includePausedAgents?: boolean;
};

async function ensureToday(
  now: Date,
  opts: RunDueDailyTalkCheckinsOptions,
): Promise<void> {
  const today = dayKey(now);
  const todayEnd = new Date(`${today}T23:55:00.000Z`).getTime();
  const day =
    now.getTime() + 2 * 60_000 < todayEnd
      ? today
      : dayKey(new Date(now.getTime() + 86_400_000));
  const workspaces = await db
    .selectDistinct({ workspaceId: agentsTable.workspaceId })
    .from(agentsTable)
    .where(
      and(
        sql`${agentsTable.workspaceId} is not null`,
        ...(opts.workspaceIds
          ? [inArray(agentsTable.workspaceId, opts.workspaceIds)]
          : []),
      ),
    );
  for (const workspace of workspaces) {
    if (!workspace.workspaceId) continue;
    await db
      .insert(dailyTalkCheckinsTable)
      .values({
        workspaceId: workspace.workspaceId,
        dayKey: day,
        nextRunAt: randomDailyTalkTime(day, now, day === today, opts.random),
      })
      .onConflictDoNothing({
        target: [
          dailyTalkCheckinsTable.workspaceId,
          dailyTalkCheckinsTable.dayKey,
        ],
      });
  }
}

function lifecycleEligible(agent: typeof agentsTable.$inferSelect, now: Date) {
  return (
    !agent.archived &&
    !agent.retired &&
    !agent.paused &&
    agent.status !== "paused" &&
    (!agent.onLeaveUntil || agent.onLeaveUntil <= now)
  );
}

async function providerReady(
  workspaceId: string,
  agent: typeof agentsTable.$inferSelect,
): Promise<boolean> {
  try {
    const routing = await resolveRouting(workspaceId, agent);
    const readiness = await providerReadiness(workspaceId, routing.provider);
    return readiness.ready;
  } catch {
    return false;
  }
}

async function eligibleAgent(
  workspaceId: string,
  now: Date,
  random: () => number,
  opts: RunDueDailyTalkCheckinsOptions,
) {
  const candidates = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, workspaceId),
        eq(agentsTable.archived, false),
        eq(agentsTable.retired, false),
        ...(opts.includePausedAgents
          ? []
          : [
              eq(agentsTable.paused, false),
              sql`${agentsTable.status} <> 'paused'`,
            ]),
        or(
          isNull(agentsTable.onLeaveUntil),
          lte(agentsTable.onLeaveUntil, now),
        ),
      ),
    );
  const usable = [];
  for (const agent of candidates) {
    const ready = opts.providerReady ?? providerReady;
    if (await ready(workspaceId, agent)) usable.push(agent);
  }
  return usable.length ? usable[Math.floor(random() * usable.length)] : null;
}

async function finishOccurrence(
  id: string,
  completedAt: Date,
  lastError: string | null = null,
): Promise<void> {
  await db
    .update(dailyTalkCheckinsTable)
    .set({ completedAt, claimedAt: null, lastError })
    .where(eq(dailyTalkCheckinsTable.id, id));
}

async function emergencyStopped(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: workspaceSettingsTable.value })
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        eq(workspaceSettingsTable.key, "emergency_stop"),
      ),
    )
    .limit(1);
  return row?.value === "true";
}

function safeToRetry(error: unknown): boolean {
  if (error instanceof ProviderCallError) {
    return error.retryable && error.turnStarted === false;
  }
  if (error instanceof CodexTalkError) {
    return (
      error.turnStarted === false &&
      ["workspace", "busy", "rate_limit"].includes(error.kind)
    );
  }
  return false;
}

export async function runDueDailyTalkCheckins(
  now = new Date(),
  opts: RunDueDailyTalkCheckinsOptions = {},
): Promise<number> {
  await ensureToday(now, opts);
  const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const dueConditions = [
    isNull(dailyTalkCheckinsTable.completedAt),
    lte(dailyTalkCheckinsTable.nextRunAt, now),
    or(
      isNull(dailyTalkCheckinsTable.claimedAt),
      lte(dailyTalkCheckinsTable.claimedAt, stale),
    ),
    sql`not exists (
      select 1 from ${workspaceSettingsTable}
      where ${workspaceSettingsTable.workspaceId} = ${dailyTalkCheckinsTable.workspaceId}
        and ${workspaceSettingsTable.key} = 'emergency_stop'
        and ${workspaceSettingsTable.value} = 'true'
    )`,
    ...(opts.workspaceIds
      ? [inArray(dailyTalkCheckinsTable.workspaceId, opts.workspaceIds)]
      : []),
    ...(opts.checkinIds
      ? [inArray(dailyTalkCheckinsTable.id, opts.checkinIds)]
      : []),
  ];
  const rows = await db
    .select({ id: dailyTalkCheckinsTable.id })
    .from(dailyTalkCheckinsTable)
    .where(and(...dueConditions))
    .limit(20);
  let sent = 0;
  for (const row of rows) {
    const claim = await db.transaction(
      async (
        tx,
      ): Promise<
        | {
            kind: "dispatch";
            occurrence: typeof dailyTalkCheckinsTable.$inferSelect;
          }
        | {
            kind: "recovered";
            occurrence: typeof dailyTalkCheckinsTable.$inferSelect;
          }
        | null
      > => {
        const [current] = await tx
          .select()
          .from(dailyTalkCheckinsTable)
          .where(
            and(
              eq(dailyTalkCheckinsTable.id, row.id),
              isNull(dailyTalkCheckinsTable.completedAt),
              lte(dailyTalkCheckinsTable.nextRunAt, now),
              or(
                isNull(dailyTalkCheckinsTable.claimedAt),
                lte(dailyTalkCheckinsTable.claimedAt, stale),
              ),
            ),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!current) return null;
        if (current.claimedAt) {
          const [evidence] = await tx
            .select({ id: agentMessagesTable.id })
            .from(agentMessagesTable)
            .where(eq(agentMessagesTable.dailyTalkCheckinId, current.id))
            .limit(1);
          if (evidence) return { kind: "recovered", occurrence: current };
        }
        await tx
          .update(dailyTalkCheckinsTable)
          .set({ claimedAt: now })
          .where(eq(dailyTalkCheckinsTable.id, row.id));
        return { kind: "dispatch", occurrence: current };
      },
    );
    if (!claim) continue;
    const occurrence = claim.occurrence;
    if (claim.kind === "recovered") {
      await finishOccurrence(occurrence.id, now);
      publish(occurrence.workspaceId, "talk", "messages", "overview");
      sent++;
      continue;
    }
    if (occurrence.dayKey !== dayKey(now)) {
      await finishOccurrence(
        occurrence.id,
        now,
        "Skipped after its UTC day ended",
      );
      continue;
    }
    try {
      if (await emergencyStopped(occurrence.workspaceId)) {
        await db
          .update(dailyTalkCheckinsTable)
          .set({ claimedAt: null })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
        continue;
      }
      const random = opts.random ?? Math.random;
      let agent = occurrence.agentId
        ? (
            await db
              .select()
              .from(agentsTable)
              .where(eq(agentsTable.id, occurrence.agentId))
              .limit(1)
          )[0]
        : await eligibleAgent(occurrence.workspaceId, now, random, opts);
      if (
        !agent ||
        agent.workspaceId !== occurrence.workspaceId ||
        (!opts.includePausedAgents && !lifecycleEligible(agent, now)) ||
        agent.archived ||
        agent.retired
      ) {
        await db
          .update(dailyTalkCheckinsTable)
          .set({
            agentId: null,
            claimedAt: null,
            nextRunAt: new Date(now.getTime() + RETRY_MS),
            lastError: "No eligible configured agent",
          })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
        continue;
      }
      if (
        occurrence.agentId &&
        !(await (opts.providerReady ?? providerReady)(
          occurrence.workspaceId,
          agent,
        ))
      ) {
        await db
          .update(dailyTalkCheckinsTable)
          .set({
            claimedAt: null,
            nextRunAt: new Date(now.getTime() + RETRY_MS),
            lastError: "The selected agent's provider is not ready",
          })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
        continue;
      }
      if (!occurrence.agentId) {
        await db
          .update(dailyTalkCheckinsTable)
          .set({ agentId: agent.id })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
      }
      const history = await db
        .select({
          fromAgentId: agentMessagesTable.fromAgentId,
          body: agentMessagesTable.body,
        })
        .from(agentMessagesTable)
        .where(
          and(
            or(
              eq(agentMessagesTable.fromAgentId, agent.id),
              eq(agentMessagesTable.toAgentId, agent.id),
            ),
            inArray(agentMessagesTable.kind, ["voice", "chat_question"]),
          ),
        )
        .orderBy(sql`${agentMessagesTable.createdAt} desc`)
        .limit(12);
      const pinned = await buildPinnedInstructions(
        agent.id,
        occurrence.workspaceId,
        { sensitiveDataSandbox: agent.sensitiveDataSandbox },
      );
      const generate = opts.generate ?? generateProactiveTalk;
      const controller = new AbortController();
      const unregister = registerProactiveTalk(
        occurrence.workspaceId,
        controller,
      );
      const timeout = setTimeout(
        () => controller.abort("proactive_talk_timeout"),
        PROVIDER_TIMEOUT_MS,
      );
      let body: string;
      try {
        body = await generate(
          occurrence.workspaceId,
          agent,
          history.reverse(),
          pinned,
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
        unregister();
      }
      if (!body) throw new Error("Provider returned an empty check-in");
      if (await emergencyStopped(occurrence.workspaceId)) {
        await finishOccurrence(
          occurrence.id,
          now,
          "Skipped because emergency stop was engaged during generation",
        );
        continue;
      }
      await db.insert(agentMessagesTable).values({
        fromAgentId: agent.id,
        toAgentId: null,
        kind: "voice",
        body,
        dailyTalkCheckinId: occurrence.id,
      });
      await finishOccurrence(occurrence.id, now);
      publish(occurrence.workspaceId, "talk", "messages", "overview");
      sent++;
    } catch (error) {
      logger.warn(
        { error, checkinId: occurrence.id },
        "Daily Talk check-in provider failure",
      );
      const attemptCount = occurrence.attemptCount + 1;
      const detail =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "provider failure";
      if (!safeToRetry(error) || attemptCount >= MAX_ATTEMPTS) {
        await db
          .update(dailyTalkCheckinsTable)
          .set({
            attemptCount,
            completedAt: now,
            claimedAt: null,
            lastError: detail,
          })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
      } else {
        await db
          .update(dailyTalkCheckinsTable)
          .set({
            attemptCount,
            claimedAt: null,
            nextRunAt: new Date(now.getTime() + RETRY_MS),
            lastError: detail,
          })
          .where(eq(dailyTalkCheckinsTable.id, occurrence.id));
      }
    }
  }
  return sent;
}
