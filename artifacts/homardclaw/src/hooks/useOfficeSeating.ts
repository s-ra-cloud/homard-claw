import React from "react";
import {
  useGetApprovalSettings,
  useGetDocumentation,
  useGetInspectorSettings,
  useGetMemorySettings,
  useGetOfficeDeskOrder,
  useListAgents,
  type Agent,
} from "@workspace/api-client-react";
import { chooseOfficeRolePlacements } from "@/pages/office-role-placements";

/**
 * Number of desk seats in the submarine office. Must match `DESK_SEATS.length`
 * in `OfficeDashboard.tsx` and `DESK_SEAT_COUNT` in
 * artifacts/api-server/src/office-desk-order.ts.
 */
export const DESK_SEAT_COUNT = 4;

/**
 * Moves every agent named in `orderedIds` to the front, in that order,
 * leaving everyone else in their existing relative order behind them.
 * Mirrors the backend's `reorderByExplicitOrder` in
 * artifacts/api-server/src/office-desk-order.ts — keep both in sync.
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

/**
 * The office's seating computation, shared between the Office dashboard
 * (which renders it) and any page that needs to know whether a given agent
 * currently has a desk. `unassignedOfficeAgents` is ordered by the explicit
 * desk order first, then alphabetically — the same pool the dashboard slices
 * into desk and floor seats.
 */
export function useOfficeSeating() {
  const { data: agents, isLoading: agentsLoading } = useListAgents();
  const { data: documentation } = useGetDocumentation();
  const { data: approvalSettings } = useGetApprovalSettings();
  const { data: inspectorSettings } = useGetInspectorSettings();
  const { data: memorySettings } = useGetMemorySettings();
  const { data: deskOrder, isLoading: deskOrderLoading } =
    useGetOfficeDeskOrder();
  const [roleLoadSeed] = React.useState(() => String(Math.random()));

  const activeAgents = (agents ?? []).filter((agent) => !agent.archived);
  const sandboxedAgents = activeAgents.filter(
    (agent) => agent.sensitiveDataSandbox,
  );
  const officeAgents = activeAgents.filter(
    (agent) => !agent.sensitiveDataSandbox,
  );
  const rolePlacements = chooseOfficeRolePlacements(
    {
      documentationAgentId: documentation?.assistantAgentId,
      approvalAgentId: approvalSettings?.reviewerAgentId,
      memoryAgentId: memorySettings?.compressionAgentId,
      inspectorAgentId: inspectorSettings?.inspectorAgentId,
    },
    new Set(officeAgents.map((agent) => agent.id)),
    roleLoadSeed,
  );
  const roleAgentIds = new Set(
    rolePlacements.map((placement) => placement.agentId),
  );
  const unassignedOfficeAgents: Agent[] = reorderByExplicitOrder(
    officeAgents.filter((agent) => !roleAgentIds.has(agent.id)),
    deskOrder?.agentIds ?? [],
  );
  const deskAgents = unassignedOfficeAgents.slice(0, DESK_SEAT_COUNT);

  return {
    activeAgents,
    sandboxedAgents,
    officeAgents,
    rolePlacements,
    roleAgentIds,
    unassignedOfficeAgents,
    deskAgents,
    isLoading: agentsLoading || deskOrderLoading,
  };
}
