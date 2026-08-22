import { describe, expect, it } from "vitest";
import {
  isBeijingWeekendDay,
  isOffPeak,
  isPeak,
  minutesUntilRateChange,
} from "./peak-hours";

/** Weekday fixture — 2026-01-01 (Thursday). */
function weekday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute));
}

/** Saturday 2026-09-05, after the weekend-rule effective date (2026-08-23 00:00 Beijing). */
function saturday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 5, hour, minute));
}

/** Sunday 2026-09-06. */
function sunday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 6, hour, minute));
}

/** Monday 2026-09-07. */
function monday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 7, hour, minute));
}

describe("peak-hours rate periods", () => {
  it.each([
    [0, 59, true], // 00:59 — before the first peak window
    [1, 0, false], // 01:00 — first peak window starts
    [3, 59, false], // 03:59 — still inside the first peak window
    [4, 0, true], // 04:00 — first peak window ends (end-exclusive)
    [5, 59, true], // 05:59 — gap between the two peak windows
    [6, 0, false], // 06:00 — second peak window starts
    [9, 59, false], // 09:59 — still inside the second peak window
    [10, 0, true], // 10:00 — second peak window ends
    [23, 59, true], // 23:59 — off-peak
  ])("UTC %i:%02i off-peak = %s", (hour, minute, offPeak) => {
    expect(isOffPeak(weekday(hour, minute))).toBe(offPeak);
    expect(isPeak(weekday(hour, minute))).toBe(!offPeak);
  });

  it("weekends are off-peak all day after the 2026-08-23 00:00 Beijing effective date", () => {
    // Saturday 09:00, 11:00, 15:00, 17:00 Beijing — all old peak-window hours.
    for (const hour of [1, 3, 6, 9]) {
      expect(isPeak(saturday(hour))).toBe(false);
      expect(isOffPeak(saturday(hour))).toBe(true);
    }
    // Sunday, same windows.
    for (const hour of [1, 3, 6, 9]) {
      expect(isPeak(sunday(hour))).toBe(false);
    }
    // Monday — weekday windows resume.
    expect(isPeak(monday(1))).toBe(true);
    expect(isOffPeak(monday(1))).toBe(false);
  });

  it("isBeijingWeekendDay uses Beijing time — Friday 16:00 UTC is already Saturday there", () => {
    expect(isBeijingWeekendDay(new Date(Date.UTC(2026, 8, 4, 16)))).toBe(true); // Sat 00:00 Beijing
    expect(isBeijingWeekendDay(new Date(Date.UTC(2026, 8, 4, 15, 59)))).toBe(false); // Fri 23:59 Beijing
    expect(isBeijingWeekendDay(new Date(Date.UTC(2026, 8, 6, 15, 59)))).toBe(true); // Sun 23:59 Beijing
    expect(isBeijingWeekendDay(new Date(Date.UTC(2026, 8, 7, 15, 59)))).toBe(false); // Mon 23:59 Beijing
  });
});

describe("minutesUntilRateChange", () => {
  it.each([
    [0, 0, 60], // 00:00 → 01:00 (peak)
    [3, 0, 60], // 03:00 → 04:00 (off-peak)
    [5, 0, 60], // 05:00 → 06:00 (peak)
    [9, 0, 60], // 09:00 → 10:00 (off-peak)
    [10, 0, 900], // 10:00 → 01:00 tomorrow (15h) — weekday wrap, next day is Friday
    [12, 30, 750], // 12:30 → 01:00 tomorrow (12.5h)
  ])("UTC %i:%02i → %i min", (hour, minute, mins) => {
    expect(minutesUntilRateChange(weekday(hour, minute))).toBe(mins);
  });

  it("weekends count down to Monday 01:00 UTC (can exceed a day)", () => {
    // Sat 03:00 UTC → Mon 01:00 UTC = 46h.
    expect(minutesUntilRateChange(saturday(3))).toBe(2760);
    // Sun 12:00 UTC → Mon 01:00 UTC = 13h.
    expect(minutesUntilRateChange(sunday(12))).toBe(780);
  });

  it("Friday evenings skip the weekend and land on Monday 01:00 UTC", () => {
    // Fri 10:00 UTC (18:00 Beijing) → Mon 01:00 UTC = 63h.
    expect(minutesUntilRateChange(new Date(Date.UTC(2026, 8, 4, 10)))).toBe(3780);
    // Fri 23:00 UTC (Sat 07:00 Beijing — weekend day) → Mon 01:00 UTC = 50h.
    expect(minutesUntilRateChange(new Date(Date.UTC(2026, 8, 4, 23)))).toBe(3000);
  });

  it("weekday same-day boundaries still apply after the effective date", () => {
    // Mon 00:30 UTC → 01:00 UTC.
    expect(minutesUntilRateChange(monday(0, 30))).toBe(30);
    // Mon 23:00 UTC → Tue 01:00 UTC.
    expect(minutesUntilRateChange(monday(23))).toBe(120);
  });
});
