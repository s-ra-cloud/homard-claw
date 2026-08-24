import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  isValidTimezone,
  parseTimeOfDay,
  validateRecurrence,
  type RecurrenceSpec,
} from "./recurrence";

const PARIS = "Europe/Paris";
const NY = "America/New_York";

function daily(timeOfDay: string, timezone = PARIS): RecurrenceSpec {
  return { cadence: "daily", timezone, timeOfDay };
}

describe("timezone + time parsing", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimezone("Europe/Paris")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("parses HH:MM and rejects out-of-range values", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hours: 9, minutes: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9:75")).toBeNull();
    expect(parseTimeOfDay("morning")).toBeNull();
  });
});

describe("validateRecurrence", () => {
  it("requires runAt for once and timeOfDay for recurring", () => {
    expect(
      validateRecurrence({ cadence: "once", timezone: PARIS, runAt: new Date() }),
    ).toBeNull();
    expect(validateRecurrence({ cadence: "once", timezone: PARIS })).toMatch(/run date/);
    expect(validateRecurrence(daily("09:00"))).toBeNull();
    expect(validateRecurrence({ cadence: "daily", timezone: PARIS })).toMatch(/HH:MM/);
  });

  it("requires weekdays for weekly and a day for monthly", () => {
    expect(
      validateRecurrence({ cadence: "weekly", timezone: PARIS, timeOfDay: "08:00", daysOfWeek: [] }),
    ).toMatch(/weekday/);
    expect(
      validateRecurrence({ cadence: "weekly", timezone: PARIS, timeOfDay: "08:00", daysOfWeek: [7] }),
    ).toMatch(/weekday/);
    expect(
      validateRecurrence({ cadence: "monthly", timezone: PARIS, timeOfDay: "08:00", dayOfMonth: 32 }),
    ).toMatch(/day of month/);
    expect(
      validateRecurrence({ cadence: "monthly", timezone: PARIS, timeOfDay: "08:00", dayOfMonth: 31 }),
    ).toBeNull();
  });
});

describe("computeNextRunAt", () => {
  it("once: fires only while still in the future", () => {
    const runAt = new Date("2026-09-01T10:00:00Z");
    const spec: RecurrenceSpec = { cadence: "once", timezone: PARIS, runAt };
    expect(computeNextRunAt(spec, new Date("2026-08-31T10:00:00Z"))).toEqual(runAt);
    expect(computeNextRunAt(spec, runAt)).toBeNull();
    expect(computeNextRunAt(spec, new Date("2026-09-02T10:00:00Z"))).toBeNull();
  });

  it("daily: same local day when the time is still ahead, else tomorrow", () => {
    // 08:00 UTC on Aug 25 = 10:00 in Paris (CEST): 14:30 Paris is later today.
    const after = new Date("2026-08-25T08:00:00Z");
    const next = computeNextRunAt(daily("14:30"), after);
    expect(next?.toISOString()).toBe("2026-08-25T12:30:00.000Z");
    // 09:00 Paris already passed at 10:00 local, so it lands tomorrow.
    const nextMorning = computeNextRunAt(daily("09:00"), after);
    expect(nextMorning?.toISOString()).toBe("2026-08-26T07:00:00.000Z");
  });

  it("daily: crossing the spring-forward DST gap keeps the wall time", () => {
    // Paris DST 2026: clocks jump 02:00→03:00 on March 29.
    const before = new Date("2026-03-28T20:00:00Z");
    const next = computeNextRunAt(daily("09:00"), before);
    // March 29 09:00 CEST = 07:00 UTC (offset changed from +1 to +2).
    expect(next?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
  });

  it("daily: a wall time inside the DST gap still yields exactly one run", () => {
    // 02:30 does not exist on March 29 in Paris; it must resolve to a
    // single instant, not zero or two.
    const before = new Date("2026-03-28T23:00:00Z");
    const next = computeNextRunAt(daily("02:30"), before);
    expect(next).not.toBeNull();
    const following = computeNextRunAt(daily("02:30"), next!);
    // The run after it is on March 30 — no double-fire on the gap day.
    expect(following!.getTime() - next!.getTime()).toBeGreaterThan(20 * 60 * 60 * 1000);
  });

  it("daily: fall-back ambiguous wall time resolves once", () => {
    // NY DST ends Nov 1 2026; 01:30 happens twice that morning.
    const before = new Date("2026-10-31T20:00:00Z");
    const next = computeNextRunAt(daily("01:30", NY), before);
    expect(next).not.toBeNull();
    const following = computeNextRunAt(daily("01:30", NY), next!);
    expect(following!.getTime()).toBeGreaterThan(next!.getTime());
  });

  it("weekly: picks the next listed weekday in the schedule's zone", () => {
    // Aug 25 2026 is a Tuesday.
    const spec: RecurrenceSpec = {
      cadence: "weekly",
      timezone: PARIS,
      timeOfDay: "09:00",
      daysOfWeek: [1, 5], // Mon, Fri
    };
    const next = computeNextRunAt(spec, new Date("2026-08-25T08:00:00Z"));
    // Next is Friday Aug 28, 09:00 CEST.
    expect(next?.toISOString()).toBe("2026-08-28T07:00:00.000Z");
    const after = computeNextRunAt(spec, next!);
    // Then Monday Aug 31.
    expect(after?.toISOString()).toBe("2026-08-31T07:00:00.000Z");
  });

  it("monthly: clamps day 31 to short months instead of skipping them", () => {
    const spec: RecurrenceSpec = {
      cadence: "monthly",
      timezone: "UTC",
      timeOfDay: "12:00",
      dayOfMonth: 31,
    };
    const next = computeNextRunAt(spec, new Date("2026-01-31T13:00:00Z"));
    // January 31 12:00 already passed → February 28 (2026 is not a leap year).
    expect(next?.toISOString()).toBe("2026-02-28T12:00:00.000Z");
    const after = computeNextRunAt(spec, next!);
    expect(after?.toISOString()).toBe("2026-03-31T12:00:00.000Z");
  });

  it("monthly: catch-up after downtime yields one next occurrence, never a backlog", () => {
    const spec: RecurrenceSpec = {
      cadence: "monthly",
      timezone: "UTC",
      timeOfDay: "06:00",
      dayOfMonth: 1,
    };
    // Server was down for three months; the next run is computed strictly
    // after "now" — a single occurrence.
    const next = computeNextRunAt(spec, new Date("2026-08-24T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-01T06:00:00.000Z");
  });
});
