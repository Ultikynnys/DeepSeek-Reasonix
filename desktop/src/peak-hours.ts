import {
  DEEPSEEK_RATE_SCHEDULE,
  isOffPeakRate,
  isPeakRate,
  isRateScheduleWeekend,
  minutesUntilRateChangeForSchedule,
  type RateSchedule,
} from "@reasonix/core-utils";

/**
 * Compatibility wrappers for the original DeepSeek rate-period API. New callers
 * can pass another schedule while sharing the same weekend and boundary engine.
 */
export function isBeijingWeekendDay(date: Date): boolean {
  return isRateScheduleWeekend(date, DEEPSEEK_RATE_SCHEDULE);
}

export function isPeak(date: Date, schedule: RateSchedule = DEEPSEEK_RATE_SCHEDULE): boolean {
  return isPeakRate(date, schedule);
}

export function isOffPeak(date: Date, schedule: RateSchedule = DEEPSEEK_RATE_SCHEDULE): boolean {
  return isOffPeakRate(date, schedule);
}

export function minutesUntilRateChange(
  date: Date,
  schedule: RateSchedule = DEEPSEEK_RATE_SCHEDULE,
): number {
  return minutesUntilRateChangeForSchedule(date, schedule);
}

/** The rate multiplier the status bar shows for the current period. */
export function rateMultiplier(
  date: Date,
  schedule: RateSchedule = DEEPSEEK_RATE_SCHEDULE,
): number {
  return isPeakRate(date, schedule)
    ? (schedule.peakMultiplier ?? 2)
    : (schedule.offPeakMultiplier ?? 1);
}
