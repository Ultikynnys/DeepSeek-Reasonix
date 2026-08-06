/** Format a byte count for display (KB/MB/GB, adaptive precision). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n;
  let idx = -1;
  do {
    value /= 1024;
    idx += 1;
  } while (value >= 1024 && idx < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
}
