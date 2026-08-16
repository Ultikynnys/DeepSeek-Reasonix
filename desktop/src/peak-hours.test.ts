import { describe, expect, it } from "vitest";
import { isOffPeak, isPeak, minutesUntilRateChange } from "./peak-hours";

function utc(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute));
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
    expect(isOffPeak(utc(hour, minute))).toBe(offPeak);
    expect(isPeak(utc(hour, minute))).toBe(!offPeak);
  });
});

describe("minutesUntilRateChange", () => {
  it.each([
    [0, 0, 60], // 00:00 → 01:00 (peak)
    [3, 0, 60], // 03:00 → 04:00 (off-peak)
    [5, 0, 60], // 05:00 → 06:00 (peak)
    [9, 0, 60], // 09:00 → 10:00 (off-peak)
    [10, 0, 900], // 10:00 → 01:00 tomorrow (15h)
    [12, 30, 750], // 12:30 → 01:00 tomorrow (12.5h)
  ])("UTC %i:%02i → %i min", (hour, minute, mins) => {
    expect(minutesUntilRateChange(utc(hour, minute))).toBe(mins);
  });
});
