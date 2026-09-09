/** Adaptive token-count label for meters and chips: 66_851_100 → "66.9m",
 *  12_345 → "12.3k", 999 → "999". One formatter for every token display so the
 *  unit scales with magnitude instead of pinning to kilo. */
export function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString();
}