<h1 align="center">Reasonix</h1>

<p align="center">
  <a href="https://github.com/Ultikynnys/DeepSeek-Reasonix/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Ultikynnys/DeepSeek-Reasonix/release.yml?style=flat-square&label=release&labelColor=161b22&logo=githubactions&logoColor=white" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Ultikynnys/DeepSeek-Reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&labelColor=161b22" alt="Node >= 22"/>
</p>

<br/>

<h3 align="center">A DeepSeek-native coding agent for Windows, engineered around prefix-cache stability.</h3>
<p align="center">Token costs stay low across long sessions, so it is a tool you can leave running.</p>

> [!NOTE]
> **This is a fork.** This repository is a personal, desktop-only line of
> [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix): the Ink TUI and the
> interactive CLI chat modes are gone, the only product surface is the Tauri 2 Windows app backed by
> a headless JSON-RPC daemon, and the cache-first loop from the v1 line was ported forward. The
> concrete differences are listed in [Divergence from upstream](#divergence-from-upstream).

> [!TIP]
> **Cache stability is not a feature you turn on; it is an invariant the loop is designed around.**
> DeepSeek bills cached input at a small fraction of the miss rate, and the cache only hits when the
> exact byte prefix of the previous request is preserved. Every layer of the loop is tuned to keep
> that prefix byte-stable. DeepSeek remains the default backend; the GPT-5.6 family and Ollama are
> supported as options (see [Backends and models](#backends-and-models)).

<br/>

## Install

### Windows desktop app (recommended)

Download the latest Windows installer from
[GitHub Releases](https://github.com/Ultikynnys/DeepSeek-Reasonix/releases) and run
`Reasonix_x.y.z_x64-setup.exe`. The installer is built and published by the
[release workflow](https://github.com/Ultikynnys/DeepSeek-Reasonix/actions/workflows/release.yml) on
every push to `main`, and the app auto-updates from the same releases. The app bundles its own Node
runtime, so no `npm install` or Node installation is needed.

- First run asks for a [DeepSeek API key](https://platform.deepseek.com/api_keys). The key is stored
  in the app's config; `DEEPSEEK_API_KEY` in `.env` is read as a fallback.
- SmartScreen may warn "Unknown publisher" while installers are unsigned: click **More info → Run
  anyway**. See [desktop/SIGNING.md](desktop/SIGNING.md) for the signing setup.
- **Windows only, by design.** Supported devices were deliberately simplified to a single
  platform: this fork is maintained by one person who runs Reasonix on Windows only, and removing
  the macOS/Linux and CLI code (platform-specific Tauri configs, the bundled-Node platform
  branches, the Ink TUI, the interactive CLI commands) was the obvious way to keep the project
  lightweight and stable. There are no plans to bring other platforms back.
- User data lives in `~/.reasonix` (config, sessions, memory, skills).

## Backends and models

| Backend | Models | Auth |
| --- | --- | --- |
| DeepSeek (default) | `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` (experimental vision line) | `DEEPSEEK_API_KEY` |
| OpenAI-compatible | GPT-5.6 family: `gpt-5.6` (alias of Sol) / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` for proxies / Azure-compatible gateways |
| Ollama | any local model via `ollama/<name>`; cloud Ollama is also supported | local daemon is keyless; cloud needs `OLLAMA_API_KEY` |

- Models are picked in Settings → Models or from the composer. The Ollama catalog is fetched once at
  launch, cached for 60 s, and shared by every tab; refresh buttons force a refetch.
- `gpt-*` ids route to `https://api.openai.com/v1` automatically; DeepSeek ids route to
  `https://api.deepseek.com` (overridable via `DEEPSEEK_BASE_URL`).
- Reasoning effort (`low | medium | high | xhigh | max`) is set per model via the `/effort` command
  or Settings.
- Image attachments (paste or drop) are enabled for vision-capable models: the GPT-5.6 family and
  `deepseek-v4-flash-vision-exp`. DeepSeek bills image tokens as input tokens.
- See [.env.example](.env.example) for the full list of supported environment variables.

## What makes Reasonix different

The loop is organized around three pillars, each one a response to DeepSeek's exact-prefix cache
billing:

1. **Cache-first loop.** Context is partitioned into an immutable prefix (system + tool specs,
   computed and pinned once per session), an append-only event log, and a volatile scratch region
   that never reaches the API. No rewrites, no injected timestamps: consecutive turns share a
   byte-stable prefix, so the cache hits turn after turn.
2. **Tool-call repair.** Malformed, truncated, or redundant tool calls are repaired (flatten,
   scavenge, storm, truncation) and re-dispatched instead of failing the turn.
3. **Cost control.** Flash-first defaults for the main loop and for every auxiliary call
   (subagents, summaries, compaction), turn-end auto-compaction of oversized tool results, a
   per-turn iteration cap with a grace window, an optional USD budget, and live cost/cache metering
   with off-peak/peak rate awareness (peak hours bill at 2x; off-peak applies all day on weekends,
   Beijing time).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full writeup.

## Features

**Desktop app (Tauri 2, React)**

- Multi-tab sessions with persistent per-workspace state, a session list, and session titles.
- Composer with `@`-mentions for workspace files, image paste/drop for vision models, slash
  commands (`/new`, `/clear`, `/abort`, `/copy`, `/model`, `/search-engine`, `/skill`, `/theme`,
  `/currency`, `/lang`, `/plan <mode>`, `/effort <level>`), and queued sends.
- Edit modes `plan`, `review`, `auto`, `yolo` (Shift+Tab or `/model <mode>`): SEARCH/REPLACE edits
  are shown for approval in review mode; yolo mode skips approval and never pauses a productive turn
  at the iteration cap.
- Context panel listing files the agent read or edited; jobs panel for background processes.
- Status bar: live cache-hit %, context tokens, this-turn cost (USD/CNY), the current off-peak/peak
  rate period, account balance (DeepSeek) or weekly quota (GPT-5.6 Codex, Ollama plan), workspace,
  model + effort.
- Settings pages: general, models, MCP, skills, memory, rules, billing, shortcuts.
- Themes (dark/light plus accent styles), keyboard shortcuts.

**Agent runtime**

- MCP client with stdio, SSE, and Streamable HTTP transports, a server catalog, `.mcp.json` project
  config, and in-app server management.
- Skills: markdown playbooks in `<project>/.reasonix/skills/` and `~/.reasonix/skills/`, run inline
  or as isolated subagents; Claude-format skills under `.claude/skills/` load as-is.
- Memory: project (`REASONIX.md`), session, user, and runtime stores; user memory pins preferences
  into the prefix.
- Hooks: shell commands on lifecycle events, `PreToolUse` (gating), `PostToolUse`,
  `UserPromptSubmit`, `Stop`.
- Web search: `bing` by default (works from CN without a proxy), switchable in Settings to
  `bing-intl`, `searxng`, `metaso`, `baidu`, `tavily`, `perplexity`, `exa`, `brave`, or Ollama
  cloud search.
- Semantic index over the workspace via local Ollama embeddings (`nomic-embed-text` by default) or
  any OpenAI-compatible embedding endpoint.
- Plan mode with structured, reviewable plans.
- Shell: allowlisted command execution with config-based permissions, command chains, background
  jobs with streaming output.
- Event log: every session is an append-only JSONL of typed kernel events, replayable through pure
  projections.

## Configuration

- User config: `~/.reasonix/config.json` (model, reasoning effort, web search engine, pricing
  overrides, rate limits, and more).
- Per-project: `<project>/.reasonix/settings.json` (hooks), `<project>/.reasonix/skills/`, and
  `<project>/REASONIX.md` (project memory).
- Environment variables: see [.env.example](.env.example). `REASONIX_LOG_LEVEL=INFO` controls
  logging; `REASONIX_TRANSCRIPT_DIR` relocates session transcripts.
- Pricing overrides: `pricingOverride` in `config.json` sets per-model USD rates when a model's
  published price is missing or wrong.

## Development

Requires Node >= 22 and npm.

| Command | What it does |
| --- | --- |
| `npm install` | install dependencies (runs `scripts/postinstall.mjs`) |
| `npm run dev` | run the headless desktop backend (`tsx src/cli/index.ts desktop`) |
| `npm run build` | tsup bundle into `dist/` |
| `npm run build:desktop` | build the desktop UI (vite) |
| `npm run test` | vitest |
| `npm run lint` / `npm run format` | biome |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run typecheck:desktop` | desktop app typecheck |
| `npm run verify` | build + lint + typecheck + typecheck:desktop + tests (the pre-push gate) |

- Desktop UI dev server: `npm --prefix desktop run dev`; the Tauri shell lives in
  `desktop/src-tauri/`.
- CI: `.github/workflows/release.yml` verifies every push to `main` on Windows, bumps the patch
  version, tags `vX.Y.Z`, and publishes the NSIS installer to a GitHub Release (the app's updater
  reads `latest.json` from the latest release).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the three pillars, cache-first loop, tool-call repair,
  and cost control
- [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security
  policy](SECURITY.md)
- [Installer signing](desktop/SIGNING.md)

## Divergence from upstream

The fork keeps the MIT license and the cache-first core, and removes or changes the rest:

- **Removed**: the Ink TUI and the interactive CLI commands (`code`, `replay`, `diff`); the
  embedded web dashboard server (config helpers remain, but nothing serves it); the QQ channel
  integration and its docs; upstream's community pages (Discord, sponsors, acknowledgments wall).
  All of it is scope: the fork targets Windows only, so every cross-platform and CLI surface was
  cut to keep the build and runtime lightweight and stable.
- **Added / changed**: the Tauri 2 Windows app as the only product surface; Ollama support (local
  and cloud) with a shared, cached model catalog; the GPT-5.6 family and
  `deepseek-v4-flash-vision-exp` in the official model list; image attachments; edit modes including
  `yolo`; the per-turn iteration cap with a grace window (yolo bypasses the pause); off-peak/peak
  rate display and the current pricing table; Codex and Ollama quota chips in the status bar.
- The CLI entry (`src/cli/index.ts`) exposes a single `desktop` command: headless JSON-RPC over
  stdio, spawned by the Tauri shell.

## License

MIT. See [LICENSE](LICENSE). Upstream project:
[esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix).
