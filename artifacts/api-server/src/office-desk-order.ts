import { agentsTable, db } from "@workspace/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { recordAudit } from "./audit";
import { APPROVAL_REVIEWER_SETTING } from "./approval-reviewer";
import { DOCUMENTATION_AGENT_KEY } from "./routes/documentation";
import { MEMORY_COMPRESSION_AGENT_KEY } from "./routes/memory";
import { INSPECTOR_AGENT_SETTING } from "./task-inspector";
import { getWorkspaceSetting, getWorkspaceSettings, setWorkspaceSetting } from "./workspace";

/** Workspace setting holding the explicit desk-seat occupant order. */
export const OFFICE_DESK_ORDER_SETTING = "office_desk_order";

/**
 * Number of desk seats in the submarine office. Must match `DESK_SEATS.length`
 * in artifacts/homardclaw/src/pages/OfficeDashboard.tsx.
 */
export const DESK_SEAT_COUNT = 4;

type OfficeAgentRef = { id: string; name: string };

/** Reads the persisted desk order, discarding anything that fails to parse. */
export async function getOfficeDeskOrder(
  workspaceId: string,
): Promise<string[]> {
  const raw = await getWorkspaceSetting(workspaceId, OFFICE_DESK_ORDER_SETTING);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Moves every agent named in `orderedIds` to the front, in that order,
 * leaving everyone else in their existing relative order behind them.
 * Mirrors the frontend's `reorderByExplicitOrder` in
 * artifacts/homardclaw/src/hooks/useOfficeSeating.ts — keep both in sync.
 */
export function reorderByExplicitOrder<T extends { id: string }>(
  agents: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (agent && !seen.has(id)) {
      ordered.push(agent);
      seen.add(id);
    }
  }
  const rest = agents.filter((agent) => !seen.has(agent.id));
  return [...ordered, ...rest];
}

/** Agents currently on duty at their own station (documentation/approval/memory/inspector). */
async function officeRoleAgentIds(workspaceId: string): Promise<Set<string>> {
  const settings = await getWorkspaceSettings(workspaceId, [
    DOCUMENTATION_AGENT_KEY,
    APPROVAL_REVIEWER_SETTING,
    MEMORY_COMPRESSION_AGENT_KEY,
    INSPECTOR_AGENT_SETTING,
  ]);
  return new Set(settings.values());
}

/**
 * Active, non-sandboxed agents eligible for a desk or floor seat, ordered by
 * name — the same population and order `GET /agents` + the office UI's
 * client-side filters land on before any explicit desk order is applied.
 */
async function eligibleOfficeAgents(
  workspaceId: string,
): Promise<OfficeAgentRef[]> {
  return db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, workspaceId),
        eq(agentsTable.retired, false),
        eq(agentsTable.archived, false),
        eq(agentsTable.sensitiveDataSandbox, false),
        or(
          isNull(agentsTable.onLeaveUntil),
          lte(agentsTable.onLeaveUntil, new Date()),
        ),
      ),
    )
    .orderBy(agentsTable.name);
}

export type AssignFirstDeskOutcome =
  | { status: 200; agentIds: string[] }
  | { status: 404 }
  | { status: 409; error: string };

/**
 * Seats a floor-sitting Crustabot at the first desk, shifting the current
 * desk occupants one seat to the right. Whichever occupant is bumped off
 * the last desk falls back to its ordinary (alphabetical) place among the
 * floor-sitting agents, rather than being ordered explicitly.
 */
export async function assignAgentToFirstDesk(
  workspaceId: string,
  agentId: string,
): Promise<AssignFirstDeskOutcome> {
  const [agent] = await db
    .select({
      id: agentsTable.id,
      name: agentsTable.name,
      archived: agentsTable.archived,
      retired: agentsTable.retired,
      sensitiveDataSandbox: agentsTable.sensitiveDataSandbox,
      onLeaveUntil: agentsTable.onLeaveUntil,
    })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.id, agentId),
        eq(agentsTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!agent) return { status: 404 };
  const onLeave = agent.onLeaveUntil !== null && agent.onLeaveUntil > new Date();
  if (agent.archived || agent.retired || agent.sensitiveDataSandbox || onLeave) {
    return {
      status: 409,
      error: "Only an active Crustabot in the office can take a desk.",
    };
  }
  const roleAgentIds = await officeRoleAgentIds(workspaceId);
  if (roleAgentIds.has(agent.id)) {
    return {
      status: 409,
      error: "This Crustabot is on duty at its own station.",
    };
  }
  const officeAgents = await eligibleOfficeAgents(workspaceId);
  const unassignedAgents = officeAgents.filter(
    (candidate) => !roleAgentIds.has(candidate.id),
  );
  const storedOrder = await getOfficeDeskOrder(workspaceId);
  const deskOccupants = reorderByExplicitOrder(
    unassignedAgents,
    storedOrder,
  ).slice(0, DESK_SEAT_COUNT);
  if (deskOccupants.some((occupant) => occupant.id === agent.id)) {
    return { status: 409, error: "This Crustabot is already at a desk." };
  }
  const newOrder = [
    agent.id,
    ...deskOccupants
      .filter((occupant) => occupant.id !== agent.id)
      .map((occupant) => occupant.id),
  ].slice(0, DESK_SEAT_COUNT);
  await setWorkspaceSetting(
    workspaceId,
    OFFICE_DESK_ORDER_SETTING,
    JSON.stringify(newOrder),
  );
  await recordAudit(
    workspaceId,
    "office.desk_assigned",
    `${agent.name} took the first desk.`,
  );
  return { status: 200, agentIds: newOrder };
}
