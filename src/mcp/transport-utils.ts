/** Shared transport helpers — used by all MCP transports. */

import { JSONRPC_VERSION } from "./types.js";
import type { JsonRpcMessage } from "./types.js";

/** Build a synthetic JSON-RPC error notification (id: null, code -32000). */
export function syntheticRpcError(message: string): JsonRpcMessage {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: null,
    error: { code: -32000, message },
  };
}

export interface PostJsonOptions {
  /** Extra headers merged over `content-type: application/json`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** POST one JSON-RPC message, mapping network failures to a labeled error. */
export async function postJson(
  url: string,
  message: JsonRpcMessage,
  label: string,
  opts: PostJsonOptions = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(message),
      signal: opts.signal,
    });
  } catch (err) {
    throw new Error(`MCP ${label} POST ${url} failed: ${(err as Error).message}`);
  }
}

/** Drain a response body we never intend to read. */
export async function drainBody(res: Pick<Response, "body">): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Drain a response body we explicitly don't parse (SSE POST acks). */
export async function discardBody(res: Pick<Response, "arrayBuffer">): Promise<void> {
  await res.arrayBuffer().catch(() => undefined);
}

/** Push a parsed `application/json` payload: single message or batch array. */
export function pushJsonRpcPayload(push: (msg: JsonRpcMessage) => void, parsed: unknown): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) push(item as JsonRpcMessage);
  } else {
    push(parsed as JsonRpcMessage);
  }
}
