import type { LobsterPose } from "@/components/ui/marlow-lobster";

export type OfficeRole = "documentation" | "approval" | "memory";

export type OfficeRoleSeat = {
  left: number;
  top: number;
  label: string;
  pose: LobsterPose;
  status: "idle" | "working";
};

export const OFFICE_ROLE_SEATS: Record<OfficeRole, OfficeRoleSeat> = {
  documentation: {
    left: 28.2,
    top: 56.2,
    label: "documentation reading station",
    pose: "hotel-reading",
    status: "idle",
  },
  approval: {
    left: 20.1,
    top: 57.3,
    label: "approval monitoring station",
    pose: "working",
    status: "working",
  },
  memory: {
    left: 82.1,
    top: 54.8,
    label: "memory cable station",
    pose: "memory-cables",
    status: "working",
  },
};

export type OfficeRoleAssignments = {
  documentationAgentId?: string | null;
  approvalAgentId?: string | null;
  memoryAgentId?: string | null;
};

export type OfficeRolePlacement = {
  agentId: string;
  role: OfficeRole;
  seat: OfficeRoleSeat;
};

function stableIndex(value: string, length: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

/**
 * Select exactly one visible duty for each eligible agent. `loadSeed` is made
 * once when the room mounts, so an agent with several jobs moves only after a
 * real page/environment reload rather than whenever React happens to render.
 */
export function chooseOfficeRolePlacements(
  assignments: OfficeRoleAssignments,
  eligibleAgentIds: ReadonlySet<string>,
  loadSeed: string,
): OfficeRolePlacement[] {
  const rolesByAgent = new Map<string, OfficeRole[]>();
  const add = (agentId: string | null | undefined, role: OfficeRole) => {
    if (!agentId || !eligibleAgentIds.has(agentId)) return;
    rolesByAgent.set(agentId, [...(rolesByAgent.get(agentId) ?? []), role]);
  };

  add(assignments.documentationAgentId, "documentation");
  add(assignments.approvalAgentId, "approval");
  add(assignments.memoryAgentId, "memory");

  return [...rolesByAgent].map(([agentId, roles]) => {
    const role = roles[stableIndex(`${loadSeed}:${agentId}`, roles.length)];
    return { agentId, role, seat: OFFICE_ROLE_SEATS[role] };
  });
}
