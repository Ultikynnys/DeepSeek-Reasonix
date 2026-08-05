/** Shared JSONL parsing — session logs, event logs, and the usage log all re-implemented split → trim → parse → validate. */

import { readFileSync } from "node:fs";

function acceptAll<T>(_raw: unknown): _raw is T {
  return true;
}

/** Parse a JSONL string into validated values; blank lines and malformed JSON are skipped. */
export function parseJsonl<T = unknown>(
  raw: string,
  validate: (raw: unknown) => raw is T = acceptAll<T>,
): T[] {
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (validate(value)) out.push(value);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Parse a JSONL file; missing or unreadable files yield []. */
export function readJsonlLines<T = unknown>(
  path: string,
  validate: (raw: unknown) => raw is T = acceptAll<T>,
): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parseJsonl(raw, validate);
}
