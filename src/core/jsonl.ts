/** Shared JSONL parsing + appending — session logs, event logs, and the usage log all re-implemented split → trim → parse → validate (read) and mkdir → append (write). */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "@reasonix/core-utils";

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
    } catch (err) {
      /* skip malformed line — but the corruption must be LOUD */
      process.stderr.write(`reasonix: JSONL parse skipped malformed line — ${messageOf(err)}\n`);
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

/** Count non-blank lines without parsing — cheap no-op-rewrite check for log compactors. */
export function countJsonlLines(raw: string): number {
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) count++;
  }
  return count;
}

/** Append one JSON value as a JSONL line, creating the parent dir if needed. */
export function appendJsonlLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}
