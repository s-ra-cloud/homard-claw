import { describe, expect, it } from "vitest";
import { SCENE_HOTSPOTS } from "./office-scene-hotspots";

function spot(href: string) {
  const result = SCENE_HOTSPOTS.find((candidate) => candidate.href === href);
  if (!result) throw new Error(`Missing office hotspot: ${href}`);
  return result;
}

describe("office scene hotspots", () => {
  it("moves Inbox to the blue navigation console", () => {
    expect(spot("/inbox")).toMatchObject({
      left: "25.8%",
      top: "44.6%",
      width: "10%",
      height: "9%",
    });
  });

  it("removes the Team diorama access and grows Approvals into its space", () => {
    expect(
      SCENE_HOTSPOTS.find(
        (candidate) => candidate.href === "/agents?tab=teams",
      ),
    ).toBeUndefined();

    const approvals = spot("/approvals");
    const crustabots = spot("/agents");
    const approvalsLeftEdge =
      Number.parseFloat(approvals.left) -
      Number.parseFloat(approvals.width) / 2;
    const crustabotsRightEdge =
      Number.parseFloat(crustabots.left) +
      Number.parseFloat(crustabots.width) / 2;

    // Larger than the original 4.2% x 4.5% Approvals hit area.
    expect(Number.parseFloat(approvals.width)).toBeGreaterThan(4.2);
    expect(Number.parseFloat(approvals.height)).toBeGreaterThan(4.5);
    expect(approvalsLeftEdge).toBeGreaterThanOrEqual(crustabotsRightEdge);
  });

  it("gives Reports the first blue server without overlapping Providers", () => {
    const reports = spot("/reports");
    const providers = spot("/providers");
    const reportsRightEdge =
      Number.parseFloat(reports.left) + Number.parseFloat(reports.width) / 2;
    const providersLeftEdge =
      Number.parseFloat(providers.left) -
      Number.parseFloat(providers.width) / 2;
    const providersBottomEdge =
      Number.parseFloat(providers.top) +
      Number.parseFloat(providers.height) / 2;

    expect(reports.ariaLabel).toContain("Leftmost blue server cabinet");
    expect(reportsRightEdge).toBeLessThanOrEqual(providersLeftEdge);
    expect(providersBottomEdge).toBeLessThan(OFFICE_FLOOR_ROLE_TOP);
  });
});

const OFFICE_FLOOR_ROLE_TOP = 68.2;
