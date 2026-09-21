/** Shared browser clients — one Playwright client/browser across tabs, reused on session switch. */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServerSpec } from "../src/mcp/spec.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";

const DEMO_TOOLS: McpTool[] = [
  { name: "navigate", description: "nav", inputSchema: { type: "object", properties: {} } },
  { name: "find", description: "find", inputSchema: { type: "object", properties: {} } },
];

const mocks = vi.hoisted(() => {
  class FakeMcpClient {
    static instances: FakeMcpClient[] = [];
    protocolVersion = "2024-11-05";
    serverInfo = { name: "fake", version: "1.0.0" };
    serverCapabilities = { tools: {} };
    initialized = 0;
    closed = 0;
    constructor() {
      FakeMcpClient.instances.push(this);
    }
    async initialize(): Promise<void> {
      this.initialized += 1;
    }
    async close(): Promise<void> {
      this.closed += 1;
    }
    async listTools(): Promise<{ tools: McpTool[] }> {
      return { tools: DEMO_TOOLS };
    }
    async callTool(name: string): Promise<CallToolResult> {
      return { content: [{ type: "text", text: `ran ${name}` }] };
    }
  }
  class FakeTransport {}
  const readConfigMock = vi.fn((): Record<string, unknown> => ({}));
  const loadEffectiveMcpConfigMock = vi.fn((): unknown => []);
  const inspectMcpServerMock = vi.fn(async () => ({
    protocolVersion: "2024-11-05",
    serverInfo: { name: "fake", version: "1.0.0" },
    capabilities: { tools: {} },
    tools: { supported: true as const, items: [] },
    resources: { supported: false as const, reason: "method not found" },
    prompts: { supported: false as const, reason: "method not found" },
    elapsedMs: 1,
  }));
  return {
    FakeMcpClient,
    FakeTransport,
    readConfigMock,
    loadEffectiveMcpConfigMock,
    inspectMcpServerMock,
  };
});

vi.mock("../src/mcp/client.js", () => ({ McpClient: mocks.FakeMcpClient }));
vi.mock("../src/mcp/stdio.js", () => ({ StdioTransport: mocks.FakeTransport }));
vi.mock("../src/mcp/sse.js", () => ({ SseTransport: mocks.FakeTransport }));
vi.mock("../src/mcp/streamable-http.js", () => ({ StreamableHttpTransport: mocks.FakeTransport }));
vi.mock("../src/mcp/inspect.js", () => ({ inspectMcpServer: mocks.inspectMcpServerMock }));
vi.mock("../src/mcp/playwright-tooling.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/playwright-tooling.js")>();
  return {
    ...actual,
    ensurePlaywrightTooling: () => ({
      ok: true,
      dir: "/tmp/pw",
      driverPath: "/tmp/pw/driver.mjs",
      agentsPath: "/tmp/pw/AGENTS.md",
      created: [],
      upgraded: [],
    }),
  };
});
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadEffectiveMcpConfig: (() =>
      mocks.loadEffectiveMcpConfigMock()) as typeof actual.loadEffectiveMcpConfig,
  };
});

import { createMcpRuntime } from "../src/cli/commands/mcp-runtime.js";
import type { ReasonixConfig } from "../src/config.js";
import { SharedClientRegistry, sharedClientKey } from "../src/mcp/shared-browser.js";
import { ToolRegistry } from "../src/tools.js";

const PW_SPEC: McpServerSpec = {
  transport: "stdio",
  name: "playwright",
  command: "npx",
  args: [
    "-y",
    "@playwright/mcp",
    "--browser=msedge",
    "--user-data-dir=.reasonix/playwright/profiles/msedge",
  ],
};

