# MCP client (v0.3 foundation)

Minimal [Model Context Protocol](https://spec.modelcontextprotocol.io/)
client, hand-rolled in TypeScript. Lets Reasonix consume tools from any
MCP server (filesystem, github, slack, puppeteer, …) while applying the
Cache-First Loop and tool-call repair to the whole thing automatically.

## Design choice: roll-our-own, not @modelcontextprotocol/sdk

Same reasoning that drove `client.ts` (DeepSeek) rather than `openai`:

- **Zero runtime deps** for this module. Consistent with Reasonix's
  policy of owning the wire format where it matters.
- **Surface tuning**: we only implement what Reasonix actually uses —
  initialize + tools/list + tools/call. Resources, prompts, sampling,
  and progress notifications are deferred.
- **Insulation** from SDK breaking changes. The spec is more stable
  than any single SDK release.

Swappable if needed: `McpClient` depends on the `McpTransport` interface,
so the day we do want the official SDK's transport layer we can adapt
it and keep everything else.

## What's shipped here

```
src/mcp/
├── types.ts      JSON-RPC 2.0 + MCP-specific message types
├── stdio.ts      McpTransport interface + StdioTransport (spawn child)
├── sse.ts        SseTransport (HTTP+SSE for remote/hosted servers)
├── spec.ts       parseMcpSpec — parses mcp config entries into transport-tagged specs
├── catalog.ts    curated list of popular official MCP servers
├── client.ts     McpClient: initialize / listTools / callTool
├── registry.ts   bridgeMcpTools: MCP → ToolRegistry
└── README.md     (this file)

tests/mcp.test.ts — in-process fake transport, no child processes
tests/mcp-sse.test.ts — in-process http.Server fake for SSE
```

## What's NOT here (yet)

| feature | status | note |
|---|---|---|
| Desktop wiring (Settings → MCP, or `config.json`) | ✅ shipped | servers load at app start |
| Bundled demo server | ✅ shipped | `tests/fixtures/mcp-server-demo.ts`, exposes echo/add/get_time |
| Real-subprocess integration test | ✅ shipped | `tests/mcp-integration.test.ts` |
| Resources / `resources/list` / `resources/read` | deferred | Reasonix doesn't surface resources today |
| Prompts / `prompts/list` | deferred | ditto |
| Progress notifications | deferred | long-running tool support comes with the CLI work |
| Streaming results | deferred | current shape returns one CallToolResult per call |
| SSE transport | ✅ shipped | `src/mcp/sse.ts` — pass an `http(s)://…` URL in the server spec |
| Streamable HTTP (2025-03-26 spec) | deferred | waiting for a real server to validate against |
| MCP server that Reasonix exposes | never | out of scope — Reasonix is a client |

## Usage (desktop)

MCP servers are configured in the desktop app — `Settings -> MCP`, or the
`mcp` array in `~/.reasonix/config.json`. Each server's tools become
first-class citizens of the loop and inherit Reasonix's cache-first prefix
stability + repair (schema flatten, tool-call scavenge, call-storm break)
automatically.

Each spec is shell-split (spaces separate args; use quotes for paths with
spaces). Windows-friendly: backslashes pass through literally outside
quotes, so `C:\path\to\dir` works.

## Wire protocol notes (stdio)

- **Framing**: newline-delimited JSON. One JSON-RPC message per line,
  UTF-8, no Content-Length header (that's LSP, not MCP stdio).
- **Stderr**: forwarded to the parent's stderr. Servers often print
  startup banners there; that's fine.
- **Shutdown**: `close()` calls `child.stdin.end()` then SIGTERM if the
  process hasn't exited.
- **Malformed lines**: dropped silently. Some servers emit non-JSON
  during startup; logging every dropped line would be noise.
- **Debugging dropped lines**: set `REASONIX_DEBUG_MCP=1` to print each
  dropped malformed line to stderr, prefixed with
  `[mcp-stdio] dropped malformed line:`. Useful when an MCP server
  ships truncated or corrupted frames and tool calls come back empty.
