/** Shared relative-time ladder — formats a millisecond duration as a short human-readable age string. */

/** Format `ms` as a human-readable relative age: "Ns ago", "Nm ago", "Nh ago", "Nd ago". */
export function fmtRelativeTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
