import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
  sessionPath,
} from "../src/memory/session.js";
import {
  REASONIX_IMPORT_MAX_TOKENS,
  buildImportedSessionName,
  discoverExternalSessionApps,
  enforceReasonixImportTokenLimit,
  importExternalSession,
  importExternalSessions,
  parseExternalSessionFile,
} from "../src/session-import.js";
import { estimateRequestTokens } from "../src/tokenizer.js";

describe("session import parsers", () => {
  it("parses Claude sessions into Reasonix messages", () => {
    const source = [
      JSON.stringify({
        isMeta: true,
        type: "user",
        message: { role: "user", content: "skip me" },
      }),
      JSON.stringify({
        type: "user",
        cwd: "/tmp/claude-proj",
        message: { role: "user", content: "Need review" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "shell", input: { command: "pwd" } },
            { type: "text", text: "Running it." },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file1\nfile2" }],
        },
      }),
    ].join("\n");

    const tmp = writeFixture("claude-session.jsonl", source);
    const imported = parseExternalSessionFile("claude", tmp);

    expect(imported.workspace).toBe("/tmp/claude-proj");
    expect(imported.summary).toBe("Need review");
    expect(imported.messages).toEqual([
      { role: "user", content: "Need review" },
      {
        role: "assistant",
        content: "Running it.",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "shell", arguments: '{"command":"pwd"}' },
          },
        ],
        reasoning_content: undefined,
      },
      { role: "tool", content: "file1\nfile2", tool_call_id: "tool-1", name: "shell" },
    ]);
  });

  it("parses Codex response items and builds a default name", () => {
    const source = [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/tmp/codex-proj" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the deploy race" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "On it." }],
        },
      }),
    ].join("\n");

    const tmp = writeFixture("rollout-019e.jsonl", source);
    const imported = parseExternalSessionFile("codex", tmp);

    expect(imported.workspace).toBe("/tmp/codex-proj");
    expect(imported.messages).toEqual([
      { role: "user", content: "Fix the deploy race" },
      { role: "assistant", content: "On it." },
    ]);
    expect(buildImportedSessionName("codex", tmp, imported)).toBe("codex-Fix the deploy race");
  });

  it("compacts Reasonix sessions to readable text and appends a continuation request", () => {
    const source = [
      JSON.stringify({
        role: "user",
        content: [
          { type: "text", text: "Fix the importer" },
          { type: "image_url", image_url: { url: "data:image/png;base64,large" } },
        ],
      }),
      JSON.stringify({
        role: "assistant",
        content: "I updated the parser.",
        reasoning_content: "large private reasoning",
        tool_calls: [{ id: "call-1", function: { name: "edit_file", arguments: "{}" } }],
      }),
      JSON.stringify({ role: "tool", content: "large tool result", tool_call_id: "call-1" }),
      JSON.stringify({ role: "assistant", content: null, tool_calls: [] }),
    ].join("\n");
    const path = writeFixture("native.jsonl", source);
    writeFileSync(
      path.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({
        workspace: "/tmp/source-project",
        summary: "Importer work",
        model: "configured-model",
        reasoningEffort: "high",
        subagentModel: "configured-subagent",
        totalCostUsd: 12,
      }),
      "utf8",
    );

    const imported = parseExternalSessionFile("reasonix", path);

    expect(imported.messages).toEqual([
      { role: "user", content: "Fix the importer" },
      {
        role: "assistant",
        content:
          "Prior reasoning/work context:\nlarge private reasoning\n\nAssistant response:\nI updated the parser.",
      },
      {
        role: "user",
        content:
          "Continue from here using the imported conversation as context. Do not repeat work already completed.",
      },
    ]);
    expect(imported).toMatchObject({
      workspace: "/tmp/source-project",
      summary: "Importer work",
      model: "configured-model",
      reasoningEffort: "high",
      subagentModel: "configured-subagent",
    });
  });
});