describe("SharedClientRegistry", () => {
  it("reuses one client for repeated acquires of the same workspace + spec", async () => {
    mocks.FakeMcpClient.instances.length = 0;
    const registry = new SharedClientRegistry();
    const a = await registry.acquire(PW_SPEC, { workspaceDir: "/ws" });
    const b = await registry.acquire(PW_SPEC, { workspaceDir: "/ws" });
    expect(a).toBe(b);
    expect(a.refCount).toBe(2);
    expect(mocks.FakeMcpClient.instances).toHaveLength(1);
    expect(mocks.FakeMcpClient.instances[0]!.initialized).toBe(1);
  });

  it("keeps the client alive until the last holder releases it", async () => {
    const registry = new SharedClientRegistry();
    const a = await registry.acquire(PW_SPEC, { workspaceDir: "/ws" });
    await registry.acquire(PW_SPEC, { workspaceDir: "/ws" });
    const client = mocks.FakeMcpClient.instances.at(-1)!;

    await registry.release(a.key);
    expect(client.closed).toBe(0); // second holder keeps the browser alive

    await registry.release(a.key);
    expect(client.closed).toBe(1); // last holder gone → browser closed
  });

  it("spawns a separate client per workspace and closes all on closeAll", async () => {
    const registry = new SharedClientRegistry();
    mocks.FakeMcpClient.instances.length = 0;
    await registry.acquire(PW_SPEC, { workspaceDir: "/ws-a" });
    await registry.acquire(PW_SPEC, { workspaceDir: "/ws-b" });
    expect(mocks.FakeMcpClient.instances).toHaveLength(2);
    await registry.closeAll();
    expect(mocks.FakeMcpClient.instances.every((c) => c.closed === 1)).toBe(true);
  });
});

describe("sharedClientKey", () => {
  it("is stable per spec+workspace and varies by workspace and env", () => {
    expect(sharedClientKey(PW_SPEC, "/ws")).toBe(sharedClientKey(PW_SPEC, "/ws"));
    expect(sharedClientKey(PW_SPEC, "/ws")).not.toBe(sharedClientKey(PW_SPEC, "/other"));
    const withEnv: McpServerSpec = { ...PW_SPEC, env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: "x" } };
    expect(sharedClientKey(withEnv, "/ws")).not.toBe(sharedClientKey(PW_SPEC, "/ws"));
  });
});

function pwCfg(): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      playwright: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--browser=msedge"],
      },
    },
  };
}

describe("MCP runtime — Playwright browser shared across tabs", () => {
  beforeAll(async () => {
    const configModule = await import("../src/config.js");
    mocks.loadEffectiveMcpConfigMock.mockImplementation(() =>
      configModule.normalizeMcpConfig(mocks.readConfigMock() as ReasonixConfig),
    );
  });
  afterEach(() => {
    mocks.readConfigMock.mockReset();
    mocks.FakeMcpClient.instances.length = 0;
  });

  function buildRuntime(registry: SharedClientRegistry): {
    tools: ToolRegistry;
    runtime: ReturnType<typeof createMcpRuntime>;
  } {
    const tools = new ToolRegistry();
    const runtime = createMcpRuntime({
      getTools: () => tools,
      getMcpPrefix: () => undefined,
      getRequestedCount: () => 1,
      getWorkspaceDir: () => "/ws",
      progressSink: { current: null },
      browserRegistry: registry,
    });
    runtime.setLifecycleSink(() => {});
    return { tools, runtime };
  }

  it("bridges two tabs onto a single shared Playwright client", async () => {
    mocks.readConfigMock.mockReturnValue(pwCfg());
    const registry = new SharedClientRegistry();
    const tabA = buildRuntime(registry);
    const tabB = buildRuntime(registry);

    await tabA.runtime.reloadFromConfig();
    await tabB.runtime.reloadFromConfig();

    expect(mocks.FakeMcpClient.instances).toHaveLength(1);
    const names = (t: ToolRegistry) =>
      t
        .specs()
        .map((s) => s.function.name)
        .sort();
    expect(names(tabA.tools)).toEqual(["playwright_find", "playwright_navigate"]);
    expect(names(tabB.tools)).toEqual(["playwright_find", "playwright_navigate"]);
  });

  it("leaves the shared browser running when one tab closes and stops it with the last", async () => {
    mocks.readConfigMock.mockReturnValue(pwCfg());
    const registry = new SharedClientRegistry();
    const tabA = buildRuntime(registry);
    const tabB = buildRuntime(registry);
    await tabA.runtime.reloadFromConfig();
    await tabB.runtime.reloadFromConfig();
    const client = mocks.FakeMcpClient.instances[0]!;

    await tabA.runtime.closeAll();
    expect(client.closed).toBe(0); // tab B still attaches to the browser

    await tabB.runtime.closeAll();
    expect(client.closed).toBe(1);
  });
});
