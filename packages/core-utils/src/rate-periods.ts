/** A recurring provider price schedule expressed in UTC clock windows. */
export interface RateSchedule {
  /** Half-open UTC peak windows: [start minute, end minute). */
  peakWindowsUtc: readonly { startMinute: number; endMinute: number }[];
  /** Offset used to decide whether the provider's billing calendar is on a weekend. */
  weekendOffsetMinutes: number;
}

/** DeepSeek's billing calendar uses Beijing weekdays and two UTC peak windows. */
export const DEEPSEEK_RATE_SCHEDULE: RateSchedule = {
  peakWindowsUtc: [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ],
  weekendOffsetMinutes: 8 * 60,
};

/** Ollama Cloud peaks from 12:00 through 18:00 UTC on UTC weekdays. */
export const OLLAMA_RATE_SCHEDULE: RateSchedule = {
  peakWindowsUtc: [{ startMinute: 12 * 60, endMinute: 18 * 60 }],
  weekendOffsetMinutes: 0,
};

/** Strip the `ollama/` namespace prefix and any `:tag` suffix from an Ollama model id. */
export function normalizeOllamaModelId(model: string): string {
  return model.replace(/^ollama\//, "").replace(/:[^:]*$/, "");
}

/** Models whose Ollama Cloud token price changes with OLLAMA_RATE_SCHEDULE. */
export function isOllamaPeakPricedModel(model: string): boolean {
  const id = normalizeOllamaModelId(model);
  return id === "deepseek-v4-flash" || id === "deepseek-v4-pro";
}

/** True when `date` falls on Saturday or Sunday in the schedule's billing calendar. */
export function isRateScheduleWeekend(date: Date, schedule: RateSchedule): boolean {
  const shifted = new Date(date.getTime() + schedule.weekendOffsetMinutes * 60_000);
  const day = shifted.getUTCDay();
  return day === 0 || day === 6;
}

/** True when `date` is inside a configured peak window on a billing weekday. */
export function isPeakRate(date: Date, schedule: RateSchedule): boolean {
  if (isRateScheduleWeekend(date, schedule)) return false;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return schedule.peakWindowsUtc.some(
    (window) => minute >= window.startMinute && minute < window.endMinute,
  );
}

export function isOffPeakRate(date: Date, schedule: RateSchedule): boolean {
  return !isPeakRate(date, schedule);
}

/** Minutes until the next actual peak/off-peak transition, including weekend suppression. */
export function minutesUntilRateChangeForSchedule(date: Date, schedule: RateSchedule): number {
  const peak = isPeakRate(date, schedule);
  const minuteStart = Math.floor(date.getTime() / 60_000) * 60_000;
  for (let minutes = 1; minutes <= 8 * 24 * 60; minutes++) {
    if (isPeakRate(new Date(minuteStart + minutes * 60_000), schedule) !== peak) return minutes;
  }
  return 8 * 24 * 60;
}
