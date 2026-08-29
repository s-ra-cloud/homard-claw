import { describe, expect, it } from "vitest";
import { HOTEL_SPOTS } from "./hotel-spots";

describe("hotel activity anchors", () => {
  it("provides ten appliance-bound guest positions", () => {
    expect(HOTEL_SPOTS).toHaveLength(10);
    expect(new Set(HOTEL_SPOTS.map((spot) => spot.amenity))).toEqual(
      new Set(["library", "jukebox", "bar", "arcade", "aquarium", "spa"]),
    );
  });

  it("never reuses an office-chair or beach pose", () => {
    expect(HOTEL_SPOTS.every((spot) => spot.pose.startsWith("hotel-"))).toBe(
      true,
    );
  });

  it("keeps anchors in the walkable hotel floor", () => {
    for (const spot of HOTEL_SPOTS) {
      expect(spot.left).toBeGreaterThanOrEqual(16);
      expect(spot.left).toBeLessThanOrEqual(86);
      expect(spot.top).toBeGreaterThanOrEqual(34);
      expect(spot.top).toBeLessThanOrEqual(60);
      expect(spot.scale).toBeGreaterThanOrEqual(0.9);
      expect(spot.scale).toBeLessThanOrEqual(1.1);
    }
  });

  it("leaves enough separation between nameplate centers", () => {
    for (let left = 0; left < HOTEL_SPOTS.length; left++) {
      for (let right = left + 1; right < HOTEL_SPOTS.length; right++) {
        const a = HOTEL_SPOTS[left];
        const b = HOTEL_SPOTS[right];
        const distance = Math.hypot(
          (a.left - b.left) * (1586 / 100),
          (a.top - b.top) * (992 / 100),
        );
        expect(distance).toBeGreaterThan(90);
      }
    }
  });
});
