/** Agent-facing tools for scaffolding skills + MCP servers from chat. Persists via the same paths the wizard / `/skill new` use. */

import {
  defaultConfigPath,
  loadEffectiveMcpConfig,
  loadResolvedSkillPaths,
  readConfig,
  writeConfig,
} from "../config.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import { preflightStdioSpec } from "../mcp/preflight.js";
import { type McpSpec, parseMcpSpec, specToRaw } from "../mcp/spec.js";
import { SkillStore, parseSkillDraft, serializeSkill } from "../skills.js";
import type { ToolRegistry } from "../tools.js";

export interface ScaffoldToolsOptions {
  homeDir?: string;
  projectRoot?: string;
  /** Override config path — tests point this at a tmp file. */
  configPath?: string;
}

const VALID_SERVER_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function registerScaffoldTools(
  registry: ToolRegistry,
  opts: ScaffoldToolsOptions = {},
): ToolRegistry {
  const configPath = opts.configPath ?? defaultConfigPath();

  registry.register({
    name: "create_skill",
    description:
      'Scaffold a SKILL.md the user can later invoke via `/skill <name>`. Frontmatter (description / allowed_tools / run_as / model) is filled from structured args here. Use `run_as: "subagent"` for read-and-synthesize playbooks; default inline appends body to parent log. Refuses to overwrite existing skills.',
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Identifier — letters/digits/`_`/`-`/`.`, 1–64 chars. Becomes filename + frontmatter `name`.",
        },
        description: {
          type: "string",
          description: 'One-liner for the skills index. Lead with the verb ("Run X and …").',
        },
        body: {
          type: "string",
          description: "Markdown playbook. Reference tools by name.",
        },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description:
            "`project` (default) = workspace .reasonix/skills/; `global` = ~/.reasonix/skills/.",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tool allowlist for `run_as: subagent`. Omit for full inherited toolset.",
        },
        run_as: {
          type: "string",
          enum: ["inline", "subagent"],
          description:
            "inline (default) appends body to parent log. subagent spawns isolated child; only final answer returns.",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description:
            "Subagent model override. Default flash; use pro only when the playbook needs it.",
        },
      },
      required: ["name", "description", "body"],
    },
    fn: async (args: {
      name?: unknown;
      description?: unknown;
      body?: unknown;
      scope?: unknown;
      allowed_tools?: unknown;
      run_as?: unknown;
      model?: unknown;
    }) => {
      const draft = parseSkillDraft({
        name: args.name,
        description: args.description,
        body: args.body,
        runAs: args.run_as,
        allowedTools: args.allowed_tools,
        model: args.model,
      });
      if ("error" in draft) return JSON.stringify({ error: draft.error });
      const scope: "project" | "global" =
        args.scope === "global" ? "global" : opts.projectRoot ? "project" : "global";
      const content = serializeSkill(draft);

      const store = new SkillStore({
        homeDir: opts.homeDir,
        projectRoot: opts.projectRoot,
        customSkillPaths: opts.projectRoot
          ? loadResolvedSkillPaths(opts.projectRoot, configPath)
          : [],
      });
      const result = store.createWithContent(draft.name, scope, content);
      if ("error" in result) {
        return JSON.stringify({ error: result.error });
      }
      return JSON.stringify({
        success: true,
        path: result.path,
        scope,
        name: draft.name,
        run_as: draft.runAs,
      });
    },
  });

  registry.register({
    name: "add_mcp_server",
    description:
      'Register a new MCP server in the user\'s config (`mcp` array). Takes effect next session. Use stdio for local commands, sse/streamable-http for remote. Pass `from_catalog` (e.g. "filesystem", "github") to auto-fill command+args from the bundled catalog. Refuses name collisions.',
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Namespace prefix on every tool. Letters/digits/`_`/`-`, must start with letter or `_`.",
        },
        transport: {
          type: "string",
          enum: ["stdio", "sse", "streamable-http"],
          description:
            "stdio = local command via stdin/stdout; sse / streamable-http = remote. Required unless `from_catalog` is set.",
        },
        command: {
          type: "string",
          description: "Argv[0] for stdio — typically `npx` or a binary path.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Remaining argv for stdio — e.g. `["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]`.',
        },
        url: {
          type: "string",
          description: "Endpoint URL for sse / streamable-http — must be http(s)://.",
        },
        from_catalog: {
          type: "string",
          description:
            "Bundled catalog shortcut: filesystem / memory / github / puppeteer / everything. Fills command+args; user supplies user-args via `args`.",
        },
      },
      required: ["name"],
    },
    fn: async (args: {
      name?: unknown;
      transport?: unknown;
      command?: unknown;
      args?: unknown;
      url?: unknown;
      from_catalog?: unknown;
    }) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!VALID_SERVER_NAME.test(name)) {
        return JSON.stringify({
          error: `invalid server name: ${JSON.stringify(name)} — must match [a-zA-Z_][a-zA-Z0-9_-]*`,
        });
      }

      const specStr = buildSpecString({
        name,
        transport: typeof args.transport === "string" ? args.transport : undefined,
        command: typeof args.command === "string" ? args.command : undefined,
        argv: Array.isArray(args.args)
          ? (args.args.filter((a) => typeof a === "string") as string[])
          : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        fromCatalog: typeof args.from_catalog === "string" ? args.from_catalog : undefined,
      });
      if ("error" in specStr) {
        return JSON.stringify({ error: specStr.error });
      }

      let parsed: McpSpec;
      try {
        parsed = parseMcpSpec(specStr.spec);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
      if (parsed.transport === "stdio") {
        try {
          preflightStdioSpec(parsed);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
      }

      const existingSpecs = loadEffectiveMcpConfig(opts.projectRoot, configPath);
      const collision = existingSpecs.find((s) => s.name === name);
      if (collision) {
        return JSON.stringify({
          error: `MCP server ${JSON.stringify(name)} already registered: ${specToRaw(collision)}`,
        });
      }
      const cfg = readConfig(configPath);
      const existing = cfg.mcp ?? [];
      cfg.mcp = [...existing, specStr.spec];
      writeConfig(cfg, configPath);
      return JSON.stringify({
        success: true,
        name,
        transport: parsed.transport,
        spec: specStr.spec,
        ...(specStr.note ? { install_note: specStr.note } : {}),
        config_path: configPath,
        active_on_next_launch: true,
      });
    },
  });

  registry.register({
    name: "list_mcp_bridges",
    description:
      "List all configured MCP servers and bridges, their transport type, status, and tools currently bridged into the session.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional: filter by exact server/bridge name.",
        },
      },
    },
    fn: async (args: { name?: unknown }) => {
      const filterName = typeof args.name === "string" ? args.name.trim() : undefined;
      const configured = loadEffectiveMcpConfig(opts.projectRoot, configPath);
      const registeredSpecs = registry.specs();

      const bridges = configured
        .filter((s) => !filterName || s.name === filterName)
        .map((s) => {
          const prefix = s.name ? `${s.name}_` : "";
          const tools = prefix
            ? registeredSpecs
                .filter((spec) => spec.function.name.startsWith(prefix))
                .map((spec) => ({
                  name: spec.function.name,
                  description: spec.function.description ?? "",
                }))
            : [];
          const isBridged = tools.length > 0;
          const status = s.disabled ? "disabled" : isBridged ? "connected" : "configured";
          const disabledTools = s.disabledTools ?? [];
          return {
            name: s.name ?? "anon",
            transport: s.transport,
            status,
            disabled: s.disabled === true,
            ...(s.transport === "stdio"
              ? { command: s.command, args: s.args ?? [] }
              : { url: s.url }),
            tool_count: tools.length,
            tools,
            disabled_tools: disabledTools,
          };
        });

      return JSON.stringify({
        count: bridges.length,
        bridges,
      });
    },
  });

  return registry;
}

export { serializeSkill };

interface BuildSpecInput {
  name: string;
  transport?: string;
  command?: string;
  argv?: string[];
  url?: string;
  fromCatalog?: string;
}

function buildSpecString(
  input: BuildSpecInput,
): { spec: string; note?: string } | { error: string } {
  if (input.fromCatalog) {
    const entry = MCP_CATALOG.find((e) => e.name === input.fromCatalog);
    if (!entry) {
      const known = MCP_CATALOG.map((e) => e.name).join(", ");
      return {
        error: `unknown catalog entry: ${JSON.stringify(input.fromCatalog)} — known: ${known}`,
      };
    }
    const userArgs = input.argv ?? [];
    if (entry.userArgs && userArgs.length === 0) {
      return {
        error: `catalog entry "${entry.name}" needs ${entry.userArgs} — pass it via the 'args' parameter`,
      };
    }
    const tail = userArgs.map(quoteIfNeeded).join(" ");
    const body = `npx -y ${entry.package}${tail ? ` ${tail}` : ""}`;
    return { spec: `${input.name}=${body}`, note: entry.note };
  }

  const transport = input.transport;
  if (!transport) {
    return { error: "add_mcp_server requires 'transport' (or 'from_catalog')" };
  }
  if (transport === "stdio") {
    if (!input.command || !input.command.trim()) {
      return { error: "stdio transport requires 'command'" };
    }
    const tail = (input.argv ?? []).map(quoteIfNeeded).join(" ");
    const body = `${quoteIfNeeded(input.command.trim())}${tail ? ` ${tail}` : ""}`;
    return { spec: `${input.name}=${body}` };
  }
  if (transport === "sse" || transport === "streamable-http") {
    if (!input.url || !/^https?:\/\//i.test(input.url)) {
      return { error: `${transport} transport requires an http(s):// 'url'` };
    }
    const prefix = transport === "streamable-http" ? "streamable+" : "";
    return { spec: `${input.name}=${prefix}${input.url.trim()}` };
  }
  return { error: `unknown transport: ${JSON.stringify(transport)}` };
}

function quoteIfNeeded(s: string): string {
  return /\s|"/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}
