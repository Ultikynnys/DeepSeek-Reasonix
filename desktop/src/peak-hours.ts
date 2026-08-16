/**
 * DeepSeek rate periods (UTC). Peak hours are 01:00–04:00 and 06:00–10:00 UTC;
 * all other hours are off-peak. Off-peak rates are half of peak rates.
 */

/** Peak windows as [startHour, endHour) in UTC. End is exclusive. */
export const PEAK_HOURS_UTC: readonly { start: number; end: number }[] = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

/** Off-peak rates are half of the peak rates. */
export const OFF_PEAK_RATE_MULTIPLIER = 0.5;

export function isPeak(date: Date): boolean {
  const hour = date.getUTCHours();
  return PEAK_HOURS_UTC.some((w) => hour >= w.start && hour < w.end);
}

export function isOffPeak(date: Date): boolean {
  return !isPeak(date);
}

/** Minutes until the rate period changes at the next window boundary (1..1440). */
export function minutesUntilRateChange(date: Date): number {
  const now = date.getUTCHours() * 60 + date.getUTCMinutes();
  const boundaries = PEAK_HOURS_UTC.flatMap((w) => [w.start, w.end]).sort((a, b) => a - b);
  for (const b of boundaries) {
    if (b * 60 > now) return b * 60 - now;
  }
  // Past the last boundary (10:00) — wrap to tomorrow's first one (01:00).
  return boundaries[0]! * 60 + (1440 - now);
}
