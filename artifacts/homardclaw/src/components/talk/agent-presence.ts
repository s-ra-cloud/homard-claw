/**
 * Presence cues for the contact list — the phone-book reading of an agent's
 * runtime status ("on a task", "away") rather than the roster's badge wording.
 */
export interface AgentPresence {
  label: string;
  /** Tailwind background class for the presence dot. */
  dotClass: string;
  /** Busy presences pulse, like a line that is currently in use. */
  pulse?: boolean;
}

const PRESENCE: Record<string, AgentPresence> = {
  idle: { label: "Available", dotClass: "bg-green-500" },
  working: { label: "On a task", dotClass: "bg-primary", pulse: true },
  researching: { label: "Researching", dotClass: "bg-accent", pulse: true },
  waiting: { label: "Awaiting approval", dotClass: "bg-accent" },
  paused: { label: "Paused", dotClass: "bg-muted-foreground" },
  error: { label: "Needs attention", dotClass: "bg-destructive" },
};

export function presenceForStatus(status: string): AgentPresence {
  return (
    PRESENCE[status] ?? {
      label: status.replace(/_/g, " "),
      dotClass: "bg-muted-foreground",
    }
  );
}
