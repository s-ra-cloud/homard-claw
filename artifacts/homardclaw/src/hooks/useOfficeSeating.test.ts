import { describe, expect, it } from "vitest";
import { reorderByExplicitOrder } from "./useOfficeSeating";

describe("reorderByExplicitOrder", () => {
  it("keeps everyone alphabetical when no explicit order is stored", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderByExplicitOrder(agents, [])).toEqual(agents);
  });

  it("moves explicitly ordered agents to the front, in that order", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(reorderByExplicitOrder(agents, ["c", "a"])).toEqual([
      { id: "c" },
      { id: "a" },
      { id: "b" },
      { id: "d" },
    ]);
  });

  it("drops ids from the order that no longer match a live agent", () => {
    const agents = [{ id: "a" }, { id: "b" }];
    expect(reorderByExplicitOrder(agents, ["gone", "b"])).toEqual([
      { id: "b" },
      { id: "a" },
    ]);
  });

  it("ignores duplicate ids in the stored order", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderByExplicitOrder(agents, ["b", "b"])).toEqual([
      { id: "b" },
      { id: "a" },
      { id: "c" },
    ]);
  });
});
