<!-- platform:begin — this section is auto-managed by Reasonix (overwritten on playwright-tooling-version bumps). Your additions go below the platform:end marker and survive upgrades. -->
<!-- playwright-tooling-version: 2 -->

# Playwright driver — real-browser control through the extension relay

**Agents: read this file fully before your first use in a session.** The driver
lets you drive the user's REAL Edge browser (their logged-in sessions, their
tabs) through the Playwright MCP extension relay. It is zero-dependency: plain
`node` (≥ 22), no repo, no npm install.

## What this is

`driver.mjs` starts `@playwright/mcp` in `--extension` mode exactly as
configured in `~/.reasonix/config.json` (`mcpServers.playwright`, relay token
included) — over an HTTP transport on a localhost port, once, persistently —
and forwards your tool calls to the browser over the MCP Streamable HTTP
endpoint. The token is validated **by the extension in the browser** — a wrong
token does not error, it silently hangs until timeout. That is why every run
starts with a cheap call.

## Usage

```sh
node ~/.reasonix/tools/playwright/driver.mjs list                     # tabs listing — run FIRST as the connection check
node ~/.reasonix/tools/playwright/driver.mjs open <url>               # new tab + listing
node ~/.reasonix/tools/playwright/driver.mjs call <tool> '{"args":1}' # one tool call
node ~/.reasonix/tools/playwright/driver.mjs seq steps.json           # multi-step flow, stops on first isError
node ~/.reasonix/tools/playwright/driver.mjs stop                     # end the persistent server (closes group tabs)
```

Timeouts default to 30s (`DRIVER_TIMEOUT_MS` env overrides). Exit codes:
0 ok · 1 failure · 2 timeout (wrong token / Edge closed) · 3 tool isError · 4 usage.

## Connection check semantics (matches the desktop card's "Test connection")

- `list` returning tabs → the token works.
- Timeout after 30s → **the stored token is likely wrong, or Edge isn't running
  with the extension installed**. Check `mcpServers.playwright.env
  ["PLAYWRIGHT_MCP_EXTENSION_TOKEN"]` — it must be the BARE token value (no
  `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` prefix, no quotes). A verbatim-pasted
  `KEY=value` line is the #1 historical cause of silent hangs.

## Tool catalog (all take JSON args; names as below)

| Tool | Purpose |
| --- | --- |
| `browser_tabs` | `{action:"list"\|"new"\|"close"\|"select", url?, index?}` — tab control; your client only sees ITS tab group |
| `browser_navigate` | `{url}` — navigate the current tab |
| `browser_navigate_back` | history back |
| `browser_click` | `{target, element?}` — click; `target` = snapshot ref or CSS selector |
| `browser_type` | `{target, text, submit?, slowly?}` — type into an element |
| `browser_press_key` | `{key}` |
| `browser_hover` | `{target}` |
| `browser_drag` / `browser_drop` | drag & drop, incl. file paths |
| `browser_fill_form` | `{fields:[{target,type,value}]}` |
| `browser_select_option` | `{target, values:[...]}` |
| `browser_snapshot` | accessibility tree (prefer over screenshots for acting) |
| `browser_find` | `{text\|regex}` — search the snapshot for a node + ref |
| `browser_evaluate` | `{function}` — JS in the page; best for state checks |
| `browser_wait_for` | `{text\|textGone\|time}` |
| `browser_take_screenshot` | `{filename?, fullPage?, element?}` |
| `browser_console_messages` | console logs since last nav |
| `browser_network_requests` / `browser_network_request` | request list / one request's details |
| `browser_file_upload` | absolute paths |
| `browser_handle_dialog` | accept/dismiss modal dialogs |
| `browser_run_code_unsafe` | arbitrary Playwright code — avoid; RCE-equivalent |
| `browser_close`, `browser_resize` | page lifecycle |

## Hard-won gotchas (verified on this machine — trust these)

1. **Fresh client sees only its own group.** A new run lists exactly one tab:
   the extension's `connect.html` Welcome page. The user's other tabs are in
   OTHER groups and are NOT visible. Open your own tab with
   `open <url>` / `browser_tabs {action:"new"}` — do not assume access to
   existing tabs unless the user drags them into your group.
