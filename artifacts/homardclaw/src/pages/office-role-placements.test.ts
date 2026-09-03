import { describe, expect, it } from "vitest";
import {
  chooseOfficeRolePlacements,
  OFFICE_ROLE_SEATS,
} from "./office-role-placements";

describe("office role placements", () => {
  it("keeps each assigned role on its intended furniture-free floor anchor", () => {
    expect(OFFICE_ROLE_SEATS.approval).toMatchObject({
      left: 17.2,
      top: 49.4,
      pose: "working",
      status: "working",
      mirrorX: true,
    });
    expect(OFFICE_ROLE_SEATS.documentation).toMatchObject({
      left: 74.8,
      top: 68.2,
      pose: "hotel-reading",
    });
    expect(OFFICE_ROLE_SEATS.memory).toMatchObject({
      left: 82.2,
      top: 69.2,
      pose: "memory-cables",
    });
    // The inspector reuses the "approval guy" seated-at-the-controls sprite,
    // placed beside the Inbox navigation console on the port side.
    expect(OFFICE_ROLE_SEATS.inspector).toMatchObject({
      left: 30.4,
      top: 47.2,
      pose: "working",
      status: "working",
      mirrorX: true,
    });
  });

  it("places separately assigned Crustabots at their dedicated stations", () => {
    const placements = chooseOfficeRolePlacements(
      {
        documentationAgentId: "docs",
        approvalAgentId: "reviewer",
        memoryAgentId: "compressor",
        inspectorAgentId: "inspector",
      },
      new Set(["docs", "reviewer", "compressor", "inspector"]),
      "load-a",
    );

    expect(placements.map(({ agentId, role }) => [agentId, role])).toEqual([
      ["docs", "documentation"],
      ["reviewer", "approval"],
      ["compressor", "memory"],
      ["inspector", "inspector"],
    ]);
  });

  it("renders a multiply assigned Crustabot only once", () => {
    const placements = chooseOfficeRolePlacements(
      {
        documentationAgentId: "multi",
        approvalAgentId: "multi",
        memoryAgentId: "multi",
      },
      new Set(["multi"]),
      "load-b",
    );

    expect(placements).toHaveLength(1);
    expect(["documentation", "approval", "memory"]).toContain(
      placements[0]?.role,
    );
  });

  it("is stable during one load and can choose another duty on another load", () => {
    const assignments = {
      documentationAgentId: "multi",
      approvalAgentId: "multi",
      memoryAgentId: "multi",
    };
    const eligible = new Set(["multi"]);
    const first = chooseOfficeRolePlacements(assignments, eligible, "load-0");
    const repeated = chooseOfficeRolePlacements(
      assignments,
      eligible,
      "load-0",
    );
    const observed = new Set(
      Array.from({ length: 30 }, (_, index) =>
        chooseOfficeRolePlacements(assignments, eligible, `load-${index}`),
      ).map((placement) => placement[0]?.role),
    );

    expect(repeated).toEqual(first);
    expect(observed.size).toBeGreaterThan(1);
  });

  it("ignores assignments that are not eligible for the shared office", () => {
    expect(
      chooseOfficeRolePlacements(
        { documentationAgentId: "sandboxed", approvalAgentId: "active" },
        new Set(["active"]),
        "load-c",
      ).map((placement) => placement.agentId),
    ).toEqual(["active"]);
  });
});
