export interface SessionRecencyInput {
  name: string;
  mtime: Date | string | number;
  /** Explicit creation epoch-ms from the session's meta (`createdAt`).
   *  Wins over the name-embedded timestamp when present so renamed/archived
   *  sessions keep their original creation date. */
  createdAt?: number;
  /** Explicit last-activity epoch-ms from the session's meta (`updatedAt`).
   *  Wins over mtime when present so ordering survives file copies/restores
   *  that reset the filesystem timestamps. */
  lastActive?: number;
  updatedAt?: number;
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

/** Compute session recency from the explicit activity stamp (when present),
 *  the filesystem mtime, and the timestamp embedded in the name — max of the
 *  three, so a stale mtime or missing meta can never hide recent activity. */
export function sessionRecency(session: SessionRecencyInput): number {
  const lastActive =
    typeof session.lastActive === "number" && Number.isFinite(session.lastActive)
      ? session.lastActive
      : typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : 0;
  return Math.max(lastActive, mtimeMilliseconds(session.mtime), parseSessionTimestamp(session.name));
}

/** Deterministic newest-first ordering with a descending-name tie-break. */
export function sortSessionsDescending<T extends SessionRecencyInput>(a: T, b: T): number {
  const recencyDiff = sessionRecency(b) - sessionRecency(a);
  return recencyDiff || b.name.localeCompare(a.name);
}

/** Session creation time: the explicit meta stamp when present, else the
 *  timestamp embedded in the name, else the filesystem mtime. Mirrors the
 *  fallback chain of `sessionRecency` so legacy sessions without a meta
 *  stamp still order sensibly. */
export function sessionCreationTime(session: SessionRecencyInput): number {
  if (typeof session.createdAt === "number" && Number.isFinite(session.createdAt)) {
    return session.createdAt;
  }
  return parseSessionTimestamp(session.name) || mtimeMilliseconds(session.mtime);
}

/** Newest-created-first ordering with a descending-name tie-break — used for
 *  workspace session lists, where the sidebar sorts by creation date rather
 *  than last activity. */
export function sortSessionsByCreationDescending<T extends SessionRecencyInput>(a: T, b: T): number {
  const createdDiff = sessionCreationTime(b) - sessionCreationTime(a);
  return createdDiff || b.name.localeCompare(a.name);
}