2. **Tool results are formatted, not raw.** A tool's output looks like
   `### Result\n- 0: [Title](url)\n### Events…\n### Ran Playwright code…`.
   For `browser_evaluate`, the returned value is a JSON-quoted string INSIDE
   that block, so quotes are backslash-escaped: extract the `{"..."} ` line and
   `.replace(/\\"/g, '"')` before `JSON.parse`. The driver's `extractJson`
   helper does this — copy it into your flow scripts.
3. **Don't regex `.pop()` the last line of a result** — the block ends with the
   Playwright-code trailer. Anchor on the first `https://…` match or the first
   `{...}` line.
4. **YouTube search box**: `browser_type` into `input#search` can fail with
   "does not match any elements" (slow hydration). Reliable fallback:
   navigate straight to
   `https://www.youtube.com/results?search_query=<urlencoded query>`, then
   `browser_evaluate` `document.querySelector('ytd-video-renderer a#video-title')?.href`.
5. **Ads**: poll `document.querySelector('video')?.duration` every ~2s; click
   `.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button` while
   an ad overlay (`.ytp-ad-player-overlay`) shows; accept duration only when
   `> 60` and no overlay.
6. **Seek + pause in one shot**:
   `v.pause(); v.currentTime = v.duration * 0.5;` via `browser_evaluate`, then
   verify after ~2s (`currentTime`, `paused`) — seek isn't synchronous.
7. **Timeouts are the token signal**: a hung call = token mismatch or Edge
   closed. Never increase the timeout to "wait it out" — 30s max, then report.
8. **Token hygiene**: the config stores the bare token. If you ever paste the
   dialog's copy (`PLAYWRIGHT_MCP_EXTENSION_TOKEN=…`) anywhere, strip the
   prefix first.
9. **The HTTP server is `localhost`-only, literally**: it binds the IPv6
   loopback (`[::1]:PORT`) and rejects anything else. Hand-rolled probes must
   use `http://localhost:PORT/mcp` — raw `127.0.0.1` is connection-refused
   (nothing on IPv4), and explicit `http://[::1]:PORT` answers **403 "Access
   is only allowed at localhost:PORT"**. Also: `netstat -ano -p TCP` shows no
   listener for it (IPv4 only) — drop `-p TCP` or use `netstat -ano` to see it.

## Persistent server (the reuse contract)

The driver keeps **one server alive across invocations**: state lives in
`.server.json` next to this file (port, pid, relay session id). The first
command auto-starts the server (~4s); later commands attach in well under a
second — same server, same relay session, same tab group, no new
connect-page tab. That is the whole point: the tool set exists once.

- End it explicitly with `node driver.mjs stop` (closes the group's tabs, then
  kills the server) — e.g. before switching `--browser` in the config, or when
  you know the session is done.
- A stale `.server.json` (server crashed) self-heals: the next invocation
  re-handshakes or respawns automatically.
- The relay session also persists; if the server expired it server-side
  (404), the driver re-handshakes transparently.
- `DRIVER_PORT` env overrides the port (default 8931; scans upward if busy).

## Waste policy (tab groups)

- Prefer ONE `seq` run with many steps over N separate invocations — even
  though the server persists, fewer calls mean less relay chatter.
- `--close-tabs-all` closes every tab in your group — use it for throwaway
  flows (tests, screenshots), NEVER when the user wants to keep the end state
  (e.g. a paused video for them to see).
- If you leave tabs open, say so in your reply and tell the user which group
  they live in ("reasonix" group in Edge).
- Dead tab groups from a killed stdio-mode session (pre-v2 runs) are user
  cleanup — point them out if you see them accumulate.

## Proven recipe (2026-09-10 session)

Search → play → seek 50% → pause, all in one `seq` file:

```json
[
  { "tool": "browser_tabs", "args": { "action": "new", "url": "https://www.youtube.com/watch?v=4NRXx6U8ABQ" } },
  { "tool": "browser_evaluate", "args": { "function": "() => { const v = document.querySelector('video'); v.pause(); v.currentTime = v.duration * 0.5; return v.currentTime; }" } }
]
```

Result that run: duration 262.5s, verified current 131.3s, `paused=true`.
<!-- platform:end -->

## Agent notes (append below — the platform refreshes only the section above)

<!-- Agents: add durable findings here. Keep entries terse; newest at top. -->