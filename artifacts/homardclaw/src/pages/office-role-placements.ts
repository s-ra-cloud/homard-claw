import type { LobsterPose } from "@/components/ui/marlow-lobster";

export type OfficeRole = "documentation" | "approval" | "memory";

export type OfficeRoleSeat = {
  left: number;
  top: number;
  label: string;
  pose: LobsterPose;
  status: "idle" | "working";
  mirrorX?: boolean;
};

export const OFFICE_ROLE_SEATS: Record<OfficeRole, OfficeRoleSeat> = {
  documentation: {
    // Clear blue floor in front of the provider racks. Keeping the whole
    // sprite below the cabinet fronts makes the reader look seated on the
    // floor rather than pinned to a wall or piece of furniture. Nudged up
    // from 69.4 so the sprite's feet clear the bottom wall while staying
    // grounded on the floor.
    left: 74.8,
    top: 68.2,
    label: "documentation reading spot in front of Providers",
    pose: "hotel-reading",
    status: "idle",
  },
  approval: {
    // The working composite is drawn from behind with one claw on the keys.
    // This anchor tucks its chair into the port console so the reviewer is
    // visibly facing and typing on the controls instead of floating below it.
    left: 17.2,
    top: 49.4,
    label: "approval console typing station",
    pose: "working",
    status: "working",
    mirrorX: true,
  },
  memory: {
    // Directly below the small cyan Memory computer, on the clear blue floor
    // in front of (not on top of) the server cabinets.
    left: 82.2,
    top: 69.2,
    label: "memory cable station in front of the Memory computer",
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
    const role = roles[stableIndex(`${loadSeed}:${agentId}`, roles.length)]!;
    return { agentId, role, seat: OFFICE_ROLE_SEATS[role] };
  });
}
