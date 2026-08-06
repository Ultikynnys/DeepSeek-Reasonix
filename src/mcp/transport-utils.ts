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
