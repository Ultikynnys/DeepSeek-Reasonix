/** Locates the Playwright MCP Chrome extension bundled at packaging time. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Official Chrome Web Store listing — "Playwright Extension" (Microsoft, Apache-2.0). */
export const PLAYWRIGHT_EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

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
