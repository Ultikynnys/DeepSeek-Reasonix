/** Bundled Playwright extension — resolver, server-entry merge, status computation. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeMcpExtensionStatus } from "../src/cli/commands/desktop.js";
import { type ReasonixConfig, mergeMcpServerEntry, normalizeMcpConfig } from "../src/config.js";
import {
  PLAYWRIGHT_EXTENSION_STORE_URL,
  PLAYWRIGHT_EXTENSION_TOKEN_ENV,
  resolveBundledPlaywrightExtension,
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

describe("computeMcpExtensionStatus", () => {
  const bundled = {
    present: true,
    path: "C:\\install\\assets\\playwright-extension",
    version: "1.2.3",
  };
  const bundledAbsent = { present: false, path: null, version: null };

  it("reads configured state, extension flag, and profile from the entry", () => {
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
      profileDirName: "Profile 1",
      hasToken: false,
      args: ["-y", "@playwright/mcp", "--extension", "--profile-dir-name=Profile 1"],
    });
  });

  it("reports whether a relay token is stored in the entry's env", () => {
    const withToken: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp", "--extension"],
          env: { [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "secret" },
        },
      },
    };
    expect(computeMcpExtensionStatus(withToken, bundled).server.hasToken).toBe(true);
    expect(computeMcpExtensionStatus({}, bundledAbsent).server.hasToken).toBe(false);
  });

  it("reports unconfigured servers and absent bundles", () => {
    const status = computeMcpExtensionStatus({}, bundledAbsent);
    expect(status.server.configured).toBe(false);
    expect(status.server.hasExtensionArg).toBe(false);
    expect(status.server.profileDirName).toBeNull();
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
