# Security Policy

If you find a security issue in Reasonix, please report it privately rather than opening a public issue or discussion thread.

## How to report

Email <359807859@qq.com> with:

- a clear description of the issue
- steps that reproduce it (a minimal repro is fine)
- the version (`reasonix --version`) and platform you observed it on

You'll get an acknowledgement within a few days, and a fix or mitigation as soon as the maintainer can land it. If you'd like attribution in the release notes when the fix ships, say so in your report — the default is a quiet patch.

## Supported versions

Only the latest published minor of `reasonix` on npm is actively maintained. If you're on something older, please reproduce on the latest before reporting.

## Scope

**In scope:**

- The Windows desktop app — Tauri 2 shell (`desktop/`) and the Node backend (`src/`)
- The bundled Node runtime and its resource loading
- The shell sandbox, edit gate, and tool dispatcher in `src/`

**Out of scope:**

- Third-party MCP servers attached to the app (report to those projects)
- Misconfiguration of the user's own DeepSeek API key, environment, or shell profile
- Vulnerabilities in upstream Node.js or in the DeepSeek API itself
- Denial-of-service via deliberately oversized prompts or tool inputs (Reasonix is a single-user desktop app; there's no multi-tenant boundary to defend)

## Hardening notes

A few practical reminders for users running Reasonix:

- API keys live in `~/.reasonix/config.json`. Treat that file like any other credential store.
- `run_command` and the `!` shell shortcut respect a permission allowlist; the safe default is `ask` on anything not pre-approved. Don't set `editMode: yolo` on machines that hold secrets you'd regret leaking.
- Hooks (`PreToolUse`, etc.) execute arbitrary shell scripts the user has configured. Audit `.reasonix/settings.json` before running Reasonix in a directory you didn't author.
