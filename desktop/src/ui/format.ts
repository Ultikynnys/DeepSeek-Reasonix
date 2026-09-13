/** Adaptive token-count label for meters and chips: 66_851_100 → "66.9m",
 *  12_345 → "12.3k", 999 → "999". One formatter for every token display so the
 *  unit scales with magnitude instead of pinning to kilo. */
export function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

/** Cache-hit rate as a percentage with one decimal, e.g. "99.9". Truncated,
 *  never rounded up: a near-total hit rate (cached context dwarfs the new
 *  miss) must not collapse to an impossible "100.0%". */
export function hitPercent(hit: number, miss: number): string {
  const denom = (hit || 0) + (miss || 0);
  if (!(denom > 0)) return "0.0";
  return (Math.floor(((hit || 0) / denom) * 1000) / 10).toFixed(1);
}
