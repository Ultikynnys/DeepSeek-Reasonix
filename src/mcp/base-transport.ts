/** Shared plumbing for MCP transports: closed-guard, close semantics, and the incoming message queue. */

import { MessageQueue } from "./message-queue.js";
import type { JsonRpcMessage } from "./types.js";

/**
 * Base class for MCP transports: owns the incoming queue and the closed flag.
 */
export abstract class BaseMcpTransport {
  protected readonly incoming = new MessageQueue();
  protected closed = false;

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
}
