/** Bundled Playwright extension — resolver, server-entry merge, status computation. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeMcpExtensionStatus, interpretExtensionCheck } from "../src/cli/commands/desktop.js";
import { type ReasonixConfig, mergeMcpServerEntry, normalizeMcpConfig } from "../src/config.js";
import {
  PLAYWRIGHT_EXTENSION_STORE_URL,
  PLAYWRIGHT_EXTENSION_TOKEN_ENV,
  normalizeExtensionToken,
  parseWindowsDefaultBrowserProgId,
  resolveBundledPlaywrightExtension,
  selectPlaywrightExtensionBrowser,
  stripPlaywrightProfileArgs,
} from "../src/mcp/extension.js";

const ENV_OVERRIDE = "REASONIX_PLAYWRIGHT_EXTENSION_PATH";
const tmpDirs: string[] = [];

function tempDirWith(manifest: boolean, version?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-ext-"));
  tmpDirs.push(dir);
  if (manifest) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "9.9.9" }));
    if (version !== undefined) writeFileSync(join(dir, "_store_version.txt"), version);
  }
  return dir;
}

beforeEach(() => {
  delete process.env[ENV_OVERRIDE];
});

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env[ENV_OVERRIDE];
});

describe("resolveBundledPlaywrightExtension", () => {
  it("reports present with version when the bundled folder has a manifest", () => {
    const dir = tempDirWith(true, "0.1.2");
    process.env[ENV_OVERRIDE] = dir;
    const info = resolveBundledPlaywrightExtension();
    expect(info.present).toBe(true);
    expect(info.path).toBe(dir);
    expect(info.version).toBe("0.1.2");
  });

  it("reports present without version when the stamp file is absent", () => {
    const dir = tempDirWith(true);
    process.env[ENV_OVERRIDE] = dir;
    const info = resolveBundledPlaywrightExtension();
    expect(info.present).toBe(true);
    expect(info.version).toBeNull();
  });

  it("reports absent when the override dir has no manifest.json", () => {
    const dir = tempDirWith(false);
    process.env[ENV_OVERRIDE] = dir;
    const info = resolveBundledPlaywrightExtension();
    expect(info.present).toBe(false);
    expect(info.version).toBeNull();
  });

  it("always exposes the official store URL", () => {
    expect(PLAYWRIGHT_EXTENSION_STORE_URL).toMatch(/^https:\/\/chromewebstore\.google\.com\//);
    expect(PLAYWRIGHT_EXTENSION_STORE_URL).toContain("mmlmfjhmonkocbjadbfplnigmagldckm");
  });
});

describe("mergeMcpServerEntry", () => {
  it("creates the entry when the name exists nowhere in config", () => {
    const cfg: ReasonixConfig = {};
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    expect(cfg.mcpServers?.playwright).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    const spec = normalizeMcpConfig(cfg).find((s) => s.name === "playwright")!;
    expect(spec.transport).toBe("stdio");
  });

  it("migrates a legacy spec-string entry and unions the args", () => {
    const cfg: ReasonixConfig = { mcp: ["playwright=npx -y @playwright/mcp"] };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    expect(cfg.mcp).toBeUndefined();
    expect(cfg.mcpServers?.playwright?.args).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("preserves a user's custom args and appends only the missing ones", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@0.0.80", "--caps"],
        },
      },
    };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    const entry = cfg.mcpServers?.playwright!;
    // User's args keep their order; only --extension is appended.
    expect(entry.args).toEqual(["-y", "@playwright/mcp@0.0.80", "--caps", "--extension"]);
    // Command/url untouched when already present.
    expect(entry.command).toBe("npx");
  });

  it("is idempotent — re-merging the same args adds no duplicates", () => {
    const cfg: ReasonixConfig = {};
    const partial = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    } as const;
    mergeMcpServerEntry(cfg, "playwright", partial);
    mergeMcpServerEntry(cfg, "playwright", partial);
    expect(cfg.mcpServers?.playwright?.args).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("fills missing env keys per-key and never clobbers stored ones", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          env: { [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "stored-token" },
        },
      },
    };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["--extension"],
      env: { OTHER_VAR: "x" },
    });
    expect(cfg.mcpServers?.playwright?.env).toEqual({
      [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "stored-token",
      OTHER_VAR: "x",
    });
  });
});

describe("Playwright extension browser selection", () => {
  it("parses the current HTTPS ProgId from reg.exe output", () => {
    expect(
      parseWindowsDefaultBrowserProgId(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice
    ProgId    REG_SZ    ChromeHTML
`),
    ).toBe("ChromeHTML");
  });

  it("keeps Chrome when Chrome is the Windows default", () => {
    expect(selectPlaywrightExtensionBrowser("ChromeHTML", "win32")).toEqual({
      browser: "chrome",
      source: "default-chrome",
      progId: "ChromeHTML",
    });
    expect(selectPlaywrightExtensionBrowser("ChromeHTML.ABC123", "win32").browser).toBe("chrome");
  });

  it("keeps Edge when Edge is the Windows default", () => {
    expect(selectPlaywrightExtensionBrowser("MSEdgeHTM", "win32")).toEqual({
      browser: "msedge",
      source: "default-edge",
      progId: "MSEdgeHTM",
    });
  });

  it("forces Edge for a known non-Chromium Windows default", () => {
    expect(selectPlaywrightExtensionBrowser("FirefoxURL-308046B0AF4A39CB", "win32")).toEqual({
      browser: "msedge",
      source: "forced-edge",
      progId: "FirefoxURL-308046B0AF4A39CB",
    });
  });

  it("forces Edge when the Windows association could not be read", () => {
    expect(selectPlaywrightExtensionBrowser(null, "win32")).toEqual({
      browser: "msedge",
      source: "forced-edge",
      progId: null,
    });
  });

  it("leaves upstream Chrome selection unchanged outside Windows", () => {
    expect(selectPlaywrightExtensionBrowser(null, "darwin")).toEqual({
      browser: "chrome",
      source: "non-windows",
      progId: null,
    });
  });
});

describe("stripPlaywrightProfileArgs", () => {
  it("removes both profile argument forms without changing other arguments", () => {
    expect(
      stripPlaywrightProfileArgs([
        "-y",
        "@playwright/mcp",
        "--profile-dir-name=Profile 1",
        "--extension",
      ]),
    ).toEqual(["-y", "@playwright/mcp", "--extension"]);
    expect(
      stripPlaywrightProfileArgs([
        "-y",
        "@playwright/mcp",
        "--profile-dir-name",
        "Profile 2",
        "--extension",
      ]),
    ).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });
});

describe("normalizeExtensionToken", () => {
  it("accepts a bare token unchanged", () => {
    expect(normalizeExtensionToken("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE")).toBe(
      "K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
    );
  });

  it("strips the KEY= prefix that the connection dialog's copy button produces", () => {
    expect(
      normalizeExtensionToken(
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN=K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
      ),
    ).toBe("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
    expect(
      normalizeExtensionToken(
        "playwright_mcp_extension_token=K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
      ),
    ).toBe("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
  });

  it("trims whitespace and strips wrapping quotes", () => {
    expect(normalizeExtensionToken('  "K3MM1pBelgctJOQe2"  ')).toBe("K3MM1pBelgctJOQe2");
    expect(normalizeExtensionToken("  'K3MM1pBelgctJOQe2'\n")).toBe("K3MM1pBelgctJOQe2");
  });

  it("leaves a token that merely contains the key name elsewhere untouched", () => {
    expect(normalizeExtensionToken("xPLAYWRIGHT_MCP_EXTENSION_TOKEN=y")).toBe(
      "xPLAYWRIGHT_MCP_EXTENSION_TOKEN=y",
    );
  });
});

describe("computeMcpExtensionStatus", () => {
  const bundled = {
    present: true,
    path: "C:\\install\\assets\\playwright-extension",
    version: "1.2.3",
  };
  const bundledAbsent = { present: false, path: null, version: null };

  it("reads configured state and the extension flag from the entry", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp", "--extension", "--profile-dir-name=Profile 1"],
        },
      },
    };
    const status = computeMcpExtensionStatus(cfg, bundled);
    expect(status.storeUrl).toBe(PLAYWRIGHT_EXTENSION_STORE_URL);
    expect(status.bundled).toEqual(bundled);
    expect(status.server).toEqual({
      configured: true,
      hasExtensionArg: true,
      tokenPrefix: undefined,
      args: ["-y", "@playwright/mcp", "--extension", "--profile-dir-name=Profile 1"],
    });
  });

  it("reports a redacted relay token identifier without exposing the full token", () => {
    const withToken: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp", "--extension"],
          env: { [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE" },
        },
      },
    };
    const server = computeMcpExtensionStatus(withToken, bundled).server;
    expect(server.tokenPrefix).toBe("K3MM1p…6VE");
    expect(JSON.stringify(server)).not.toContain("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
    expect(computeMcpExtensionStatus({}, bundledAbsent).server.tokenPrefix).toBeUndefined();
  });

  it("reports unconfigured servers and absent bundles", () => {
    const status = computeMcpExtensionStatus({}, bundledAbsent);
    expect(status.server.configured).toBe(false);
    expect(status.server.hasExtensionArg).toBe(false);
    expect(status.bundled.present).toBe(false);
  });

  it("flags an entry that lacks the --extension arg", () => {
    const cfg: ReasonixConfig = {
      mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
    };
    const status = computeMcpExtensionStatus(cfg, bundled);
    expect(status.server.configured).toBe(true);
    expect(status.server.hasExtensionArg).toBe(false);
  });
});

describe("interpretExtensionCheck", () => {
  it("passes a successful tabs listing through as ok", () => {
    const raw = JSON.stringify({ tabs: [{ id: "t1", url: "https://example.com" }] });
    expect(interpretExtensionCheck(raw, 1200)).toEqual({ ok: true, reason: null, elapsedMs: 1200 });
  });

  it("maps a timeout to the wrong-token-or-no-Edge guidance", () => {
    const raw = JSON.stringify({
      error: "browser_tabs: This operation was aborted due to timeout",
    });
    const result = interpretExtensionCheck(raw, 25000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no browser responded within 25s");
    expect(result.reason).toContain("token is likely wrong");
  });

  it("maps an unregistered tool to the not-bridged guidance", () => {
    const raw = JSON.stringify({ error: "unknown tool: playwright_browser_tabs" });
    const result = interpretExtensionCheck(raw, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not bridged");
  });

  it("surfaces plain tool-side error text (### Error) verbatim", () => {
    const result = interpretExtensionCheck("### Error\nExtension not found", 900);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("### Error");
  });

  it("treats an empty probe result as a failure", () => {
    expect(interpretExtensionCheck(null, 0).ok).toBe(false);
    expect(interpretExtensionCheck("   ", 0).ok).toBe(false);
  });
});
