/** Shared transport helpers — used by all MCP transports. */

import type { JsonRpcMessage } from "./types.js";

/** Build a synthetic JSON-RPC error notification (id: null, code -32000). */
export function syntheticRpcError(message: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message },
  };
}
