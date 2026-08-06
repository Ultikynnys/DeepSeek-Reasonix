/** Incoming-message queue shared by all MCP transports: `push` produces, `messages()` consumes (blocking on waiters), `close()` wakes them with null. Buffered messages still drain after close — transports often close right after the server answered. */

import { createParser } from "eventsource-parser";
import type { JsonRpcMessage } from "./types.js";

export class MessageQueue {
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private closed = false;

  push(msg: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  async *messages(): AsyncIterableIterator<JsonRpcMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<JsonRpcMessage | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next === null) return; // closed while we were waiting
      yield next;
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }
}

/** Parse one SSE `message` event's data as a JSON-RPC message; null for other event types or malformed JSON. */
export function parseSseMessageEvent(type: string, data: string): JsonRpcMessage | null {
  if (type !== "message") return null;
  try {
    return JSON.parse(data) as JsonRpcMessage;
  } catch {
    return null;
  }
}

/** Feed an SSE response body through an event-source parser, decoding UTF-8 incrementally. */
export async function consumeSseStream(
  body: AsyncIterable<Uint8Array>,
  onEvent: (ev: { event?: string; data: string }) => void,
  opts: { shouldStop?: () => boolean } = {},
): Promise<void> {
  const parser = createParser({
    onEvent: (ev) => onEvent({ event: ev.event, data: ev.data }),
  });
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    if (opts.shouldStop?.()) break;
    parser.feed(decoder.decode(chunk, { stream: true }));
  }
}
