/** Best-effort JSON file cache helpers — shared by the version checker and the MCP registry fetcher. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { dirname } from "node:path";
import { messageOf } from "@reasonix/core-utils";

/** Parse + validate a JSON string, returning null on malformed or wrong-shape input. */
function parseJsonSilently<T>(raw: string, validate: (v: unknown) => v is T): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read + parse + validate a JSON file, returning null on any failure (missing, malformed, or wrong shape). */
export function readJsonFileSilently<T>(path: string, validate: (v: unknown) => v is T): T | null {
  try {
    return parseJsonSilently(readFileSync(path, "utf8"), validate);
  } catch {
    return null;
  }
}

/** Async variant of readJsonFileSilently — for callers already on the promise API. */
export async function readJsonFileSilentlyAsync<T>(
  path: string,
  validate: (v: unknown) => v is T,
): Promise<T | null> {
  try {
    return parseJsonSilently(await readFileAsync(path, "utf8"), validate);
  } catch {
    return null;
  }
}

/** Write a JSON file, creating parent directories. Failures are swallowed — caches are best-effort. */
export function writeJsonFileSilently(
  path: string,
  data: unknown,
  opts: { pretty?: boolean } = {},
): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, opts.pretty ? 2 : undefined), "utf8");
  } catch (err) {
    /* cache is best-effort — a failed write just means we'll re-fetch, but the failure must be LOUD */
    process.stderr.write(`reasonix: JSON cache write failed — ${messageOf(err)}\n`);
  }
}
