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
