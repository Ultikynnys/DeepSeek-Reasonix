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
