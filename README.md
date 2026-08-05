<h1 align="center">Reasonix</h1>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="https://esengine.github.io/DeepSeek-Reasonix/">Website</a>
  &nbsp;·&nbsp;
  <a href="https://esengine.github.io/DeepSeek-Reasonix/configuration.html">Guide</a>
  &nbsp;·&nbsp;
  <a href="./docs/ARCHITECTURE.md">Architecture</a>
  &nbsp;·&nbsp;
  <strong><a href="https://discord.gg/XF78rEME2D">Discord</a></strong>
</p>

<p align="center">
  <a href="https://github.com/esengine/reasonix/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/esengine/reasonix/release.yml?style=flat-square&label=release&labelColor=161b22&logo=githubactions&logoColor=white" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/esengine/reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <a href="https://github.com/esengine/reasonix/stargazers"><img src="https://img.shields.io/github/stars/esengine/reasonix.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
  <a href="https://atomgit.com/esengine/DeepSeek-Reasonix"><img src="https://atomgit.com/esengine/DeepSeek-Reasonix/star/badge.svg" alt="AtomGit stars"/></a>
  <a href="https://github.com/esengine/reasonix/graphs/contributors"><img src="https://img.shields.io/github/contributors/esengine/reasonix.svg?style=flat-square&color=bc8cff&labelColor=161b22&logo=github&logoColor=white" alt="contributors"/></a>
  <a href="https://github.com/esengine/reasonix/discussions"><img src="https://img.shields.io/github/discussions/esengine/reasonix.svg?style=flat-square&color=58a6ff&labelColor=161b22&logo=github&logoColor=white" alt="Discussions"/></a>
  <a href="https://discord.gg/XF78rEME2D"><img src="https://img.shields.io/badge/discord-join-5865F2.svg?style=flat-square&labelColor=161b22&logo=discord&logoColor=white" alt="Discord"/></a>
</p>

<p align="center">
  <a href="https://oosmetrics.com/repo/esengine/reasonix"><img src="https://api.oosmetrics.com/api/v1/badge/achievement/9e931d80-2050-4b10-902e-44970cc133ad.svg" alt="oosmetrics — Top 2 in Agents by velocity"/></a>
  <a href="https://oosmetrics.com/repo/esengine/reasonix"><img src="https://api.oosmetrics.com/api/v1/badge/achievement/556d94b3-61b7-486b-baf2-888b9327deab.svg" alt="oosmetrics — Top 3 in LLMs by velocity"/></a>
</p>

<br/>

<h3 align="center">A DeepSeek-native AI coding agent for your desktop.</h3>
<p align="center">Engineered around prefix-cache stability — so token costs stay low across long sessions, and you can leave it running.</p>

<br/>

> [!TIP]
> **Cache stability isn't a feature you turn on; it's an invariant the loop is designed around.** That's the whole reason Reasonix is DeepSeek-only — every layer is tuned to the byte-stable prefix-cache mechanic.

