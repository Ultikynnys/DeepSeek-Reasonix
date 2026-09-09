/** Per-server + per-tool MCP toggles — config helpers, bridge filter, runtime hot-apply. */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpRuntime } from "../src/cli/commands/mcp-runtime.js";
import {
  type ReasonixConfig,
  ensureMcpServersEntry,
  normalizeMcpConfig,
  setMcpServerDisabled,
  setMcpToolDisabled,
} from "../src/config.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { overlayMatchedSpec, parseMcpSpec, specToRaw } from "../src/mcp/spec.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

const DEMO_TOOLS: McpTool[] = [
  { name: "a", description: "tool a", inputSchema: { type: "object", properties: {} } },
  { name: "b", description: "tool b", inputSchema: { type: "object", properties: {} } },
];

describe("ensureMcpServersEntry — legacy migration", () => {
  it("migrates a legacy spec string + mcpEnv overlay into mcpServers", () => {
    const cfg: ReasonixConfig = {
      mcp: ["demo=npx -y demo-pkg --flag"],
      mcpEnv: { demo: { FOO: "bar" } },
    };
    ensureMcpServersEntry(cfg, "demo");
    expect(cfg.mcp).toBeUndefined();
    expect(cfg.mcpEnv).toBeUndefined();
    expect(cfg.mcpServers?.demo).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "demo-pkg", "--flag"],
      env: { FOO: "bar" },
    });
    // The migrated entry must normalize back to the SAME raw spec so a live
    // bridge record keeps matching in reloadFromConfig.
    const spec = normalizeMcpConfig(cfg).find((s) => s.name === "demo")!;
    expect(specToRaw(spec)).toBe("demo=npx -y demo-pkg --flag");
  });

  it("keeps an existing mcpServers entry untouched", () => {
    const cfg: ReasonixConfig = {
      mcp: ["demo=node old.js"],
      mcpServers: { demo: { command: "node", args: ["new.js"] } },
    };
    ensureMcpServersEntry(cfg, "demo");
    expect(cfg.mcpServers?.demo).toEqual({ command: "node", args: ["new.js"] });
    expect(cfg.mcp).toEqual(["demo=node old.js"]);
  });

  it("leaves names absent from config alone (toggles must target configured servers)", () => {
    const cfg: ReasonixConfig = {};
    ensureMcpServersEntry(cfg, "ghost");
    expect(cfg.mcpServers).toBeUndefined();
    expect(setMcpServerDisabled(cfg, "ghost", true)).toBe(false);
  });

  it("migrates an sse legacy spec preserving its url", () => {
    const cfg: ReasonixConfig = { mcp: ["remote=https://example.com/sse"] };
    ensureMcpServersEntry(cfg, "remote");
    expect(cfg.mcpServers?.remote).toEqual({
      transport: "sse",
      url: "https://example.com/sse",
    });
  });
});

describe("setMcpServerDisabled / setMcpToolDisabled", () => {
  it("toggles a server disabled on and off", () => {
    const cfg: ReasonixConfig = { mcp: ["demo=npx -y demo-pkg"] };
    expect(setMcpServerDisabled(cfg, "demo", true)).toBe(true);
    expect(cfg.mcpServers?.demo?.disabled).toBe(true);
    expect(cfg.mcp).toBeUndefined(); // migrated on first toggle

    const spec = normalizeMcpConfig(cfg).find((s) => s.name === "demo")!;
    expect(spec.disabled).toBe(true);

    expect(setMcpServerDisabled(cfg, "demo", false)).toBe(true);
    expect(cfg.mcpServers?.demo?.disabled).toBeUndefined();
  });

  it("returns false for names absent from config", () => {
    const cfg: ReasonixConfig = {};
    expect(setMcpServerDisabled(cfg, "nope", true)).toBe(false);
  });

  it("toggles tools: adds sorted, removes, deletes the key when empty", () => {
    const cfg: ReasonixConfig = { mcpServers: { demo: { command: "npx", args: ["-y", "demo"] } } };
    expect(setMcpToolDisabled(cfg, "demo", "b", true)).toBe(true);
    expect(setMcpToolDisabled(cfg, "demo", "a", true)).toBe(true);
    expect(cfg.mcpServers?.demo?.disabledTools).toEqual(["a", "b"]);

    expect(setMcpToolDisabled(cfg, "demo", "a", false)).toBe(true);
    expect(cfg.mcpServers?.demo?.disabledTools).toEqual(["b"]);

    expect(setMcpToolDisabled(cfg, "demo", "b", false)).toBe(true);
    expect(cfg.mcpServers?.demo?.disabledTools).toBeUndefined();
  });

  it("migrates a legacy entry when toggling a tool", () => {
    const cfg: ReasonixConfig = { mcp: ["demo=npx -y demo-pkg"] };
    expect(setMcpToolDisabled(cfg, "demo", "b", true)).toBe(true);
    expect(cfg.mcp).toBeUndefined();
    expect(cfg.mcpServers?.demo?.disabledTools).toEqual(["b"]);
  });
});

