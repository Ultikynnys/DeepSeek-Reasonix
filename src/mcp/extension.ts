/** Configures Playwright MCP browser connections and locates the bundled extension. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightMcpConnectionMode } from "@reasonix/core-utils/desktop-protocol";

/** Official Chrome Web Store listing — "Playwright Extension" (Microsoft, Apache-2.0). */
export const PLAYWRIGHT_EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

/** @playwright/mcp CLI flag enabling the extension-relay transport. */
export const PLAYWRIGHT_EXTENSION_ARG = "--extension";
/** Env var carrying the per-profile relay token — set it to skip the extension's
 *  per-connection approval dialog (the token is shown in that dialog). */
export const PLAYWRIGHT_EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
const CONNECTION_VALUE_ARGS = new Set(["--browser", "--cdp-endpoint", "--profile-dir-name"]);
export const PLAYWRIGHT_MANAGED_BROWSERS = ["chrome", "firefox", "webkit", "msedge"] as const;
const MANAGED_MODES = new Set<PlaywrightMcpConnectionMode>(PLAYWRIGHT_MANAGED_BROWSERS);

export function isPlaywrightManagedBrowser(
  value: unknown,
): value is (typeof PLAYWRIGHT_MANAGED_BROWSERS)[number] {
  return typeof value === "string" && MANAGED_MODES.has(value as PlaywrightMcpConnectionMode);
}

export function playwrightBrowserInstallArgs(
  browser: unknown,
  packageId = "@playwright/mcp",
): string[] {
  if (!isPlaywrightManagedBrowser(browser)) throw new Error("unsupported managed browser");
  return ["-y", packageId, "install-browser", browser];
}

/** Parse Reasonix's supported connection modes from a Playwright MCP argv. */
export function parsePlaywrightConnection(args: string[]): {
  mode: PlaywrightMcpConnectionMode;
  cdpEndpoint?: string;
} {
  if (args.includes(PLAYWRIGHT_EXTENSION_ARG)) return { mode: "extension" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const cdpEndpoint =
      arg === "--cdp-endpoint" ? args[index + 1] : arg.match(/^--cdp-endpoint=(.+)$/)?.[1];
    if (cdpEndpoint) return { mode: "cdp", cdpEndpoint };
    const browser = arg === "--browser" ? args[index + 1] : arg.match(/^--browser=(.+)$/)?.[1];
    if (browser && MANAGED_MODES.has(browser as PlaywrightMcpConnectionMode)) {
      return { mode: browser as PlaywrightMcpConnectionMode };
    }
  }
  return { mode: "chrome" };
}

/** Replace connection-specific flags while preserving package pins and unrelated user options. */
export function configurePlaywrightArgs(
  args: string[],
  mode: PlaywrightMcpConnectionMode,
  cdpEndpoint?: string,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === PLAYWRIGHT_EXTENSION_ARG) continue;
    if (CONNECTION_VALUE_ARGS.has(arg)) {
      index += 1;
      continue;
    }
    if (/^--(?:browser|cdp-endpoint|profile-dir-name)=/.test(arg)) continue;
    result.push(arg);
  }
  if (mode === "extension") return [...result, PLAYWRIGHT_EXTENSION_ARG];
  if (mode === "cdp") {
    const endpoint = cdpEndpoint?.trim();
    if (!endpoint) throw new Error("a Chromium CDP endpoint is required");
    if (!/^https?:\/\/|^wss?:\/\//i.test(endpoint)) {
      throw new Error("the Chromium CDP endpoint must use http, https, ws, or wss");
    }
    return [...result, `--cdp-endpoint=${endpoint}`];
  }
  return [...result, `--browser=${mode}`];
}

/** Normalize a user-pasted relay token. The extension's connection dialog copies
 *  the whole `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>` line, so strip that prefix
 *  (case-insensitive) plus any wrapping quotes/whitespace — store the bare token. */
export function normalizeExtensionToken(raw: string): string {
  let token = raw.trim();
  const prefix = `${PLAYWRIGHT_EXTENSION_TOKEN_ENV}=`;
  if (token.toLowerCase().startsWith(prefix.toLowerCase())) token = token.slice(prefix.length);
  token = token.trim();
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    token = token.slice(1, -1);
  }
  return token.trim();
}

export interface BundledExtensionInfo {
  present: boolean;
  /** Candidate dir that was resolved (even when not present) — for UI hints. */
  path: string | null;
  /** Store version recorded by the bundler in `_store_version.txt`. */
  version: string | null;
}

/** Env override for tests and exotic installs. */
const ENV_OVERRIDE = "REASONIX_PLAYWRIGHT_EXTENSION_PATH";

/** Candidates mirror the tokenizer's resolveDataPath depths (dist/index.js vs
 *  dist/cli/* vs tsx dev); `present` requires manifest.json — otherwise use the
 *  Web Store. Bundled dir comes from tauri.windows.conf.json at packaging. */
export function resolveBundledPlaywrightExtension(): BundledExtensionInfo {
  const candidates: string[] = [];
  const override = process.env[ENV_OVERRIDE];
  if (override) candidates.push(override);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → <install>/dist/../assets
    candidates.push(join(here, "..", "assets", "playwright-extension"));
    // dist/cli/* → <install>/dist/../assets
    candidates.push(join(here, "..", "..", "assets", "playwright-extension"));
    // tsx dev (src/mcp/*) → repo/desktop/src-tauri/binaries
    candidates.push(
      join(here, "..", "..", "..", "desktop", "src-tauri", "binaries", "playwright-extension"),
    );
  } catch {
    /* import.meta.url unavailable — env override / cwd-relative fallbacks only */
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, "manifest.json"))) {
      let version: string | null = null;
      try {
        version = readFileSync(join(dir, "_store_version.txt"), "utf8").trim() || null;
      } catch {
        /* stamp absent — still present */
      }
      return { present: true, path: dir, version };
    }
  }
  return { present: false, path: candidates[0] ?? null, version: null };
}
