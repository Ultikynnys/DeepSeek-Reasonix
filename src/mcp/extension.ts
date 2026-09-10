/** Configures Playwright MCP browser connections. The extension comes from the
 *  Chrome Web Store; no bundled copy ships, so the base install stays lightweight. */

import type {
  PlaywrightExtensionBrowser,
  PlaywrightMcpConnectionMode,
} from "@reasonix/core-utils/desktop-protocol";

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

/** Read the `--browser`/`--browser=` value from a Playwright MCP argv, if any. */
function browserArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = arg === "--browser" ? args[index + 1] : arg.match(/^--browser=(.+)$/)?.[1];
    if (value) return value;
  }
  return undefined;
}

/** Parse Reasonix's supported connection modes from a Playwright MCP argv. */
export function parsePlaywrightConnection(args: string[]): {
  mode: PlaywrightMcpConnectionMode;
  cdpEndpoint?: string;
  extensionBrowser?: PlaywrightExtensionBrowser;
} {
  if (args.includes(PLAYWRIGHT_EXTENSION_ARG)) {
    return {
      mode: "extension",
      extensionBrowser: browserArg(args) === "msedge" ? "msedge" : "chrome",
    };
  }
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
  extensionBrowser: PlaywrightExtensionBrowser = "chrome",
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
  if (mode === "extension") {
    // Chrome is @playwright/mcp's extension default; only Edge needs the flag.
    return extensionBrowser === "msedge"
      ? [...result, "--browser=msedge", PLAYWRIGHT_EXTENSION_ARG]
      : [...result, PLAYWRIGHT_EXTENSION_ARG];
  }
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
