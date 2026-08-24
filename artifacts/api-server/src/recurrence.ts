import { TZDate } from "@date-fns/tz";

/**
 * Timezone-aware recurrence for durable schedules.
 *
 * All wall-clock fields (timeOfDay, daysOfWeek, dayOfMonth) are interpreted
 * in the schedule's IANA timezone; the returned Date is the UTC instant of
 * the next occurrence STRICTLY AFTER `after`. DST is handled by TZDate: a
 * wall time that does not exist on a transition day resolves to the
 * post-transition instant, and an ambiguous wall time resolves once — a
 * schedule never fires twice for one occurrence.
 */

export type RecurrenceSpec = {
  cadence: "once" | "daily" | "weekly" | "monthly";
  timezone: string;
  /** Absolute instant, only for `once`. */
  runAt?: Date | null;
  /** "HH:MM" wall time, required for recurring cadences. */
  timeOfDay?: string | null;
  /** 0 (Sunday) – 6 (Saturday), required for `weekly`. */
  daysOfWeek?: number[] | null;
  /** 1–31 (clamped to the month's last day), required for `monthly`. */
  dayOfMonth?: number | null;
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function parseTimeOfDay(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Validation failure message, or null when the spec is well-formed. */
export function validateRecurrence(spec: RecurrenceSpec): string | null {
  if (!isValidTimezone(spec.timezone)) {
    return `Unknown timezone "${spec.timezone}"`;
  }
  if (spec.cadence === "once") {
    if (!spec.runAt || Number.isNaN(spec.runAt.getTime())) {
      return "A one-time schedule needs a valid run date";
    }
    return null;
  }
  if (!spec.timeOfDay || !parseTimeOfDay(spec.timeOfDay)) {
    return "Recurring schedules need a time of day in HH:MM format";
  }
  if (spec.cadence === "weekly") {
    const days = spec.daysOfWeek ?? [];
    if (
      days.length === 0 ||
      days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      return "Weekly schedules need at least one weekday (0–6)";
    }
  }
  if (spec.cadence === "monthly") {
    const day = spec.dayOfMonth;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
      return "Monthly schedules need a day of month between 1 and 31";
    }
  }
  return null;
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Next occurrence strictly after `after`, or null when the schedule has no
 * future occurrence (a `once` whose instant has passed). Walks local
 * calendar days (never raw 24h steps) so DST transitions cannot skip or
 * duplicate a day.
 */
export function computeNextRunAt(spec: RecurrenceSpec, after: Date): Date | null {
  if (spec.cadence === "once") {
    const runAt = spec.runAt ?? null;
    return runAt && runAt.getTime() > after.getTime() ? runAt : null;
  }
  const time = spec.timeOfDay ? parseTimeOfDay(spec.timeOfDay) : null;
  if (!time) return null;

  const local = new TZDate(after.getTime(), spec.timezone);
  // Up to ~14 months of daily steps covers every monthly/weekly gap
  // (including Feb 29 handled by clamping, not skipping).
  for (let i = 0; i <= 430; i += 1) {
    const candidate = new TZDate(
      local.getFullYear(),
      local.getMonth(),
      local.getDate() + i,
      time.hours,
      time.minutes,
      0,
      0,
      spec.timezone,
    );
    if (candidate.getTime() <= after.getTime()) continue;
    if (spec.cadence === "daily") return new Date(candidate.getTime());
    if (spec.cadence === "weekly") {
      if ((spec.daysOfWeek ?? []).includes(candidate.getDay())) {
        return new Date(candidate.getTime());
      }
      continue;
    }
    // monthly: fire on min(dayOfMonth, last day of that month).
    const clamped = Math.min(
      spec.dayOfMonth ?? 1,
      lastDayOfMonth(candidate.getFullYear(), candidate.getMonth()),
    );
    if (candidate.getDate() === clamped) return new Date(candidate.getTime());
  }
  return null;
}
