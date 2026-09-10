/** Locates and configures the Playwright MCP Chrome extension bundled at packaging time. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDiagnostic } from "../diagnostics.js";
import type { McpServerSpec } from "./spec.js";

/** Official Chrome Web Store listing — "Playwright Extension" (Microsoft, Apache-2.0). */
export const PLAYWRIGHT_EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

/** @playwright/mcp CLI flag enabling the extension-relay transport. */
export const PLAYWRIGHT_EXTENSION_ARG = "--extension";
/** Env var carrying the per-profile relay token — set it to skip the extension's
 *  per-connection approval dialog (the token is shown in that dialog). */
export const PLAYWRIGHT_EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
/** Env var understood by @playwright/mcp for choosing the extension host browser. */
export const PLAYWRIGHT_BROWSER_ENV = "PLAYWRIGHT_MCP_BROWSER";

/** Remove profile pinning so Playwright can discover the active profile that has the extension. */
export function stripPlaywrightProfileArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--profile-dir-name") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile-dir-name=")) continue;
    result.push(arg);
  }
  return result;
}

const WINDOWS_HTTPS_USER_CHOICE =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
const WINDOWS_REG_EXE = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");

export type PlaywrightExtensionBrowser = "chrome" | "msedge";

export interface PlaywrightExtensionBrowserSelection {
  browser: PlaywrightExtensionBrowser;
  source: "default-chrome" | "default-edge" | "forced-edge" | "non-windows";
  progId: string | null;
}

/** Parse the Windows `reg query` response for the current HTTPS handler. */
export function parseWindowsDefaultBrowserProgId(output: string): string | null {
  return /^\s*ProgId\s+REG_\w+\s+(.+?)\s*$/im.exec(output)?.[1]?.trim() || null;
}

/** Select the only browsers supported by Playwright's extension relay. */
export function selectPlaywrightExtensionBrowser(
  progId: string | null,
  platform: NodeJS.Platform = process.platform,
): PlaywrightExtensionBrowserSelection {
  if (platform !== "win32") return { browser: "chrome", source: "non-windows", progId };
  if (progId && /^ChromeHTML(?:\.|$)/i.test(progId)) {
    return { browser: "chrome", source: "default-chrome", progId };
  }
  if (progId && /^MSEdgeHTM(?:\.|$)/i.test(progId)) {
    return { browser: "msedge", source: "default-edge", progId };
  }
  return { browser: "msedge", source: "forced-edge", progId };
}

/** Read Windows' per-user HTTPS association. Unknown/non-Chromium defaults are
 *  handled explicitly as Edge, which ships with supported Windows versions. */
export function resolvePlaywrightExtensionBrowser(
  query: typeof spawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): PlaywrightExtensionBrowserSelection {
  if (platform !== "win32") return selectPlaywrightExtensionBrowser(null, platform);
  const result = query(WINDOWS_REG_EXE, ["query", WINDOWS_HTTPS_USER_CHOICE, "/v", "ProgId"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const progId = result.status === 0 ? parseWindowsDefaultBrowserProgId(result.stdout ?? "") : null;
  const selection = selectPlaywrightExtensionBrowser(progId, platform);
  recordDiagnostic("playwright.extension.browser_selected", {
    level: selection.source === "forced-edge" ? "info" : "debug",
    details: {
      browser: selection.browser,
      source: selection.source,
      progId: selection.progId,
      registryStatus: result.status,
      registryError: result.error?.message,
    },
  });
  return selection;
}

/** Overlay browser selection only for Playwright extension mode. Explicit user
 *  configuration wins; Reasonix supplies a browser only when none was set. */
export function withPlaywrightExtensionBrowser(spec: McpServerSpec): McpServerSpec {
  if (
    process.platform !== "win32" ||
    spec.transport !== "stdio" ||
    !spec.args.some((arg) => arg.includes("@playwright/mcp")) ||
    !spec.args.includes(PLAYWRIGHT_EXTENSION_ARG) ||
    spec.args.some((arg) => arg === "--browser" || arg.startsWith("--browser=")) ||
    spec.env?.[PLAYWRIGHT_BROWSER_ENV] ||
    process.env[PLAYWRIGHT_BROWSER_ENV]
  ) {
    return spec;
  }
  const selection = resolvePlaywrightExtensionBrowser();
  return {
    ...spec,
    env: { ...(spec.env ?? {}), [PLAYWRIGHT_BROWSER_ENV]: selection.browser },
  };
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
