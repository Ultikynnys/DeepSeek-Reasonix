// Claude `.mcp.json` reader — project-level MCP config that teams check into git.
// Returns the raw `mcpServers` block so the caller can merge it into `cfg.mcpServers`
// before normalizeMcpConfig runs. Field aliasing (`type` → `transport`,
// `http` → `streamable-http`) happens in inferMcpTransport, not here.
import { join } from "node:path";
import type { McpServerConfig } from "../config.js";
import { readJsonFileSilently } from "../core/json-file.js";

export const DOT_MCP_JSON = ".mcp.json";

export function loadDotMcpJson(projectRoot: string): Record<string, McpServerConfig> | undefined {
  const path = join(projectRoot, DOT_MCP_JSON);
  const parsed = readJsonFileSilently<{ mcpServers?: unknown }>(
    path,
    (v): v is { mcpServers?: unknown } => !!v && typeof v === "object",
  );
  if (!parsed) return undefined;
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out[name] = entry as McpServerConfig;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
