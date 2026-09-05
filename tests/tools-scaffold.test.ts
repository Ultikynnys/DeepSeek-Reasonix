/** create_skill / add_mcp_server — temp homeDir + configPath so the tool never touches the real config. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { registerScaffoldTools, serializeSkill } from "../src/tools/scaffold.js";

interface Setup {
  home: string;
  projectRoot: string;
  configPath: string;
  reg: ToolRegistry;
}

function setup(): Setup {
  const home = mkdtempSync(join(tmpdir(), "reasonix-scaffold-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "reasonix-scaffold-proj-"));
  const configPath = join(home, "config.json");
  const reg = new ToolRegistry();
  registerScaffoldTools(reg, { homeDir: home, projectRoot, configPath });
  return { home, projectRoot, configPath, reg };
}

function teardown(s: Setup): void {
  rmSync(s.home, { recursive: true, force: true });
  rmSync(s.projectRoot, { recursive: true, force: true });
}

async function call(reg: ToolRegistry, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await reg.dispatch(name, JSON.stringify(args));
  return JSON.parse(out);
}

describe("create_skill", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("scaffolds a project-scope skill with the structured frontmatter", async () => {
    const r = await call(s.reg, "create_skill", {
      name: "lint-before-commit",
      description: "Run typecheck + lint before letting the user commit.",
      body: "# lint-before-commit\n\nRun `npm run verify` ...",
    });
    expect(r.success).toBe(true);
    expect(r.scope).toBe("project");
    expect(r.path).toContain(".reasonix");
    expect(existsSync(r.path)).toBe(true);
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("name: lint-before-commit");
    expect(content).toContain("description: Run typecheck + lint before letting the user commit.");
    expect(content).toContain("# lint-before-commit");
  });

  it("emits subagent + allowed-tools + model frontmatter when supplied", async () => {
    const r = await call(s.reg, "create_skill", {
      name: "deep-explore",
      description: "Wide-net read-only investigation.",
      body: "Use read_file + search_content.",
      run_as: "subagent",
      allowed_tools: ["read_file", "search_content"],
      model: "deepseek-v4-pro",
    });
    expect(r.success).toBe(true);
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("runAs: subagent");
    expect(content).toContain("allowed-tools: read_file, search_content");
    expect(content).toContain("model: deepseek-v4-pro");
  });

  it("rejects an invalid skill name", async () => {
    const r = await call(s.reg, "create_skill", {
      name: "../escape",
      description: "x",
      body: "y",
    });
    expect(r.error).toMatch(/invalid skill name/);
  });

  it("refuses to overwrite an existing skill", async () => {
    await call(s.reg, "create_skill", {
      name: "twice",
      description: "first",
      body: "first body",
    });
    const r = await call(s.reg, "create_skill", {
      name: "twice",
      description: "second",
      body: "second body",
    });
    expect(r.error).toMatch(/already exists/);
  });

  it("rejects bad allowed_tools entries", async () => {
    const r = await call(s.reg, "create_skill", {
      name: "bad-tools",
      description: "x",
      body: "y",
      allowed_tools: ["valid_tool", "with space"],
    });
    expect(r.error).toMatch(/invalid tool name/);
  });
});

describe("serializeSkill", () => {
  it("omits optional frontmatter fields when not set", () => {
    const out = serializeSkill({
      name: "minimal",
      description: "no extras",
      runAs: "inline",
      body: "body here",
    });
    expect(out).toContain("name: minimal");
    expect(out).toContain("description: no extras");
    expect(out).not.toContain("runAs:");
    expect(out).not.toContain("allowed-tools:");
    expect(out).not.toContain("model:");
  });
});

describe("add_mcp_server", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("registers a stdio server in cfg.mcp", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "myserver",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(r.success).toBe(true);
    expect(r.transport).toBe("stdio");
    expect(r.spec).toBe("myserver=node server.js");
    const cfg = readConfig(s.configPath);
    expect(cfg.mcp).toEqual(["myserver=node server.js"]);
  });

  it("registers a streamable-http server with the streamable+ prefix", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "remote",
      transport: "streamable-http",
      url: "https://example.com/mcp",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("remote=streamable+https://example.com/mcp");
  });

  it("registers an SSE server", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "events",
      transport: "sse",
      url: "https://example.com/events",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("events=https://example.com/events");
  });

  it("fills command + args from the catalog when from_catalog is set", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "memory",
      from_catalog: "memory",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("memory=npx -y @modelcontextprotocol/server-memory");
  });

  it("requires user-args for catalog entries that need them", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "fs",
      from_catalog: "filesystem",
    });
    expect(r.error).toMatch(/needs <dir>/);
  });

  it("preflights the filesystem sandbox and refuses missing directories", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "fs",
      from_catalog: "filesystem",
      args: [join(tmpdir(), "definitely-does-not-exist-xyz-12345")],
    });
    expect(r.error).toMatch(/does not exist/);
  });

  it("rejects a name collision with an existing entry", async () => {
    await call(s.reg, "add_mcp_server", {
      name: "dup",
      transport: "stdio",
      command: "node",
      args: ["a.js"],
    });
    const r = await call(s.reg, "add_mcp_server", {
      name: "dup",
      transport: "stdio",
      command: "node",
      args: ["b.js"],
    });
    expect(r.error).toMatch(/already registered/);
  });

  it("rejects a non-http url", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "bad",
      transport: "sse",
      url: "ftp://example.com",
    });
    expect(r.error).toMatch(/http/);
  });

  it("rejects an unknown catalog entry", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "x",
      from_catalog: "not-a-real-server",
    });
    expect(r.error).toMatch(/unknown catalog/);
  });

  it("requires transport when from_catalog is absent", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "x",
    });
    expect(r.error).toMatch(/transport/);
  });

  it("rejects collision against mcpServers object format", async () => {
    writeConfig(
      {
        mcpServers: {
          existing: {
            command: "uvx",
            args: ["blender-mcp"],
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "add_mcp_server", {
      name: "existing",
      transport: "stdio",
      command: "node",
      args: ["test.js"],
    });
    expect(r.error).toMatch(/already registered/);
  });
});

describe("list_mcp_bridges", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("returns empty bridges list when no servers configured", async () => {
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(0);
    expect(r.bridges).toEqual([]);
  });

  it("lists configured servers from cfg.mcp and cfg.mcpServers", async () => {
    writeConfig(
      {
        mcp: ["legacy=node legacy.js"],
        mcpServers: {
          blender: {
            command: "uvx.exe",
            args: ["--python", "3.11", "blender-mcp"],
          },
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(3);
    const names = r.bridges.map((b: any) => b.name).sort();
    expect(names).toEqual(["blender", "legacy", "remote"]);

    const blender = r.bridges.find((b: any) => b.name === "blender");
    expect(blender).toMatchObject({
      name: "blender",
      transport: "stdio",
      status: "configured",
      disabled: false,
      command: "uvx.exe",
      args: ["--python", "3.11", "blender-mcp"],
      tool_count: 0,
      tools: [],
    });
  });

  it("lists project-level .mcp.json servers", async () => {
    writeFileSync(
      join(s.projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          project_srv: {
            command: "npx",
            args: ["-y", "proj-mcp"],
          },
        },
      }),
      "utf8",
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    expect(r.bridges[0].name).toBe("project_srv");
  });

  it("reflects connected status and bridged tools when registered in tool registry", async () => {
    writeConfig(
      {
        mcpServers: {
          blender: {
            command: "uvx",
            args: ["blender-mcp"],
          },
        },
      },
      s.configPath,
    );

    // Simulate bridged tools in registry
    s.reg.register({
      name: "blender_render_scene",
      description: "Render current scene in Blender",
      parameters: { type: "object" },
      fn: async () => "rendered",
    });
    s.reg.register({
      name: "blender_get_objects",
      description: "Get scene objects",
      parameters: { type: "object" },
      fn: async () => "objects",
    });

    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    const blender = r.bridges[0];
    expect(blender.status).toBe("connected");
    expect(blender.tool_count).toBe(2);
    expect(blender.tools).toEqual([
      { name: "blender_render_scene", description: "Render current scene in Blender" },
      { name: "blender_get_objects", description: "Get scene objects" },
    ]);
  });

  it("reflects disabled status when marked disabled", async () => {
    writeConfig(
      {
        mcpServers: {
          disabled_srv: {
            command: "node",
            args: ["srv.js"],
            disabled: true,
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    expect(r.bridges[0].status).toBe("disabled");
    expect(r.bridges[0].disabled).toBe(true);
  });

  it("filters by exact bridge name", async () => {
    writeConfig(
      {
        mcp: ["a=node a.js", "b=node b.js"],
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", { name: "b" });
    expect(r.count).toBe(1);
    expect(r.bridges[0].name).toBe("b");
  });
});
