/**
 * The continuation pause must be distinguishable from every other waiting
 * state: only a PENDING approval of kind task_continuation shows the
 * approve-to-continue panel, and only that kind gains the desk badge.
 */
import { describe, expect, it } from "vitest";
import {
  approvalKindLabel,
  continuationBadgeLabel,
  isPendingContinuation,
} from "./continuation";
import { ApprovalKind, ApprovalStatus } from "@workspace/api-client-react";

describe("isPendingContinuation", () => {
  it("is true only for a pending task_continuation approval", () => {
    expect(
      isPendingContinuation({
        kind: ApprovalKind.task_continuation,
        status: ApprovalStatus.pending,
      }),
    ).toBe(true);
  });

  it("ignores action-level and policy-gate approvals, pending or not", () => {
    expect(
      isPendingContinuation({
        kind: ApprovalKind.app_action,
        status: ApprovalStatus.pending,
      }),
    ).toBe(false);
    expect(
      isPendingContinuation({
        kind: ApprovalKind.task,
        status: ApprovalStatus.pending,
      }),
    ).toBe(false);
  });

  it("hides the panel once the continuation is decided", () => {
    for (const status of [
      ApprovalStatus.approved,
      ApprovalStatus.rejected,
      ApprovalStatus.expired,
      ApprovalStatus.cancelled,
    ]) {
      expect(
        isPendingContinuation({
          kind: ApprovalKind.task_continuation,
          status,
        }),
      ).toBe(false);
    }
  });

  it("tolerates a task with no pending approval at all", () => {
    expect(isPendingContinuation(null)).toBe(false);
    expect(isPendingContinuation(undefined)).toBe(false);
  });
});

describe("approvalKindLabel", () => {
  it("labels only continuation requests", () => {
    expect(approvalKindLabel(ApprovalKind.task_continuation)).toBe(
      "Continue Task",
    );
    expect(approvalKindLabel(ApprovalKind.app_action)).toBeNull();
    expect(approvalKindLabel(ApprovalKind.task)).toBeNull();
    expect(approvalKindLabel(undefined)).toBeNull();
  });
});

describe("continuationBadgeLabel", () => {
  it("stays hidden for tasks that never paused at the round limit", () => {
    expect(continuationBadgeLabel({ continuationSegments: 0 })).toBeNull();
    expect(continuationBadgeLabel({ continuationSegments: undefined })).toBeNull();
  });

  it("counts repeated round-limit pauses", () => {
    expect(continuationBadgeLabel({ continuationSegments: 1 })).toBe(
      "Continuation ×1",
    );
    expect(continuationBadgeLabel({ continuationSegments: 3 })).toBe(
      "Continuation ×3",
    );
  });
});
