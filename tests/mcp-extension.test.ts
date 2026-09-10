/** Playwright MCP extension — store URL, server-entry merge, status computation. */

import { describe, expect, it } from "vitest";
import { computeMcpExtensionStatus, interpretExtensionCheck } from "../src/cli/commands/desktop.js";
import { type ReasonixConfig, mergeMcpServerEntry, normalizeMcpConfig } from "../src/config.js";
import {
  PLAYWRIGHT_EXTENSION_STORE_URL,
  PLAYWRIGHT_EXTENSION_TOKEN_ENV,
  configurePlaywrightArgs,
  normalizeExtensionToken,
  parsePlaywrightConnection,
  playwrightBrowserInstallArgs,
} from "../src/mcp/extension.js";

describe("Playwright extension store", () => {
  it("always points at the official Chrome Web Store listing", () => {
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

describe("playwrightBrowserInstallArgs", () => {
  it.each(["chrome", "firefox", "webkit", "msedge"] as const)(
    "builds the official managed-browser installer for %s",
    (browser) => {
      expect(playwrightBrowserInstallArgs(browser)).toEqual([
        "-y",
        "@playwright/mcp",
        "install-browser",
        browser,
      ]);
    },
  );

  it("preserves a safe pinned package and rejects non-managed values", () => {
    expect(playwrightBrowserInstallArgs("firefox", "@playwright/mcp@0.0.80")).toEqual([
      "-y",
      "@playwright/mcp@0.0.80",
      "install-browser",
      "firefox",
    ]);
    expect(() => playwrightBrowserInstallArgs("extension")).toThrow(/unsupported/);
    expect(() => playwrightBrowserInstallArgs("firefox && calc")).toThrow(/unsupported/);
  });
});

describe("Playwright connection configuration", () => {
  it.each(["chrome", "firefox", "webkit", "msedge"] as const)(
    "configures and parses managed %s mode",
    (mode) => {
      const args = configurePlaywrightArgs(["-y", "@playwright/mcp@0.0.80", "--caps=vision"], mode);
      expect(args).toEqual(["-y", "@playwright/mcp@0.0.80", "--caps=vision", `--browser=${mode}`]);
      expect(parsePlaywrightConnection(args)).toEqual({ mode });
    },
  );

  it("switches conflicting connection modes without losing unrelated arguments", () => {
    expect(
      configurePlaywrightArgs(
        [
          "-y",
          "@playwright/mcp@0.0.80",
          "--browser",
          "firefox",
          "--extension",
          "--cdp-endpoint=http://localhost:9222",
          "--profile-dir-name=Profile 1",
          "--caps=vision",
        ],
        "msedge",
      ),
    ).toEqual(["-y", "@playwright/mcp@0.0.80", "--caps=vision", "--browser=msedge"]);
  });

  it("configures extension mode without pinning a browser or profile", () => {
    expect(
      configurePlaywrightArgs(
        ["-y", "@playwright/mcp", "--browser=chrome", "--profile-dir-name", "Profile 2"],
        "extension",
      ),
    ).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("configures Chromium CDP and validates its endpoint", () => {
    const args = configurePlaywrightArgs(
      ["-y", "@playwright/mcp", "--browser=webkit"],
      "cdp",
      "http://localhost:9222",
    );
    expect(args).toEqual(["-y", "@playwright/mcp", "--cdp-endpoint=http://localhost:9222"]);
    expect(parsePlaywrightConnection(args)).toEqual({
      mode: "cdp",
      cdpEndpoint: "http://localhost:9222",
    });
    expect(() => configurePlaywrightArgs(args, "cdp", "")).toThrow(/endpoint is required/);
    expect(() => configurePlaywrightArgs(args, "cdp", "localhost:9222")).toThrow(/must use/);
  });

  it("treats an unqualified Playwright server as managed Chrome", () => {
    expect(parsePlaywrightConnection(["-y", "@playwright/mcp"])).toEqual({ mode: "chrome" });
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
    const status = computeMcpExtensionStatus(cfg);
    expect(status.storeUrl).toBe(PLAYWRIGHT_EXTENSION_STORE_URL);
    expect(status.server).toEqual({
      configured: true,
      mode: "extension",
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
    const server = computeMcpExtensionStatus(withToken).server;
    expect(server.tokenPrefix).toBe("K3MM1p…6VE");
    expect(JSON.stringify(server)).not.toContain("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
    expect(computeMcpExtensionStatus({}).server.tokenPrefix).toBeUndefined();
  });

  it("reports unconfigured servers", () => {
    const status = computeMcpExtensionStatus({});
    expect(status.server.configured).toBe(false);
    expect(status.server.mode).toBe("chrome");
    expect(status.server.hasExtensionArg).toBe(false);
  });

  it("reports managed and CDP connection modes", () => {
    const managed: ReasonixConfig = {
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp", "--browser=firefox"] },
      },
    };
    expect(computeMcpExtensionStatus(managed).server.mode).toBe("firefox");

    const cdp: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp", "--cdp-endpoint=http://localhost:9222"],
        },
      },
    };
    expect(computeMcpExtensionStatus(cdp).server).toMatchObject({
      configured: true,
      mode: "cdp",
      cdpEndpoint: "http://localhost:9222",
      hasExtensionArg: false,
    });
  });
});

describe("interpretExtensionCheck", () => {
  it("passes a successful tabs listing through as ok", () => {
    const raw = JSON.stringify({ tabs: [{ id: "t1", url: "https://example.com" }] });
    expect(interpretExtensionCheck(raw, 1200)).toEqual({ ok: true, reason: null, elapsedMs: 1200 });
  });

  it("maps a timeout to the wrong-token-or-no-supported-browser guidance", () => {
    const raw = JSON.stringify({
      error: "browser_tabs: This operation was aborted due to timeout",
    });
    const result = interpretExtensionCheck(raw, 25000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no browser responded within 25s");
    expect(result.reason).toContain("token is likely wrong");
    expect(result.reason).toContain("Chrome or Edge");
  });

  it("maps an unregistered tool to the not-bridged guidance", () => {
    const raw = JSON.stringify({ error: "unknown tool: playwright_browser_tabs" });
    const result = interpretExtensionCheck(raw, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not bridged");
  });

  it("surfaces the detail line of a tool-side error (### Error)", () => {
    const result = interpretExtensionCheck("### Error\nExtension not found", 900);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Extension not found");
  });

  it("surfaces an inline Error: message without the prefix", () => {
    const result = interpretExtensionCheck("Error: relay not connected", 900);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("relay not connected");
  });

  it("treats an empty probe result as a failure", () => {
    expect(interpretExtensionCheck(null, 0).ok).toBe(false);
    expect(interpretExtensionCheck("   ", 0).ok).toBe(false);
  });
});
