/** Shared JSON-string parsing that reports failure instead of throwing. */

export type ParseJsonResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Parse a JSON string, returning a discriminated result. Never throws. */
export function tryParseJson(raw: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err };
  }
}
