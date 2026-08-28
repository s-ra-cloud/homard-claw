import type { Approval, Task } from "@workspace/api-client-react";

/**
 * Continuation approvals: when a task exhausts its bounded connected-app
 * action rounds with well-formed work remaining, the server parks it and
 * asks the owner to approve one more bounded segment. These helpers keep
 * the task detail dialog and the Authorization Desk in agreement about
 * what counts as that pause — it must never be confused with an
 * action-level (write) approval or the initial policy-gate approval.
 */
export const CONTINUATION_KIND = "task_continuation";

/** True only for the undecided round-limit continuation request. */
export function isPendingContinuation(
  approval: Pick<Approval, "kind" | "status"> | null | undefined,
): boolean {
  return (
    approval != null &&
    approval.kind === CONTINUATION_KIND &&
    approval.status === "pending"
  );
}

/**
 * Badge label that makes a continuation request recognizable in the
 * Authorization Desk; null for every other approval kind so existing
 * cards render unchanged.
 */
export function approvalKindLabel(kind: string | null | undefined): string | null {
  return kind === CONTINUATION_KIND ? "Continue Task" : null;
}

/**
 * Badge label showing that a task has paused at the round limit before;
 * null until the first pause so ordinary tasks gain no badge.
 */
export function continuationBadgeLabel(
  task: Pick<Task, "continuationSegments">,
): string | null {
  const segments = task.continuationSegments ?? 0;
  if (segments <= 0) return null;
  return `Continuation ×${segments}`;
}
