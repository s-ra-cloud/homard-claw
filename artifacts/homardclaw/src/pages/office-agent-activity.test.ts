import { describe, expect, it } from "vitest";
import type { LobsterPose } from "@/components/ui/marlow-lobster";
import {
  deskPoseForAgent,
  isOfficeAgentWorking,
  officeAnimationStatus,
} from "./office-agent-activity";

const PLACEMENT_POSES = {
  desk: "working",
  floor: "floor-working",
  sandboxExterior: "floor-working",
  approvalDuty: "working",
  memoryDuty: "memory-cables",
  documentationDuty: "hotel-reading",
} as const satisfies Record<string, LobsterPose>;

describe("office agent activity", () => {
  it.each(["working", "researching"])(
    "treats live %s agents as actively working in every placement",
    (status) => {
      for (const pose of Object.values(PLACEMENT_POSES)) {
        expect(isOfficeAgentWorking(status)).toBe(true);
        expect(officeAnimationStatus(status)).toBe(status);
        expect(pose).toBeTruthy();
      }
    },
  );

  it.each([
    ["idle", "idle"],
    ["paused", "paused"],
    ["waiting", "waiting"],
    ["queued", "queued"],
    ["completed", "complete"],
    ["failed", "error"],
    ["cancelled", "error"],
  ])(
    "stops busy cadence for live %s agents across regular and duty placements",
    (status, animationStatus) => {
      for (const pose of Object.values(PLACEMENT_POSES)) {
        expect(isOfficeAgentWorking(status)).toBe(false);
        expect(officeAnimationStatus(status)).toBe(animationStatus);
        expect(pose).toBeTruthy();
      }
    },
  );

  it("moves a desk agent from its working pose to idle or terminal poses", () => {
    expect(deskPoseForAgent("working", "idle-reading")).toBe("working");
    expect(deskPoseForAgent("idle", "idle-reading")).toBe("idle-reading");
    expect(deskPoseForAgent("completed", "idle-reading")).toBe("seated");
    expect(deskPoseForAgent("failed", "idle-reading")).toBe("seated");
  });

  it("keeps special-duty artwork while live status changes its cadence", () => {
    for (const pose of Object.values(PLACEMENT_POSES)) {
      const before = {
        pose,
        status: officeAnimationStatus("working"),
      };
      const after = {
        pose,
        status: officeAnimationStatus("completed"),
      };

      expect(after.pose).toBe(before.pose);
      expect(isOfficeAgentWorking(after.status)).toBe(false);
      expect(after.status).toBe("complete");
    }
  });
});