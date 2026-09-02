import { TZDate } from "@date-fns/tz";
import {
  agentsTable,
  db,
  tasksTable,
  type AgentRecord,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { recordAudit } from "./audit";
import { abortRunningTask } from "./worker";
import { publish } from "./events";
import { logger } from "./lib/logger";

/**
 * Approved day off: an owner-granted, temporary leave that sends a Crustabot
 * to Retirement Island until the next Europe/Paris morning. Unlike the
 * permanent `retired` flag, this is reversible — the worker automatically
 * brings the agent back.
 */

export const LEAVE_TIMEZONE = "Europe/Paris";
export const LEAVE_RETURN_HOUR = 8;

/**
 * The instant a day off granted "now" ends: 08:00 Europe/Paris on the
 * calendar day AFTER the one the grant happened on — never the same day,
 * even when it is granted before 08:00. TZDate resolves the local wall time
 * DST-safely (a gained/lost hour never changes which calendar day the
 * return lands on).
 */
export function computeLeaveReturnAt(now: Date = new Date()): Date {
  const local = new TZDate(now.getTime(), LEAVE_TIMEZONE);
  const returnAt = new TZDate(
    local.getFullYear(),
    local.getMonth(),
    local.getDate() + 1,
    LEAVE_RETURN_HOUR,
    0,
    0,
    0,
    LEAVE_TIMEZONE,
  );
  return new Date(returnAt.getTime());
}

function normalizeLeaveText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The owner asking about their OWN day off, not granting one to the agent. */
const SELF_REQUEST_PATTERN =
  /\b(?:can|may|could|should)\s+i\b|\bi\s+(?:want|wish|get|need)\b|\bi'?d\s+like\b/;

/** A refusal ("don't take the day off") must never read as a grant. */
const NEGATION_PATTERN =
  /\b(?:don'?t|do\s+not|never|won'?t|will\s+not|can'?t|cannot)\b.{0,20}\btake\b.{0,20}\boff\b/;

/** Talking about a third party's day off, not the agent's. */
const THIRD_PARTY_PATTERN =
  /\b(?:he|she|they|him|her|them)\b.{0,20}\btake\b.{0,20}\boff\b/;

const DAY_TERM = "(?:the\\s+rest\\s+of\\s+the\\s+day|the\\s+day|today|tomorrow)";
/** Looser variant (bare "day" allowed) for phrases like "enjoy your day off". */
const DAY_TERM_LOOSE = "(?:the\\s+rest\\s+of\\s+the\\s+day|the\\s+day|day|today|tomorrow)";

const GRANT_PATTERNS = [
  new RegExp(`\\byou(?:'re| are)\\s+off\\s+(?:for\\s+)?${DAY_TERM}\\b`),
  new RegExp(
    `\\byou\\s+(?:can|may|could|should)\\s+(?:go\\s+ahead\\s+and\\s+)?take\\s+${DAY_TERM}\\s+off\\b`,
  ),
  new RegExp(`\\b(?:go\\s+ahead\\s+and\\s+)?take\\s+${DAY_TERM}\\s+off\\b`),
  new RegExp(`\\byou\\s+have\\s+${DAY_TERM}\\s+off\\b`),
  new RegExp(`\\benjoy\\s+(?:your\\s+|the\\s+)?${DAY_TERM_LOOSE}\\s+off\\b`),
];

/**
 * Recognize a clear, explicit authorization for the agent itself to take a
 * day off (e.g. "you can take the day off", "take tomorrow off"). Narrow and
 * deterministic by design — like the existing coworker-delegation detectors
 * in voice.ts — so an ordinary mention of "day off" (a question about the
 * owner's own leave, a refusal, or a remark about someone else) never fires.
 */
export function detectDayOffGrant(text: string): boolean {
  const normalized = normalizeLeaveText(text);
  if (!normalized) return false;
  if (SELF_REQUEST_PATTERN.test(normalized)) return false;
  if (NEGATION_PATTERN.test(normalized)) return false;
  if (THIRD_PARTY_PATTERN.test(normalized)) return false;
  return GRANT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export type SendAgentOnLeaveResult =
  | { status: 200; agent: AgentRecord; returnAt: Date }
  | { status: 404 };

/**
 * Send an agent on its approved day off: record the leave window, exclude it
 * from normal office activity (mirrors `paused`), and interrupt any
 * in-flight work so nothing hangs waiting on an agent that is away — exactly
 * like retirement does, but reversible.
 */
export async function sendAgentOnLeave(
  agentId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<SendAgentOnLeaveResult> {
  const returnAt = computeLeaveReturnAt(now);
  const outcome = await db.transaction(async (tx) => {
    const [agent] = await tx
      .update(agentsTable)
      .set({
        onLeaveUntil: returnAt,
        paused: true,
        status: "paused",
      })
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.workspaceId, workspaceId),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, false),
        ),
      )
      .returning();
    if (!agent) return { status: 404 as const };
    const interrupted = await tx
      .update(tasksTable)
      .set({
        status: "blocked",
        errorKind: "agent_on_leave",
        errorMessage: `${agent.name} is on an approved day off; reassign this work or retry once they return.`,
      })
      .where(
        and(
          eq(tasksTable.agentId, agent.id),
          inArray(tasksTable.status, ["queued", "running", "waiting_approval"]),
        ),
      )
      .returning({ id: tasksTable.id });
    await recordAudit(
      workspaceId,
      "agent.leave_started",
      `${agent.name} took an approved day off to Retirement Island, back at 08:00 Europe/Paris.`,
      tx,
    );
    return { status: 200 as const, agent, interrupted };
  });
  if (outcome.status === 200) {
    for (const task of outcome.interrupted) abortRunningTask(task.id);
    publish(workspaceId, "agents");
    return { status: 200, agent: outcome.agent, returnAt };
  }
  return outcome;
}

/**
 * Sweep agents whose leave window has ended and return them to normal duty.
 * Runs from the worker tick (only the singleton lease holder), row-locked
 * per agent so a concurrent sweep (or a stale ownership handover) can never
 * double-process the same return.
 */
export async function returnAgentsFromLeave(
  now: Date = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(
      and(isNotNull(agentsTable.onLeaveUntil), lte(agentsTable.onLeaveUntil, now)),
    )
    .limit(50);

  let returned = 0;
  const touchedWorkspaces = new Set<string>();
  for (const { id } of due) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const [agent] = await tx
          .select()
          .from(agentsTable)
          .where(eq(agentsTable.id, id))
          .limit(1)
          .for("update");
        if (
          !agent ||
          !agent.onLeaveUntil ||
          agent.onLeaveUntil.getTime() > now.getTime()
        ) {
          return null;
        }
        const [updated] = await tx
          .update(agentsTable)
          .set({ onLeaveUntil: null, paused: false, status: "idle" })
          .where(eq(agentsTable.id, agent.id))
          .returning();
        await recordAudit(
          agent.workspaceId,
          "agent.leave_ended",
          `${agent.name} returned from Retirement Island after an approved day off.`,
          tx,
        );
        return updated ?? null;
      });
      if (outcome) {
        returned += 1;
        if (outcome.workspaceId) touchedWorkspaces.add(outcome.workspaceId);
      }
    } catch (error) {
      logger.error({ error, agentId: id }, "Failed to return agent from leave");
    }
  }
  for (const workspaceId of touchedWorkspaces) publish(workspaceId, "agents");
  return returned;
}
