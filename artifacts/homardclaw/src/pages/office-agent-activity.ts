import type {
  LobsterPose,
  LobsterStatus,
} from "@/components/ui/marlow-lobster";

export const WORKING_AGENT_STATUSES = new Set(["working", "researching"]);

export function isOfficeAgentWorking(status: string): boolean {
  return WORKING_AGENT_STATUSES.has(status);
}

/**
 * Keep the API's live state as the only source of animation cadence. Terminal
 * aliases are normalized to the lobster component's explicit non-working
 * classes instead of falling through to an unclassified CSS state.
 */
export function officeAnimationStatus(status: string): LobsterStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return status;
  }
}

export function deskPoseForAgent(
  status: string,
  idleActivity: LobsterPose | undefined,
): LobsterPose {
  if (isOfficeAgentWorking(status)) return "working";
  if (status === "idle" && idleActivity) return idleActivity;
  return "seated";
}