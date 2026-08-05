import { type WriteStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Event } from "../core/events.js";
import {
  SESSION_EVENTS_SUFFIX,
  chmodPrivate,
  sanitizeName,
  sessionsDir,
} from "../memory/session.js";
import type { EventSink } from "../ports/event-sink.js";

export function eventLogPath(sessionName: string): string {
  return join(sessionsDir(), `${sanitizeName(sessionName)}${SESSION_EVENTS_SUFFIX}`);
}

export class JsonlEventSink implements EventSink {
  private buffered = 0;

  constructor(private readonly stream: WriteStream) {}

  append(ev: Event): void {
    // Skip model.delta — recoverable from model.final.text, would balloon sidecar.
    if (ev.type === "model.delta") return;
    this.stream.write(`${JSON.stringify(ev)}\n`);
    this.buffered++;
  }

  flush(): Promise<void> {
    return new Promise((resolve) => {
      if (this.buffered === 0) return resolve();
      this.stream.uncork();
      this.buffered = 0;
      resolve();
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

export function openEventSink(path: string): JsonlEventSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a" });
  chmodPrivate(path);
  return new JsonlEventSink(stream);
}
