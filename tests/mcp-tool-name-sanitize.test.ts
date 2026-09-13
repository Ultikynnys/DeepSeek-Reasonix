import { describe, expect, it } from "vitest";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";
import { sanitizeWireToolName } from "../src/tool-name.js";

describe("sanitizeWireToolName", () => {
  it("leaves already-valid OpenAI function names untouched", () => {
    expect(sanitizeWireToolName("read_file")).toBe("read_file");
    expect(sanitizeWireToolName("srv-tool_2")).toBe("srv-tool_2");
  });

  it("replaces chars outside ^[a-zA-Z0-9_-] with underscores", () => {
    expect(sanitizeWireToolName("my.db.users.get")).toBe("my_db_users_get");
    expect(sanitizeWireToolName("GET /pets/{id}")).toBe("GET__pets__id_");
  });

  it("forces the first char to a letter or underscore", () => {
    expect(sanitizeWireToolName("2fa.login")).toBe("_2fa_login");
  });

  it("caps at 64 chars", () => {
    expect(sanitizeWireToolName("a".repeat(80))).toHaveLength(64);
  });

  it("is deterministic (cache-stable)", () => {
    expect(sanitizeWireToolName("a.b")).toBe(sanitizeWireToolName("a.b"));
  });
});

function fakeClient(tools: McpTool[]): Parameters<typeof bridgeMcpTools>[0] {
  const fake = {
    listTools: async () => ({ tools }),
    callTool: async (name: string): Promise<CallToolResult> => ({
      content: [{ type: "text", text: `ran ${name}` }],
    }),
  };
  return fake as unknown as Parameters<typeof bridgeMcpTools>[0];
}

function tool(name: string): McpTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

describe("bridgeMcpTools — OpenAI-safe tool names", () => {
  it("sanitizes a dotted server prefix + tool name to a valid wire name", async () => {
    const { registry, registeredNames, env } = await bridgeMcpTools(
      fakeClient([tool("users.get")]),
      {
        namePrefix: "my.db_",
      },
    );
    expect(registeredNames).toEqual(["my_db_users_get"]);
    expect(registry.has("my_db_users_get")).toBe(true);
    // Dispatch still reaches the REAL MCP tool name (the closure keeps it).
    expect(await registry.dispatch("my_db_users_get", "{}")).toContain("ran users.get");
    // The real bare name is recoverable for the per-tool toggle UI.
    expect(env.bareNames?.get("my_db_users_get")).toBe("users.get");
  });

  it("keeps two tools apart when they sanitize to the same name", async () => {
    const { registeredNames } = await bridgeMcpTools(
      fakeClient([tool("users.get"), tool("users_get")]),
      { namePrefix: "srv_" },
    );
    expect(new Set(registeredNames).size).toBe(2);
    expect(registeredNames).toContain("srv_users_get");
    expect(registeredNames.some((n) => n.startsWith("srv_users_get-"))).toBe(true);
  });

  it("does not rename already-valid tools (no cache churn)", async () => {
    const { registeredNames } = await bridgeMcpTools(fakeClient([tool("echo")]), {
      namePrefix: "demo_",
    });
    expect(registeredNames).toEqual(["demo_echo"]);
  });
});
