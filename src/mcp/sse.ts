/** MCP HTTP+SSE transport (spec 2024-11-05) — POST endpoint URL arrives as the first `event: endpoint` SSE frame. */

import { BaseMcpTransport } from "./base-transport.js";
import { parseSseMessageEvent } from "./message-queue.js";
import type { McpTransport } from "./stdio.js";
import { syntheticRpcError } from "./transport-utils.js";
import type { JsonRpcMessage } from "./types.js";

export interface SseTransportOptions {
  /** SSE endpoint URL, e.g. `https://mcp.example.com/sse`. */
  url: string;
  /** Extra headers sent on both the SSE GET and the JSON-RPC POSTs (e.g. `Authorization`). */
  headers?: Record<string, string>;
}

export class SseTransport extends BaseMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private postUrl: string | null = null;
  private readonly endpointReady: Promise<string>;
  private resolveEndpoint!: (url: string) => void;
  private rejectEndpoint!: (err: Error) => void;

  constructor(opts: SseTransportOptions) {
    super();
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.endpointReady = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    // Swallow unhandled-rejection noise if nobody ever calls send().
    this.endpointReady.catch(() => undefined);
    void this.runStream();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.assertOpen("SSE");
    const postUrl = await this.endpointReady;
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    // Drain body so the socket returns to the pool even if the server
    // elected to write one. We explicitly don't parse it — responses
    // arrive on the SSE channel.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) {
      throw new Error(`MCP SSE POST ${postUrl} failed: ${res.status} ${res.statusText}`);
    }
  }

  async close(): Promise<void> {
    if (!this.markClosed()) return;
    // Reject any still-pending send() that was waiting for the endpoint.
    this.rejectEndpoint(new Error("MCP SSE transport closed before endpoint was ready"));
    this.abortFetch();
  }

  private async runStream(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...this.headers },
        signal: this.controller.signal,
      });
    } catch (err) {
      this.failHandshake(`SSE connect to ${this.url} failed: ${(err as Error).message}`);
      return;
    }
    if (!res.ok || !res.body) {
      // Drain body to free the socket before giving up.
      await res.body?.cancel().catch(() => undefined);
      this.failHandshake(`SSE handshake ${this.url} → ${res.status} ${res.statusText}`);
      return;
    }

    await this.consumeSseGuarded(
      res.body as AsyncIterable<Uint8Array>,
      (ev) => this.handleEvent(ev.event ?? "message", ev.data),
      "SSE",
    );
    this.markClosed();
  }

  private handleEvent(type: string, data: string): void {
    if (type === "endpoint") {
      if (this.postUrl) return; // ignore repeat announcements
      try {
        this.postUrl = new URL(data, this.url).toString();
        this.resolveEndpoint(this.postUrl);
      } catch (err) {
        this.failHandshake(`SSE endpoint event had bad URL "${data}": ${(err as Error).message}`);
      }
      return;
    }
    // `message` events carry JSON-RPC; unknown event types (server pings,
    // custom extensions) are ignored. Malformed JSON is dropped, same as stdio.
    const msg = parseSseMessageEvent(type, data);
    if (msg) this.incoming.push(msg);
  }

  private failHandshake(reason: string): void {
    this.rejectEndpoint(new Error(reason));
    this.incoming.push(syntheticRpcError(reason));
    this.markClosed();
  }
}
