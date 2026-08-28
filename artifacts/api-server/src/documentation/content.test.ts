import { describe, expect, it } from "vitest";
import { CRUSTABOX_DOCUMENTATION, documentationPromptContext } from "./content";

describe("Crustabox documentation", () => {
  it("has stable, unique sections with useful content", () => {
    expect(CRUSTABOX_DOCUMENTATION.length).toBeGreaterThanOrEqual(8);
    expect(
      new Set(CRUSTABOX_DOCUMENTATION.map((section) => section.id)).size,
    ).toBe(CRUSTABOX_DOCUMENTATION.length);
    for (const section of CRUSTABOX_DOCUMENTATION) {
      expect(section.title.length).toBeGreaterThan(3);
      expect(section.summary.length).toBeGreaterThan(20);
      expect(section.items.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("builds the complete context supplied to the Documentation Crustabot", () => {
    const context = documentationPromptContext();
    for (const section of CRUSTABOX_DOCUMENTATION) {
      expect(context).toContain(section.title);
      expect(context).toContain(section.summary);
      for (const item of section.items) expect(context).toContain(item);
    }
    expect(context).toContain("Crustabox");
    expect(context).toContain("Crustabot");
    expect(context).not.toContain("HomardClaw");
  });
});
