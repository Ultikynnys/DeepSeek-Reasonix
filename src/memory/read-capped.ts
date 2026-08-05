/** Shared "read a text file, trim it, cap it with a truncation marker" logic — every memory/prefix assembly site used to re-implement this. */

import { readFileSync } from "node:fs";

export interface CappedText {
  /** Post-truncation content (may end with a "… (truncated N chars)" marker). */
  content: string;
  /** Length before truncation. */
  originalChars: number;
  /** True iff `originalChars > maxChars`. */
  truncated: boolean;
}

/** Cap `text` at `maxChars`, appending a marker line when it's longer. */
export function truncateWithMarker(text: string, maxChars: number): CappedText {
  const originalChars = text.length;
  const truncated = originalChars > maxChars;
  const content = truncated
    ? `${text.slice(0, maxChars)}\n… (truncated ${originalChars - maxChars} chars)`
    : text;
  return { content, originalChars, truncated };
}

/** Read + trim a UTF-8 text file, capped at `maxChars`. Null when missing, unreadable, or blank after trimming. */
export function readCappedTextFile(path: string, maxChars: number): CappedText | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return truncateWithMarker(trimmed, maxChars);
}
