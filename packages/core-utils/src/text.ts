/** Shared text helpers — whitespace flattening + clipping. Every session
 *  title / summary site used to re-implement `replace(/\s+/g, " ") + trim`
 *  with its own clip-and-ellipsis variant. */

/** Collapse all whitespace runs (incl. newlines) into single spaces, then trim. */
export function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clip `text` at `max` chars, appending `ellipsis` (default "…") when it had to clip. */
export function clipText(text: string, max: number, ellipsis = "…"): string {
  return text.length > max ? `${text.slice(0, max)}${ellipsis}` : text;
}

export interface SanitizeFilenameOptions {
  /** Max length before clamping. Default 64. */
  max?: number;
  /** Replacement for non-safe characters. Default "_". */
  replaceWith?: string;
  /** Keep CJK ideographs (safe on all modern filesystems). Default false. */
  allowCjk?: boolean;
  /** Strip leading/trailing runs of `replaceWith`. Default false. */
  trim?: boolean;
  /** Returned when the result is empty. Default "" — callers decide. */
  fallback?: string;
}

/** Strip non-safe characters → clamp length → fallback when empty. The single
 *  sanitizer for filenames derived from user/model text (session names, tool
 *  names, registry aliases) — those used to be reimplemented per site with
 *  subtly different rules. */
export function sanitizeFilename(name: string, opts: SanitizeFilenameOptions = {}): string {
  const { max = 64, replaceWith = "_", allowCjk = false, trim = false, fallback = "" } = opts;
  const safe = allowCjk ? /[^\w\-\u4e00-\u9fa5]/g : /[^\w\-]/g;
  let cleaned = name.replace(safe, replaceWith);
  if (trim) {
    const escaped = replaceWith.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, "g"), "");
  }
  cleaned = cleaned.slice(0, max);
  return cleaned || fallback;
}