describe("Reasonix cross-workspace import", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-native-import-"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers only foreign sessions and clones them without transient metadata", () => {
    rewriteSession("foreign", [
      { role: "user", content: "Implement the importer" },
      {
        role: "assistant",
        content: "The parser is ready.",
        reasoning_content: "I inspected the parser and verified the source metadata.",
        tool_calls: [{ id: "tool-1", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "discard me too", tool_call_id: "tool-1" },
    ]);
    patchSessionMeta("foreign", {
      workspace: "/projects/source",
      summary: "Native import",
      model: "configured-model",
      reasoningEffort: "high",
      subagentModel: "configured-subagent",
      totalCostUsd: 42,
      cacheHitTokens: 1000,
    });
    rewriteSession("local", [{ role: "user", content: "Stay local" }]);
    patchSessionMeta("local", { workspace: "/projects/destination" });
    writeFileSync(sessionPath("foreign").replace(/\.jsonl$/, ".events.jsonl"), "{}\n", "utf8");

    const reasonix = discoverExternalSessionApps("/projects/destination").find(
      (app) => app.source === "reasonix",
    );
    expect(reasonix).toMatchObject({ available: true, sessionCount: 1 });

    const first = importExternalSessions({
      sources: ["reasonix"],
      workspace: "/projects/destination",
    });
    expect(first).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    expect(first.latestName).toBeDefined();
    expect(loadSessionMessages("foreign")).toHaveLength(3);
    expect(loadSessionMessages(first.latestName!)).toEqual([
      { role: "user", content: "Implement the importer" },
      {
        role: "assistant",
        content:
          "Prior reasoning/work context:\nI inspected the parser and verified the source metadata.\n\nAssistant response:\nThe parser is ready.",
      },
      {
        role: "user",
        content:
          "Continue from here using the imported conversation as context. Do not repeat work already completed.",
      },
    ]);
    expect(loadSessionMeta(first.latestName!)).toEqual({
      workspace: "/projects/destination",
      summary: "Native import",
      branch: undefined,
      model: "configured-model",
      reasoningEffort: "high",
      subagentModel: "configured-subagent",
      importedSource: "reasonix",
      importedPath: sessionPath("foreign"),
    });

    expect(
      importExternalSessions({ sources: ["reasonix"], workspace: "/projects/destination" }),
    ).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
  });

  it("applies the 30K-token guard after text pruning and retains newest messages", () => {
    const oldest = { role: "user" as const, content: `oldest-${"a".repeat(70_000)}` };
    const middle = { role: "assistant" as const, content: `middle-${"b".repeat(70_000)}` };
    const newest = { role: "user" as const, content: "Continue from the newest state" };

    const result = enforceReasonixImportTokenLimit([oldest, middle, newest]);

    expect(estimateRequestTokens(result)).toBeLessThanOrEqual(REASONIX_IMPORT_MAX_TOKENS);
    expect(result[0]?.content).toContain("older conversation messages were truncated");
    expect(result.at(-1)).toEqual(newest);
    expect(result).not.toContainEqual(oldest);
  });

  it("does not add a truncation notice when the final pruned text fits", () => {
    const messages = [{ role: "user" as const, content: "Small transcript" }];

    expect(enforceReasonixImportTokenLimit(messages)).toBe(messages);
  });

  it("allocates a collision-safe name for a manually imported native session", () => {
    rewriteSession("source", [{ role: "user", content: "Carry this over" }]);
    patchSessionMeta("source", { workspace: "/projects/source", summary: "Same title" });
    rewriteSession("reasonix-Same title", [{ role: "user", content: "Do not overwrite" }]);

    const result = importExternalSession({
      source: "reasonix",
      path: sessionPath("source"),
      workspace: "/projects/destination",
    });

    expect(result.name).toBe("reasonix-Same title-2");
    expect(existsSync(sessionPath("reasonix-Same title"))).toBe(true);
  });
});

function writeFixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-session-import-"));
  const path = join(dir, name);
  writeFileSync(path, `${body}\n`, "utf8");
  fixtures.push(dir);
  return path;
}

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});
