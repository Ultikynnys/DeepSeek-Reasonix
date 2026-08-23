/** Shared plumbing for MCP transports: closed-guard, close semantics, and the incoming message queue. */

import { MessageQueue, consumeSseStream } from "./message-queue.js";
import { syntheticRpcError } from "./transport-utils.js";
import type { JsonRpcMessage } from "./types.js";

/**
 * Base class for MCP transports: owns the incoming queue and the closed flag.
 */
export abstract class BaseMcpTransport {
  protected readonly incoming = new MessageQueue();
  protected closed = false;
  /** Abort signal for in-flight fetches — aborted on close. */
  protected readonly controller = new AbortController();

  /** Async iterator over incoming messages. Ends when the connection closes. */
  messages(): AsyncIterableIterator<JsonRpcMessage> {
    return this.incoming.messages();
  }

  /** Throws when `close()` (or the peer closing) has shut this transport down. */
  protected assertOpen(transportName: string): void {
    if (this.closed) throw new Error(`MCP ${transportName} transport is closed`);
  }

  /** Marks the transport closed and wakes any pending message waiters. No-op when already closed; returns whether this call performed the close. */
  protected markClosed(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.incoming.close();
    return true;
  }

  /** Abort in-flight fetches. Safe to call more than once. */
  protected abortFetch(): void {
    try {
      this.controller.abort();
    } catch {
      /* already aborted */
    }
  }

  /** Consume an SSE body, pushing a synthetic error notification if the stream dies while open. Shared by the SSE and Streamable HTTP transports. */
  protected async consumeSseGuarded(
    body: AsyncIterable<Uint8Array>,
    onEvent: (ev: { event?: string; data: string }) => void,
    label: string,
    opts: { shouldStop?: () => boolean } = {},
  ): Promise<void> {
    try {
      await consumeSseStream(body, onEvent, opts);
    } catch (err) {
      if (!this.closed) {
        this.incoming.push(syntheticRpcError(`${label} stream error: ${(err as Error).message}`));
      }
    }
  }
}
