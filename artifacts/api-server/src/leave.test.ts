import { describe, expect, it } from "vitest";
import { computeLeaveReturnAt, detectDayOffGrant } from "./leave";

describe("computeLeaveReturnAt", () => {
  it("returns 08:00 Europe/Paris on the day AFTER the grant, even mid-morning", () => {
    // 10:00 UTC = 12:00 CEST (Paris, summer) on Aug 25 2026.
    const grantedAt = new Date("2026-08-25T10:00:00Z");
    const returnAt = computeLeaveReturnAt(grantedAt);
    // Aug 26 08:00 CEST = 06:00 UTC.
    expect(returnAt.toISOString()).toBe("2026-08-26T06:00:00.000Z");
  });

  it("still lands on the following day when granted just before 08:00", () => {
    // 05:30 UTC = 07:30 CEST on Aug 25 2026 — a day off granted minutes
    // before 8am must not end an hour later.
    const grantedAt = new Date("2026-08-25T05:30:00Z");
    const returnAt = computeLeaveReturnAt(grantedAt);
    expect(returnAt.toISOString()).toBe("2026-08-26T06:00:00.000Z");
  });

  it("crosses the spring-forward DST gap correctly", () => {
    // Paris DST 2026: clocks jump 02:00→03:00 on March 29. A grant on
    // March 28 must return 08:00 CEST on March 29 (offset +2, not +1).
    const grantedAt = new Date("2026-03-28T12:00:00Z");
    const returnAt = computeLeaveReturnAt(grantedAt);
    expect(returnAt.toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });

  it("crosses the fall-back DST transition correctly", () => {
    // Paris DST ends Oct 25 2026 (offset drops from +2 to +1).
    const grantedAt = new Date("2026-10-24T12:00:00Z");
    const returnAt = computeLeaveReturnAt(grantedAt);
    expect(returnAt.toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });
});

describe("detectDayOffGrant", () => {
  it.each([
    "You can take the day off",
    "You may take the day off",
    "take the day off",
    "Take the day off, you've earned it!",
    "Go ahead and take the rest of the day off",
    "You're off for the day",
    "you are off for today",
    "you have the day off",
    "Take tomorrow off",
    "Enjoy your day off!",
    "You should really take today off",
  ])("recognizes a clear grant: %s", (text) => {
    expect(detectDayOffGrant(text)).toBe(true);
  });

  it.each([
    "What did you do yesterday?",
    "Can I take the day off?",
    "I'd like to take the day off",
    "Don't take the day off, we're busy",
    "He can take the day off tomorrow",
    "She took the day off yesterday",
    "How was your day?",
    "Take out the trash",
    "",
  ])("does not fire on: %s", (text) => {
    expect(detectDayOffGrant(text)).toBe(false);
  });
});
