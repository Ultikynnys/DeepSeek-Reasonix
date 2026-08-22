/**
 * DeepSeek rate periods (UTC). Peak hours are 01:00–04:00 and 06:00–10:00 UTC
 * (09:00–12:00 and 14:00–18:00 Beijing); all other hours are off-peak. Off-peak
 * rates are half of peak rates. From 2026-08-23 00:00 Beijing, off-peak rates
 * apply throughout the day on weekends (Saturdays and Sundays, Beijing Time).
 */

/** Peak windows as [startHour, endHour) in UTC. End is exclusive. */
export const PEAK_HOURS_UTC: readonly { start: number; end: number }[] = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

/** Off-peak rates are half of the peak rates. */
export const OFF_PEAK_RATE_MULTIPLIER = 0.5;

/** 2026-08-23 00:00 Beijing = 2026-08-22 16:00 UTC — weekend all-day off-peak takes effect. */
export const WEEKEND_OFF_PEAK_SINCE_UTC = Date.UTC(2026, 7, 22, 16);

/** True when the weekend all-day off-peak rule is in effect for this instant. */
export function weekendOffPeakActive(date: Date): boolean {
  return date.getTime() >= WEEKEND_OFF_PEAK_SINCE_UTC;
}

/** True when the Beijing-calendar day containing `date` is Saturday or Sunday (UTC+8, no DST). */
export function isBeijingWeekendDay(date: Date): boolean {
  const day = new Date(date.getTime() + 8 * 3600 * 1000).getUTCDay();
  return day === 0 || day === 6;
}

export function isPeak(date: Date): boolean {
  if (weekendOffPeakActive(date) && isBeijingWeekendDay(date)) return false;
  const hour = date.getUTCHours();
  return PEAK_HOURS_UTC.some((w) => hour >= w.start && hour < w.end);
}

export function isOffPeak(date: Date): boolean {
  return !isPeak(date);
}

/** Minutes until the rate period changes at the next window boundary. Weekends
 *  are off-peak all day, so the next change can be the coming Monday 01:00 UTC
 *  and may exceed 1440. */
export function minutesUntilRateChange(date: Date): number {
  const nowMs = date.getTime();
  // Weekend (after the effective date): no same-day boundaries — next change is
  // the first 01:00 UTC boundary on a Beijing weekday (Monday).
  if (weekendOffPeakActive(date) && isBeijingWeekendDay(date)) {
    return minutesToNextWeekdayBoundary(date, nowMs);
  }
  const now = date.getUTCHours() * 60 + date.getUTCMinutes();
  const boundaries = PEAK_HOURS_UTC.flatMap((w) => [w.start, w.end]).sort((a, b) => a - b);
  for (const b of boundaries) {
    if (b * 60 > now) return b * 60 - now;
  }
  if (!weekendOffPeakActive(date)) {
    // Legacy schedule: wrap to tomorrow's first boundary (01:00 UTC).
    return boundaries[0]! * 60 + (1440 - now);
  }
  // Weekday evening — skip the weekend days, land on Monday 01:00 UTC.
  return minutesToNextWeekdayBoundary(date, nowMs);
}

/** Minutes until the first 01:00 UTC boundary on a Beijing weekday (skips Sat/Sun). */
function minutesToNextWeekdayBoundary(date: Date, nowMs: number): number {
  const day0 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  for (let days = 1; days <= 8; days++) {
    const boundary = day0 + days * 86_400_000 + 3_600_000; // 01:00 UTC of that day
    if (isBeijingWeekendDay(new Date(boundary))) continue;
    return Math.round((boundary - nowMs) / 60_000);
  }
  return 8 * 1440; // unreachable — 8 consecutive weekend days cannot happen
}
