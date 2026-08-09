import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS } from "@reasonix/core-utils";
import type { Event } from "../core/events.js";
import { readJsonlLines } from "../core/jsonl.js";
import { SESSION_EVENTS_SUFFIX } from "../memory/session.js";
import type { EventSource } from "../ports/event-sink.js";
import { eventLogPath } from "./event-sink-jsonl.js";

/** Most-recently-modified `*.events.jsonl` files, capped + filtered by stale-mtime cutoff. */
export function recentEventFiles(dir: string, now: number, cap = 8, staleDays = 30): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now - staleDays * DAY_MS;
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith(SESSION_EVENTS_SUFFIX)) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;
    candidates.push({ path, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, cap).map((c) => c.path);
}

function isEvent(ev: unknown): ev is Event {
  return !!ev && typeof ev === "object" && typeof (ev as { type?: unknown }).type === "string";
}

export function readEventLogFile(path: string): Event[] {
  if (!existsSync(path)) return [];
  return readJsonlLines(path, isEvent);
}

export class JsonlEventSource implements EventSource {
  async *read(sessionName: string): AsyncIterable<Event> {
    const events = readEventLogFile(eventLogPath(sessionName));
    for (const ev of events) yield ev;
  }
}
