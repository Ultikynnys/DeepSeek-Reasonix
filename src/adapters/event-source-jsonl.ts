import { existsSync } from "node:fs";
import type { Event } from "../core/events.js";
import { readJsonlLines } from "../core/jsonl.js";
import type { EventSource } from "../ports/event-sink.js";
import { eventLogPath } from "./event-sink-jsonl.js";

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