describe("overlayMatchedSpec — disabledTools carry-over", () => {
  it("carries disabledTools from the matched config spec", () => {
    const parsed = parseMcpSpec("demo=npx -y demo-pkg");
    const matched = normalizeMcpConfig({
      mcpServers: { demo: { command: "npx", args: ["-y", "demo-pkg"], disabledTools: ["b"] } },
    })[0]!;
    const spec = overlayMatchedSpec(parsed, matched);
    expect(spec.disabledTools).toEqual(["b"]);
  });

  it("adds no disabledTools key when there is no match", () => {
    const parsed = parseMcpSpec("demo=npx -y demo-pkg");
    const spec = overlayMatchedSpec(parsed, undefined);
    expect("disabledTools" in spec).toBe(false);
  });
});

describe("bridgeMcpTools — disabledTools filter", () => {
  function makeFakeClient(): Parameters<typeof bridgeMcpTools>[0] {
    const fake = {
      listTools: async () => ({ tools: DEMO_TOOLS }),
      callTool: async (name: string): Promise<CallToolResult> => ({
        content: [{ type: "text", text: `ran ${name}` }],
      }),
    };
    return fake as unknown as Parameters<typeof bridgeMcpTools>[0];
  }

  function specNames(registry: ToolRegistry): string[] {
    return registry
      .specs()
      .map((s) => s.function.name)
      .sort();
  }

  it("skips tools named in disabledTools and records the reason", async () => {
    const { registry, registeredNames, skipped } = await bridgeMcpTools(makeFakeClient(), {
      namePrefix: "demo_",
      disabledTools: new Set(["b"]),
    });
    expect(registeredNames.sort()).toEqual(["demo_a"]);
    expect(skipped).toEqual([{ name: "b", reason: "disabled by user" }]);
    expect(specNames(registry)).toEqual(["demo_a"]);
  });

  it("registers everything when no disable list is given", async () => {
    const { registeredNames } = await bridgeMcpTools(makeFakeClient(), { namePrefix: "demo_" });
    expect(registeredNames.sort()).toEqual(["demo_a", "demo_b"]);
  });
});

