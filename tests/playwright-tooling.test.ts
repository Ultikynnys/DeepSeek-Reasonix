// Hardcoded playwright tooling contract — bootstrap semantics + bridge injection.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import {
  _resetForTests,
  ensurePlaywrightTooling,
  isPlaywrightExtensionSpec,
  playwrightDescriptionSuffix,
  playwrightToolingNotice,
  resolvePlaywrightTemplatePath,
} from "../src/mcp/playwright-tooling.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import type { McpServerSpec } from "../src/mcp/spec.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import type { JsonRpcMessage, JsonRpcRequest, McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

function stdioSpec(command: string, args: string[]): McpServerSpec {
  return { transport: "stdio", name: "playwright", command, args };
}

function tmpHome(): string {
  const dir = join(tmpdir(), `reasonix-pwtooling-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  _resetForTests();
});

describe("isPlaywrightExtensionSpec", () => {
  it("matches @playwright/mcp with --extension", () => {
    expect(
      isPlaywrightExtensionSpec({
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--extension", "--browser", "msedge"],
      }),
    ).toBe(true);
  });

  it("rejects @playwright/mcp without --extension", () => {
    expect(
      isPlaywrightExtensionSpec({
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
      }),
    ).toBe(false);
  });

  it("rejects other stdio servers and non-stdio transports", () => {
    expect(
      isPlaywrightExtensionSpec({
        transport: "stdio",
        name: "fs",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      }),
    ).toBe(false);
    expect(
      isPlaywrightExtensionSpec({ transport: "sse", name: "x", url: "https://example.com/sse" }),
    ).toBe(false);
  });
});

describe("ensurePlaywrightTooling", () => {
  it("resolves the bundled templates from the repo data dir", () => {
    const driver = resolvePlaywrightTemplatePath("driver.mjs");
    const agents = resolvePlaywrightTemplatePath("AGENTS.md");
    expect(existsSync(driver)).toBe(true);
    expect(existsSync(agents)).toBe(true);
    expect(readFileSync(driver, "utf8")).toMatch(/playwright-tooling-version: 1/);
    expect(readFileSync(agents, "utf8")).toMatch(/platform:begin/);
  });

  it("bootstraps both files into the global tooling dir on first call", () => {
    const home = tmpHome();
    cleanups.push(home);
    const status = ensurePlaywrightTooling({ homeDir: home });
    if (!status.ok) throw new Error(status.error);
    expect(status.created.sort()).toEqual(["AGENTS.md", "driver.mjs"]);
    expect(existsSync(status.driverPath)).toBe(true);
    expect(existsSync(status.agentsPath)).toBe(true);
  });

  it("is idempotent — a second run neither re-creates nor upgrades", () => {
    const home = tmpHome();
    cleanups.push(home);
    ensurePlaywrightTooling({ homeDir: home });
    const second = ensurePlaywrightTooling({ homeDir: home });
    if (!second.ok) throw new Error(second.error);
    expect(second.created).toEqual([]);
    expect(second.upgraded).toEqual([]);
  });

  it("never clobbers an agent-owned AGENTS.md without platform markers", () => {
    const home = tmpHome();
    cleanups.push(home);
    const agentsPath = join(home, ".reasonix", "tools", "playwright", "AGENTS.md");
    mkdirSync(join(home, ".reasonix", "tools", "playwright"), { recursive: true });
    writeFileSync(agentsPath, "# my own notes\nkeep them\n");
    const status = ensurePlaywrightTooling({ homeDir: home });
    if (!status.ok) throw new Error(status.error);
    expect(status.upgraded).toEqual(["AGENTS.md.platform-latest.md"]);
    expect(readFileSync(agentsPath, "utf8")).toBe("# my own notes\nkeep them\n");
    expect(
      existsSync(join(home, ".reasonix", "tools", "playwright", "AGENTS.md.platform-latest.md")),
    ).toBe(true);
  });

  it("overwrites a stale driver and refreshes the platform section of a marked AGENTS.md", () => {
    const home = tmpHome();
    cleanups.push(home);
    const dir = join(home, ".reasonix", "tools", "playwright");
    mkdirSync(dir, { recursive: true });
    const bundledDriver = readFileSync(resolvePlaywrightTemplatePath("driver.mjs"), "utf8");
    const bundledAgents = readFileSync(resolvePlaywrightTemplatePath("AGENTS.md"), "utf8");
    writeFileSync(
      join(dir, "driver.mjs"),
      bundledDriver.replace("playwright-tooling-version: 1", "playwright-tooling-version: 0"),
    );
    const agentsOld = bundledAgents.replace(
      "playwright-tooling-version: 1",
      "playwright-tooling-version: 0",
    );
    writeFileSync(join(dir, "AGENTS.md"), `${agentsOld}\n\n## Agent notes\nmy finding\n`);
    const status = ensurePlaywrightTooling({ homeDir: home });
    if (!status.ok) throw new Error(status.error);
    expect(status.upgraded).toEqual(["driver.mjs", "AGENTS.md"]);
    // Driver is overwritten with the current version; agent notes are preserved.
    expect(readFileSync(join(dir, "driver.mjs"), "utf8")).toBe(bundledDriver);
    const refreshed = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(refreshed).toMatch(/playwright-tooling-version: 1/);
    expect(refreshed).toContain("my finding");
  });

  it("defaults to ~/.reasonix/tools/playwright when no override is given", () => {
    // The user's machine already has the pair from the manual rollout — the
    // default-path call must resolve to the same location without rewriting.
    const status = ensurePlaywrightTooling();
    if (!status.ok) throw new Error(status.error);
    expect(status.dir).toBe(join(homedir(), ".reasonix", "tools", "playwright"));
    expect(existsSync(status.driverPath)).toBe(true);
  });
});

