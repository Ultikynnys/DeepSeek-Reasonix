/** Hardcoded playwright tooling contract. When a playwright extension-mode MCP
 *  server is bridged, Reasonix guarantees a durable driver + AGENTS.md pair in
 *  the user's global tooling dir (`~/.reasonix/tools/playwright/`):
 *
 *  - the pair is bootstrapped from the bundled templates on first encounter;
 *  - `driver.mjs` is platform-managed — overwritten on version bumps (agent
 *    extensions belong in separate sibling files);
 *  - `AGENTS.md`'s platform section is refreshed on version bumps while the
 *    agent's own notes (below the `platform:end` marker) are preserved;
 *  - every agent driving the browser is told the duty — use the driver, extend
 *    it when tooling is missing, modify it in place when it needs changes, and
 *    keep AGENTS.md updated — via the first-call notice the registry injects.
 *
 *  Detection keys on the server's command line (`@playwright/mcp` +
 *  `--extension`), never on a model name — this is package identity, not
 *  provider categorization. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDiagnostic } from "../diagnostics.js";
import { reasonixHome } from "../reasonix-home.js";
import type { McpServerSpec } from "./spec.js";

export const PLAYWRIGHT_TOOLING_VERSION = 1;
const STAMP_RE = /playwright-tooling-version:\s*(\d+)/;
const PLATFORM_BEGIN = "<!-- platform:begin";
const PLATFORM_END = "<!-- platform:end -->";

const DRIVER_FILE = "driver.mjs";
const AGENTS_FILE = "AGENTS.md";

export function isPlaywrightExtensionSpec(spec: McpServerSpec): boolean {
  if (spec.transport !== "stdio") return false;
  return spec.args.some((a) => a.includes("@playwright/mcp")) && spec.args.includes("--extension");
}

export interface PlaywrightToolingPaths {
  dir: string;
  driverPath: string;
  agentsPath: string;
}

export type PlaywrightToolingStatus = PlaywrightToolingPaths & {
  ok: true;
  created: string[];
  upgraded: string[];
};

export type PlaywrightToolingResult = (
  | PlaywrightToolingStatus
  | (PlaywrightToolingPaths & { ok: false; error: string })
) & {
  /** The dir always has a concrete path — the agent-facing notice uses it even on failure. */
};

/** Template lookup mirrors the tokenizer-data pattern (resolveDataPath): ESM
 *  relative candidates for dist root, dist/cli, src layouts + package-root
 *  fallback. Bundled under `data/` so both the CLI package and the desktop
 *  resources mapping carry it. */
export function resolvePlaywrightTemplatePath(file: string): string {
  const rel = join("tooling", "playwright", file);
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "data", rel));
    candidates.push(join(here, "..", "..", "data", rel));
    candidates.push(join(here, "..", "..", "..", "data", rel));
  } catch {
    /* import.meta.url unavailable — package resolution still applies. */
  }
  try {
    const req = createRequire(import.meta.url);
    candidates.push(join(dirname(req.resolve("reasonix/package.json")), "data", rel));
  } catch {
    /* Not installed as `reasonix/` — earlier candidates still may hit. */
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Nothing exists — return the first candidate so readFileSync surfaces a
  // concrete path in the ENOENT message instead of a silent miss.
  return candidates[0] ?? rel;
}

/** Exposed for tests — clears the default-path memo. */
export function _resetForTests(): void {
  memoizedDefault = null;
}

function readBundledTemplate(file: string): string {
  return readFileSync(resolvePlaywrightTemplatePath(file), "utf8");
}

function stampOf(content: string): number | null {
  const m = STAMP_RE.exec(content.slice(0, 1024));
  return m ? Number(m[1]) : null;
}

/** Create-or-upgrade the global tooling pair. Never clobbers agent-owned
 *  content: driver.mjs is machine-managed (overwritten on version diff),
 *  AGENTS.md only gets its platform-managed section refreshed — a file without
 *  platform markers is treated as agent-owned and left untouched (the newest
 *  platform section lands in `AGENTS.md.platform-latest.md` alongside). */
