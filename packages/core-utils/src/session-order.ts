export interface SessionRecencyInput {
  name: string;
  mtime: Date | string | number;
}

/** Parse compact timestamp (YYYYMMDDHHmmss or YYYYMMDDHHmm) from a session name. */
export function parseSessionTimestamp(name: string): number {
  const match = name.match(
    /(?:^|[-_])(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:(\d{2}))?(?:[-_]|$)/,
  );
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second ? Number(second) : 0,
  );
}

function mtimeMilliseconds(mtime: SessionRecencyInput["mtime"]): number {
  const value = mtime instanceof Date ? mtime.getTime() : new Date(mtime).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** Compute session recency from filesystem mtime and the timestamp embedded in its name. */
export function sessionRecency(session: SessionRecencyInput): number {
  return Math.max(mtimeMilliseconds(session.mtime), parseSessionTimestamp(session.name));
}

/** Deterministic newest-first ordering with a descending-name tie-break. */
export function sortSessionsDescending<T extends SessionRecencyInput>(a: T, b: T): number {
  const recencyDiff = sessionRecency(b) - sessionRecency(a);
  return recencyDiff || b.name.localeCompare(a.name);
}
