import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_OAUTH_CLIENT_ID } from "../src/antigravity-oauth.js";
import { buildCodeToolset } from "../src/code/setup.js";
import { saveAntigravityOAuth } from "../src/config.js";

// #700-followup: buildCodeToolset used to eagerly construct a DeepSeekClient
// for the subagent runner, which threw "DEEPSEEK_API_KEY is not set" before
// the wizard could prompt. Now the client is constructed lazily on the first
// subagent dispatch, so the toolset builds without a key.

describe("buildCodeToolset", () => {
  let savedKey: string | undefined;
  let tmpRoot: string;
  let cfgPath: string;

  beforeEach(() => {
    savedKey = process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: setting to "undefined" string would mask test
    delete process.env.DEEPSEEK_API_KEY;
    tmpRoot = mkdtempSync(join(tmpdir(), "reasonix-code-setup-"));
    cfgPath = join(tmpRoot, "config.json");
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("builds without DEEPSEEK_API_KEY set", async () => {
    const toolset = await buildCodeToolset({ rootDir: tmpRoot });
    expect(toolset.tools.size).toBeGreaterThan(0);
    await toolset.jobs.shutdown();
  });

  it("editMode=plan flips the registry's plan-mode gate so write tools refuse to dispatch", async () => {
    writeFileSync(cfgPath, JSON.stringify({ editMode: "plan" }), "utf8");
    const toolset = await buildCodeToolset({ rootDir: tmpRoot, configPath: cfgPath });
    const out = await toolset.tools.dispatch(
      "write_file",
      JSON.stringify({ path: "new.txt", content: "hello" }),
    );
    expect(JSON.parse(out).error).toMatch(/unavailable in plan mode/i);
    await toolset.jobs.shutdown();
  });

  it("accepts a per-tab subagentModel getter and builds without error", async () => {
    // The getter is read lazily at spawn time, so merely passing it must not
    // change build-time behavior (and must not construct a client eagerly).
    let reads = 0;
    const toolset = await buildCodeToolset({
      rootDir: tmpRoot,
      subagentModel: () => {
        reads += 1;
        return "deepseek-v4-flash";
      },
    });
    expect(toolset.tools.size).toBeGreaterThan(0);
    // Never consulted during toolset construction — only on an actual subagent spawn.
    expect(reads).toBe(0);
    await toolset.jobs.shutdown();
  });

  it("runs subagents with Gemini models using resolved Antigravity auth", async () => {
    saveAntigravityOAuth(
      {
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        accessToken: "at-test-token",
        refreshToken: "rt-test-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
        models: ["gemini-3.7-flash-tiered"],
      },
      cfgPath,
    );

    const sse = [
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "subagent investigation complete" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      })}\n\n`,
    ].join("");

    let capturedAuth: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers.authorization ?? headers.Authorization;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const toolset = await buildCodeToolset({
      rootDir: tmpRoot,
      configPath: cfgPath,
      subagentModel: () => "gemini-3.7-flash-tiered",
    });

    const result = await toolset.tools.dispatch(
      "explore",
      JSON.stringify({ task: "investigate repo structure" }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("subagent investigation complete");
    expect(capturedAuth).toBe("Bearer at-test-token");
    await toolset.jobs.shutdown();
  });
});