/** In-process MCP transport — mirrors the FakeMcpTransport pattern from
 *  mcp.test.ts, trimmed to initialize / tools/list / tools/call. */
class FakeMcpTransport implements McpTransport {
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private closed = false;

  constructor(
    private readonly tools: McpTool[],
    private readonly callText = (name: string) => `ran ${name}`,
  ) {}

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("fake transport closed");
    if (!("method" in msg)) return;
    if (!("id" in msg)) return;
    const req = msg as JsonRpcRequest;
    switch (req.method) {
      case "initialize":
        this.push({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "fake-mcp", version: "0.0.0" },
            capabilities: { tools: {} },
          },
        });
        return;
      case "tools/list":
        this.push({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: `desc for ${t.name}`,
              inputSchema: { type: "object" },
            })),
          },
        });
        return;
      case "tools/call": {
        const params = req.params as { name: string };
        this.push({
          jsonrpc: "2.0",
          id: req.id,
          result: { content: [{ type: "text" as const, text: this.callText(params.name) }] },
        });
        return;
      }
      default:
        this.push({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        });
    }
  }

  async *messages(): AsyncIterableIterator<JsonRpcMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      yield await new Promise<JsonRpcMessage | null>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  private push(msg: JsonRpcMessage): void {
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
  }
}

describe("bridge tooling-notice + description-suffix injection", () => {
  const NOTICE = playwrightToolingNotice({
    ok: true,
    dir: "~/.reasonix/tools/playwright",
    driverPath: "~/.reasonix/tools/playwright/driver.mjs",
    agentsPath: "~/.reasonix/tools/playwright/AGENTS.md",
    created: [],
    upgraded: [],
  });

  it("appends the tooling notice to the FIRST tool result only", async () => {
    const client = new McpClient({
      transport: new FakeMcpTransport([{ name: "browser_tabs" }, { name: "browser_click" }]),
    });
    await client.initialize();
    const { registry } = await bridgeMcpTools(client, {
      namePrefix: "playwright_",
      toolingNotice: NOTICE,
      descriptionSuffix: playwrightDescriptionSuffix({
        ok: true,
        dir: "~/.reasonix/tools/playwright",
        driverPath: "~/.reasonix/tools/playwright/driver.mjs",
        agentsPath: "~/.reasonix/tools/playwright/AGENTS.md",
        created: [],
        upgraded: [],
      }),
    });

    const first = await registry.dispatch("playwright_browser_tabs", "{}");
    expect(first).toContain("ran browser_tabs");
    expect(first).toContain("playwright tooling");
    expect(first).toContain("keep AGENTS.md in that folder updated");

    const second = await registry.dispatch("playwright_browser_click", "{}");
    expect(second).toBe("ran browser_click");
    expect(second).not.toContain("playwright tooling");
    await client.close();
  });

  it("appends the description suffix to every bridged tool description", async () => {
    const client = new McpClient({
      transport: new FakeMcpTransport([{ name: "browser_tabs" }, { name: "browser_click" }]),
    });
    await client.initialize();
    const { registry } = await bridgeMcpTools(client, {
      namePrefix: "playwright_",
      descriptionSuffix: playwrightDescriptionSuffix({
        ok: true,
        dir: "~/.reasonix/tools/playwright",
        driverPath: "~/.reasonix/tools/playwright/driver.mjs",
        agentsPath: "~/.reasonix/tools/playwright/AGENTS.md",
        created: [],
        upgraded: [],
      }),
    });
    const specs = registry.specs();
    for (const spec of specs) {
      expect(spec.function.description).toContain("Tooling: ~/.reasonix/tools/playwright");
    }
    await client.close();
  });

  it("injects nothing when no notice is configured", async () => {
    const client = new McpClient({
      transport: new FakeMcpTransport([{ name: "browser_tabs" }]),
    });
    await client.initialize();
    const { registry } = await bridgeMcpTools(client, { namePrefix: "playwright_" });
    const out = await registry.dispatch("playwright_browser_tabs", "{}");
    expect(out).toBe("ran browser_tabs");
    const spec = registry.specs().find((s) => s.function.name === "playwright_browser_tabs");
    expect(spec?.function.description).not.toContain("Tooling:");
    await client.close();
  });
});