export function ensurePlaywrightTooling(
  opts: { homeDir?: string; templateDir?: string } = {},
): PlaywrightToolingResult {
  // Memoize the default-path call — the desktop daemon bridges the playwright
  // server repeatedly (connect, reconnect, hot-add) and the bootstrap must not
  // pay fs work (or re-log upgrades) every time. Explicit overrides (tests)
  // bypass the memo so isolated tmp homes stay isolated.
  if (!opts.homeDir && !opts.templateDir) {
    if (memoizedDefault) return memoizedDefault;
    memoizedDefault = ensurePlaywrightToolingUncached(opts);
    return memoizedDefault;
  }
  return ensurePlaywrightToolingUncached(opts);
}

let memoizedDefault: PlaywrightToolingResult | null = null;

function ensurePlaywrightToolingUncached(
  opts: { homeDir?: string; templateDir?: string } = {},
): PlaywrightToolingResult {
  const dir = join(reasonixHome(opts.homeDir), "tools", "playwright");
  const driverPath = join(dir, DRIVER_FILE);
  const agentsPath = join(dir, AGENTS_FILE);
  const paths = { dir, driverPath, agentsPath };
  const created: string[] = [];
  const upgraded: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });

    const bundledDriver = readBundledTemplate(DRIVER_FILE);
    const bundledAgents = readBundledTemplate(AGENTS_FILE);
    const bundledStamp = stampOf(bundledDriver) ?? PLAYWRIGHT_TOOLING_VERSION;

    if (!existsSync(driverPath)) {
      writeFileSync(driverPath, bundledDriver, "utf8");
      created.push(DRIVER_FILE);
    } else {
      const onDisk = stampOf(readFileSync(driverPath, "utf8"));
      if (onDisk === null || onDisk < bundledStamp) {
        writeFileSync(driverPath, bundledDriver, "utf8");
        upgraded.push(DRIVER_FILE);
      }
    }

    if (!existsSync(agentsPath)) {
      writeFileSync(agentsPath, bundledAgents, "utf8");
      created.push(AGENTS_FILE);
    } else {
      const onDisk = readFileSync(agentsPath, "utf8");
      const onDiskStamp = stampOf(onDisk);
      if (onDiskStamp === null) {
        // Agent-owned file without platform markers — never clobber; stage
        // the newest platform section alongside so the agent can merge.
        const latest = join(dir, "AGENTS.md.platform-latest.md");
        writeFileSync(latest, bundledAgents, "utf8");
        upgraded.push("AGENTS.md.platform-latest.md");
      } else if (onDiskStamp < bundledStamp) {
        const begin = onDisk.indexOf(PLATFORM_BEGIN);
        const end = onDisk.indexOf(PLATFORM_END);
        if (begin !== -1 && end !== -1 && end > begin) {
          const merged = `${onDisk.slice(0, begin)}${bundledAgents.slice(bundledAgents.indexOf(PLATFORM_BEGIN), bundledAgents.indexOf(PLATFORM_END) + PLATFORM_END.length)}${onDisk.slice(end)}`;
          writeFileSync(agentsPath, merged, "utf8");
        } else {
          writeFileSync(agentsPath, bundledAgents, "utf8");
        }
        upgraded.push(AGENTS_FILE);
      }
    }
    return { ok: true, dir, driverPath, agentsPath, created, upgraded };
  } catch (err) {
    const error = (err as Error).message;
    recordDiagnostic("playwright.tooling.bootstrap_failed", { level: "error", message: error });
    return { ok: false, error, ...paths };
  }
}

/** Agent-facing duty text injected into the first tool result of a bridged
 *  playwright extension session — every agent driving the browser sees it. */
export function playwrightToolingNotice(status: PlaywrightToolingResult): string {
  const base = `[reasonix playwright tooling] The durable driver + docs for this tool family live at ${status.dir} (driver.mjs + AGENTS.md). Hard requirements: (1) read AGENTS.md before first use; (2) for multi-step or repeated browser flows, drive through \`node <dir>/driver.mjs seq <steps.json>\` instead of one-off calls; (3) if tooling you need is missing, create it there; (4) if existing tooling needs changes, modify it in place; (5) after any change, keep AGENTS.md in that folder updated so future agents find the current state.`;
  if (status.ok) return base;
  return `${base} NOTE: bootstrap failed (${status.error}) — create the folder per the bundled template before relying on it.`;
}

/** Compact per-tool description pointer — unmissable in any tool listing. */
export function playwrightDescriptionSuffix(status: PlaywrightToolingResult): string {
  return `Tooling: ${status.dir} (driver.mjs, AGENTS.md — read + keep updated).`;
}