/** Runtime-level tests — fake client + REAL registry bridge, config swapped via loadEffectiveMcpConfig mock. */
const mocks = vi.hoisted(() => {
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
  class FakeMcpClient {
    protocolVersion = "2024-11-05";
    serverInfo = { name: "fake", version: "1.0.0" };
    serverCapabilities = { tools: {} };
    closed = 0;
    async initialize(): Promise<void> {}
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
  return {
    readConfigMock,
    loadEffectiveMcpConfigMock,
    inspectMcpServerMock,
    FakeMcpClient,
    FakeTransport,
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
vi.mock("../src/mcp/client.js", () => ({ McpClient: mocks.FakeMcpClient }));
vi.mock("../src/mcp/inspect.js", () => ({ inspectMcpServer: mocks.inspectMcpServerMock }));
vi.mock("../src/mcp/stdio.js", () => ({ StdioTransport: mocks.FakeTransport }));
vi.mock("../src/mcp/sse.js", () => ({ SseTransport: mocks.FakeTransport }));
vi.mock("../src/mcp/streamable-http.js", () => ({ StreamableHttpTransport: mocks.FakeTransport }));

function demoCfg(overrides: { disabled?: boolean; disabledTools?: string[] } = {}): {
  mcpServers: Record<string, unknown>;
} {
  const server: Record<string, unknown> = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "demo-pkg"],
  };
  if (overrides.disabled !== undefined) server.disabled = overrides.disabled;
  if (overrides.disabledTools) server.disabledTools = overrides.disabledTools;
  return { mcpServers: { demo: server } };
}

function specNames(tools: ToolRegistry): string[] {
  return tools
    .specs()
    .map((s) => s.function.name)
    .sort();
}

describe("MCP runtime — server & per-tool toggle application", () => {
  beforeAll(async () => {
    // The runtime calls loadEffectiveMcpConfig, which reads the module-internal
    // readConfig — unmockable from outside. So the mock normalizes the fake
    // config object through the REAL normalizeMcpConfig (re-exported unchanged
    // by the partial mock) instead.
    const configModule = await import("../src/config.js");
    mocks.loadEffectiveMcpConfigMock.mockImplementation(() =>
      configModule.normalizeMcpConfig(mocks.readConfigMock() as ReasonixConfig),
    );
  });
  afterEach(() => {
    mocks.readConfigMock.mockReset();
    mocks.inspectMcpServerMock.mockClear();
  });

  function buildRuntime(): { tools: ToolRegistry; runtime: ReturnType<typeof createMcpRuntime> } {
    const tools = new ToolRegistry();
    const runtime = createMcpRuntime({
      getTools: () => tools,
      getMcpPrefix: () => undefined,
      getRequestedCount: () => 1,
      progressSink: { current: null },
    });
    runtime.setLifecycleSink(() => {});
    return { tools, runtime };
  }

  it("bridges with disabledTools filtered out on the first bridge", async () => {
    mocks.readConfigMock.mockReturnValue(demoCfg({ disabledTools: ["b"] }));
    const { tools, runtime } = buildRuntime();
    const result = await runtime.reloadFromConfig();
    expect(result.failed).toEqual([]);
    expect(result.added).toHaveLength(1);
    expect(specNames(tools)).toEqual(["demo_a"]);
    expect(runtime.toolFilterState()).toEqual([
      { spec: "demo=npx -y demo-pkg", enabled: ["a"], disabled: ["b"] },
    ]);
    expect(runtime.summaries()[0]!.toolCount).toBe(1);
  });

  it("hot-re-enables a tool on config change without respawning the server", async () => {
    mocks.readConfigMock.mockReturnValue(demoCfg({ disabledTools: ["b"] }));
    const { tools, runtime } = buildRuntime();
    await runtime.reloadFromConfig();

    mocks.readConfigMock.mockReturnValue(demoCfg());
    const result = await runtime.reloadFromConfig();
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(specNames(tools)).toEqual(["demo_a", "demo_b"]);
    const state = runtime.toolFilterState()[0]!;
    expect(state.enabled.sort()).toEqual(["a", "b"]);
    expect(state.disabled).toEqual([]);
  });

  it("hot-disables a bridged tool on config change", async () => {
    mocks.readConfigMock.mockReturnValue(demoCfg());
    const { tools, runtime } = buildRuntime();
    await runtime.reloadFromConfig();
    expect(specNames(tools)).toEqual(["demo_a", "demo_b"]);

    mocks.readConfigMock.mockReturnValue(demoCfg({ disabledTools: ["a"] }));
    await runtime.reloadFromConfig();
    expect(specNames(tools)).toEqual(["demo_b"]);
    expect(runtime.toolFilterState()[0]!.disabled).toEqual(["a"]);
  });

  it("stops a live server when config disables it, then restores it on re-enable", async () => {
    mocks.readConfigMock.mockReturnValue(demoCfg());
    const { tools, runtime } = buildRuntime();
    await runtime.reloadFromConfig();
    expect(runtime.size()).toBe(1);

    mocks.readConfigMock.mockReturnValue(demoCfg({ disabled: true }));
    await runtime.reloadFromConfig();
    expect(runtime.size()).toBe(0);
    expect(specNames(tools)).toEqual([]);
    expect(runtime.failures().map((f) => f.reason)).toEqual(["disabled by user"]);

    mocks.readConfigMock.mockReturnValue(demoCfg());
    const restored = await runtime.reloadFromConfig();
    expect(restored.added).toHaveLength(1);
    expect(specNames(tools)).toEqual(["demo_a", "demo_b"]);
    expect(runtime.failures()).toEqual([]);
  });

  it("re-bridge after re-enable respects disabledTools from config", async () => {
    mocks.readConfigMock.mockReturnValue(demoCfg({ disabled: true }));
    const { tools, runtime } = buildRuntime();
    await runtime.reloadFromConfig();
    expect(runtime.size()).toBe(0);

    mocks.readConfigMock.mockReturnValue(demoCfg({ disabledTools: ["b"] }));
    await runtime.reloadFromConfig();
    expect(runtime.size()).toBe(1);
    expect(specNames(tools)).toEqual(["demo_a"]);
    expect(runtime.summaries()[0]!.toolCount).toBe(1);
  });
});
