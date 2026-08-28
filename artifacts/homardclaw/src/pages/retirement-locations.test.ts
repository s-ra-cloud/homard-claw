import { describe, expect, it } from "vitest";
import {
  HOTEL_GUEST_CAPACITY,
  partitionRetiredAgents,
} from "./retirement-locations";

function retiredAgent(index: number) {
  return {
    id: `agent-${String(index).padStart(2, "0")}`,
    retiredAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  };
}

describe("partitionRetiredAgents", () => {
  it("alternates oldest-first without duplicating an agent", () => {
    const agents = [3, 1, 4, 0, 2].map(retiredAgent);
    const { beachAgents, hotelAgents } = partitionRetiredAgents(agents);

    expect(beachAgents.map((agent) => agent.id)).toEqual([
      "agent-00",
      "agent-02",
      "agent-04",
    ]);
    expect(hotelAgents.map((agent) => agent.id)).toEqual([
      "agent-01",
      "agent-03",
    ]);
    expect(
      new Set([...beachAgents, ...hotelAgents].map((agent) => agent.id)).size,
    ).toBe(agents.length);
  });

  it("keeps existing assignments stable when a new retirement is appended", () => {
    const original = Array.from({ length: 6 }, (_, index) =>
      retiredAgent(index),
    );
    const before = partitionRetiredAgents(original);
    const after = partitionRetiredAgents([...original, retiredAgent(6)]);

    expect(after.beachAgents.slice(0, before.beachAgents.length)).toEqual(
      before.beachAgents,
    );
    expect(after.hotelAgents).toEqual(before.hotelAgents);
  });

  it("caps the hotel at ten and keeps every overflow guest on the beach", () => {
    const agents = Array.from({ length: 27 }, (_, index) =>
      retiredAgent(index),
    );
    const { beachAgents, hotelAgents } = partitionRetiredAgents(agents);

    expect(hotelAgents).toHaveLength(HOTEL_GUEST_CAPACITY);
    expect(beachAgents).toHaveLength(agents.length - HOTEL_GUEST_CAPACITY);
    expect([...beachAgents, ...hotelAgents]).toHaveLength(agents.length);
  });
});