> [!NOTE]
> **Real user, single day (2026-05-01):** 435M input tokens, **99.82% cache hit**, ~$12 instead of the ~$61 the same workload would cost with no cache on `v4-flash`. DeepSeek provides the cacheable bytes; the four mechanisms in [Pillar 1](./docs/ARCHITECTURE.md#pillar-1--cache-first-loop) are how Reasonix keeps them cacheable across long sessions.

> [!IMPORTANT]
> **Community · 加入社区** — bilingual Discord with channels for setup help (`#help` / `#求助`), workflow showcases, feature ideas, and contributor-only PR coordination. Verify your GitHub in-server to get the **Contributor** role automatically. → **<https://discord.gg/XF78rEME2D>**

<br/>

## Install

### Desktop app for Windows (recommended)

Download the latest Windows installer from [GitHub Releases](https://github.com/esengine/DeepSeek-Reasonix/releases) and run `Reasonix_x.y.z_x64-setup.exe`. The app bundles its own Node runtime and the same `~/.reasonix` config — multi-tab sessions, a right panel listing files the agent read or edited, and the live cost / cache / token meters. No `npm install`, no Node needed; grab a [DeepSeek API key →](https://platform.deepseek.com/api_keys) on first run.

- **Windows** — SmartScreen may warn "Unknown publisher" while installers are unsigned: click **More info → Run anyway**.

### QQ channel

QQ can extend an existing desktop session as a remote channel. It is part of the current session flow, not a separate runtime mode.

- Desktop: open `Settings -> General -> QQ Channel`

Once connected, QQ messages can enter the current session, assistant replies route back to QQ, and follow-up interactions can continue remotely.

For full setup, desktop quick start, and troubleshooting, see [QQ channel setup](./docs/qq-connect.md).

<details>
<summary><strong>Author your first skill</strong></summary>

**Author your first skill.** No remote registry — write them directly. Edit the file (`description:` frontmatter + body), then `/skill list`. Add `runAs: subagent` to spawn an isolated subagent loop instead of inlining the body.

~~~bash
/skill new my-skill              # <project>/.reasonix/skills/my-skill.md
/skill new my-skill --global     # ~/.reasonix/skills for cross-project use
~~~

**Claude-format skills also load.** `<project>/.claude/skills/<name>/SKILL.md` and `~/.claude/skills/` are read alongside Reasonix's native paths, so tooling that emits Claude-format skills works out of the box. Example — drop OpenSpec workflows in without an upstream adapter:

~~~bash
npx openspec init --tools claude    # writes .claude/skills/openspec-*/SKILL.md
/skill openspec-propose <task>      # then invoke from Reasonix
~~~

</details>

<br/>

## Configuration

One JSON file at `~/.reasonix/config.json` plus per-project overrides under `<project>/.reasonix/`. The full bilingual reference — every key, every slash command, the on-disk shape of skills/memory/hooks — lives at:

> 📘 **[Configuration Guide](https://esengine.github.io/DeepSeek-Reasonix/configuration.html)** · [中文](https://esengine.github.io/DeepSeek-Reasonix/configuration.html?lang=zh)

| Topic | Quick read |
|---|---|
| [MCP servers](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#mcp) | stdio · SSE · Streamable HTTP. Configured in the desktop Settings or `config.json` — one spec format. |
| [Skills](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#skills) | Markdown playbooks the model can invoke. `inline` or `subagent` mode. |
| [Memory](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#memory) | User-private knowledge pinned into the prefix. `user` / `feedback` / `project` / `reference` types. |
| [Hooks](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#hooks) | Shell commands on lifecycle events. `PreToolUse` (gating) · `PostToolUse` · `UserPromptSubmit` · `Stop`. |
| [Permissions](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#permissions) | Per-workspace shell allowlist. Exact-prefix match. |
| [Web search](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#search) | Mojeek by default; switch to self-hosted SearXNG or Metaso with `/search-engine`. |
| [Semantic index](https://esengine.github.io/DeepSeek-Reasonix/configuration.html#index) | Local Ollama or any OpenAI-compatible embedding endpoint. |

<br/>

## What makes Reasonix different

The loop is organized around three pillars. Each one solves a problem generic agent frameworks don't even see — because they were designed for a different cache mechanic.

<sub align="center">

Click through to the full architecture writeup → [Pillar 1 — Cache-first loop](./docs/ARCHITECTURE.md#pillar-1--cache-first-loop) · [Pillar 2 — Tool-call repair](./docs/ARCHITECTURE.md#pillar-2--tool-call-repair) · [Pillar 3 — Cost control](./docs/ARCHITECTURE.md#pillar-3--cost-control-v06)

</sub>

<br/>

## Capabilities

- Cell-diff renderer (SEARCH/REPLACE review) · MCP servers · plan mode · permissions
- Persistent sessions · hooks / skills / memory · semantic search · auto-checkpoints
- `/effort` knob · transcript replay · event log · embedded web dashboard

<br/>

## How it compares

|                                   | Reasonix         | Claude Code       | Cursor              | Aider              |
|-----------------------------------|------------------|-------------------|---------------------|--------------------|
| Backend                           | DeepSeek         | Anthropic         | OpenAI / Anthropic  | any (OpenRouter)   |
| License                           | **MIT**          | closed            | closed              | Apache 2           |
| Cost profile                      | **low per task** | premium           | subscription + use  | varies             |
| DeepSeek prefix-cache             | **engineered**   | not applicable    | not applicable      | incidental         |
| Embedded web dashboard            | yes              | —                 | n/a (IDE)           | —                  |
| Configurable web search engine    | `/search-engine` | —             | —                   | —                  |
| Persistent per-workspace sessions | yes              | partial           | n/a                 | —                  |
| Plan mode · MCP · hooks · skills  | yes              | yes               | yes                 | partial            |
| Web search (Mojeek + SearXNG + Metaso)   | yes              | yes               | yes                 | yes                |
| Open community development        | yes              | —                 | —                   | yes                |

<br/>

## Documentation

- [**Architecture**](./docs/ARCHITECTURE.md) — three pillars: cache-first loop, tool-call repair, cost control
- [**QQ channel setup**](./docs/qq-connect.md) — desktop entry, CLI first-connect flow, and QQ Open Platform credentials
- [**Website**](https://esengine.github.io/DeepSeek-Reasonix/) — getting started, dashboard
- [**Contributing**](./CONTRIBUTING.md) — comment policy, error-handling rules, library-over-hand-rolled
- [**Code of Conduct**](./CODE_OF_CONDUCT.md) · [**Security policy**](./SECURITY.md)

<br/>

## Community

> [!NOTE]
> Reasonix is open source and community-developed. Every avatar in the Acknowledgments wall at the bottom of this file is a real PR that shipped.

Scoped starter tickets — each with background, code pointers, acceptance criteria, and hints — live under the [`good first issue`](https://github.com/esengine/reasonix/labels/good%20first%20issue) label. Pick anything open.

**Open Discussions — opinions wanted:**

- [#21 · Dashboard design](https://github.com/esengine/reasonix/discussions/21) — react against the [proposed mockup](https://esengine.github.io/DeepSeek-Reasonix/design/agent-dashboard.html)
- [#22 · Future feature wishlist](https://github.com/esengine/reasonix/discussions/22) — what would you build into Reasonix next?

**Already using Reasonix and willing to help others discover it?** Publish blog posts, articles, screenshots, talks, or videos to [**Show and tell**](https://github.com/esengine/reasonix/discussions/categories/show-and-tell). The project has no marketing budget — community word of mouth is how new users find it. Sustained advocates earn the badge below, displayed next to the contributors wall once awarded:

<p align="center">
  <a href="https://github.com/esengine/reasonix/discussions/categories/show-and-tell">
    <img src="https://img.shields.io/badge/REASONIX-📣%20ADVOCATE-c4b5fd?style=for-the-badge&labelColor=0d1117" alt="Reasonix Advocate badge — earned by sustained advocates"/>
  </a>
</p>

**Before your first PR**: read [`CONTRIBUTING.md`](./CONTRIBUTING.md) — short, strict rules (comments, errors, libraries-over-hand-rolled). `tests/comment-policy.test.ts` enforces the comment ones; `npm run verify` is the pre-push gate. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues → [SECURITY.md](./SECURITY.md).

<br/>

## Non-goals

> [!IMPORTANT]
> Reasonix is opinionated. Some things it deliberately *doesn't* do — listed here so you can pick the right tool for your work.

- **Multi-provider flexibility.** DeepSeek-only on purpose. Coupling to one backend is the feature, not a limitation.
- **IDE integration.** Desktop-first. The Windows app is the primary surface. The dashboard is a companion, not a Cursor replacement.
- **Hardest-leaderboard reasoning.** Claude Opus still wins some benchmarks. DeepSeek is competitive on coding; if your work is "solve this PhD proof" rather than "fix this auth bug," start with Claude.
- **Air-gapped / fully-free.** Reasonix needs a paid DeepSeek API key. For air-gapped or zero-cost runs see Aider + Ollama or [Continue](https://continue.dev).

<br/>

## Star History

<a href="https://www.star-history.com/?repos=esengine%2FDeepSeek-Reasonix&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=esengine/DeepSeek-Reasonix&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=esengine/DeepSeek-Reasonix&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=esengine/DeepSeek-Reasonix&type=date&legend=top-left" />
 </picture>
</a>

<br/>

## Support

If Reasonix has been useful and you'd like to say thanks, you can. It stays a coffee, not a contract — donations don't buy feature priority or change how issues get triaged.

- **International** — PayPal: [paypal.me/yuhuahui](https://paypal.me/yuhuahui)
- **国内** — 微信支付（扫码）

<p align="center">
  <img src=".github/sponsor/wechat-pay.jpg" alt="WeChat Pay QR code" width="240"/>
</p>

<br/>

## Acknowledgments

A small list of folks whose work has shaped Reasonix the most — measured
by both commit count and code volume. **Listed alphabetically, no ordering
of importance.** The full contributor graph is on
[GitHub](https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors).

- [**ctharvey**](https://github.com/ctharvey)
- [**dimasd-angga**](https://github.com/dimasd-angga) (Dimas D. Angga)
- [**Evan-Pycraft**](https://github.com/Evan-Pycraft)
- [**ForeverYoungPp**](https://github.com/ForeverYoungPp)
- [**GTC2080**](https://github.com/GTC2080) (TaoMu)
- [**kabaka9527**](https://github.com/kabaka9527)
- [**lisniuse**](https://github.com/lisniuse) (Richie)
- [**wade19990814-hue**](https://github.com/wade19990814-hue)
- [**wviana**](https://github.com/wviana) (Wesley Viana)

Also a separate thank-you to [**Bernardxu123**](https://github.com/Bernardxu123)
for designing the project logo, and to [AIGC Link](https://xhslink.com/m/80ngts127cA) for promoting the project on XiaoHongShu.

<p align="center">
  <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=esengine/DeepSeek-Reasonix&max=100&columns=12" alt="Contributors to esengine/DeepSeek-Reasonix" width="860"/>
  </a>
</p>

<br/>

---

<p align="center">
  <sub>MIT — see <a href="./LICENSE">LICENSE</a></sub>
  <br/>
  <sub>Built by the community at <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">esengine/DeepSeek-Reasonix</a></sub>
</p>
