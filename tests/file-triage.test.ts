import { describe, expect, it } from "vitest";
import {
  buildFileTriageInstruction,
  collectContextFilePaths,
  parseFileTriage,
} from "../src/file-triage.js";
import type { ChatMessage } from "../src/types.js";

function toolCall(name: string, args: string, id = "c1"): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

describe("collectContextFilePaths", () => {
  it("collects paths from read/edit/write/multi_edit calls, deduped and sorted", () => {
    const log: ChatMessage[] = [
      toolCall("read_file", JSON.stringify({ path: "src/b.ts" }), "c1"),
      toolCall("edit_file", JSON.stringify({ path: "src/a.ts" }), "c2"),
      toolCall("write_file", JSON.stringify({ path: "src/a.ts" }), "c3"),
      toolCall(
        "multi_edit",
        JSON.stringify({ edits: [{ path: "src/c.ts" }, { path: "src/b.ts" }] }),
        "c4",
      ),
    ];
    expect(collectContextFilePaths(log)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("ignores tools that don't put files in context and malformed args", () => {
    const log: ChatMessage[] = [
      toolCall("run_command", JSON.stringify({ command: "npm test", path: "irrelevant" })),
      toolCall("read_file", "{not json"),
      toolCall("read_file", JSON.stringify({})),
      toolCall("search_content", JSON.stringify({ path: "src" })),
      { role: "user", content: "plain user message" },
    ];
    expect(collectContextFilePaths(log)).toEqual([]);
  });

  it("handles backslash paths and empty strings", () => {
    const log: ChatMessage[] = [
      toolCall("read_file", JSON.stringify({ path: "src\\win.ts" })),
      toolCall("read_file", JSON.stringify({ path: "" })),
      toolCall("multi_edit", JSON.stringify({ edits: [{ path: "" }] })),
    ];
    expect(collectContextFilePaths(log)).toEqual(["src\\win.ts"]);
  });
});

describe("parseFileTriage", () => {
  const all = ["src/a.ts", "src/b.ts", "src/c.ts"];

  it("parses a clean JSON answer and honors drop", () => {
    const triage = parseFileTriage(JSON.stringify({ keep: ["src/a.ts"], drop: ["src/b.ts"] }), all);
    expect(triage).toEqual({ keep: ["src/a.ts", "src/c.ts"], drop: ["src/b.ts"] });
  });

  it("ignores drop entries that are not in the session's path set", () => {
    const triage = parseFileTriage(
      JSON.stringify({ keep: ["src/a.ts"], drop: ["src/b.ts", "ghost.ts"] }),
      all,
    );
    expect(triage).toEqual({ keep: ["src/a.ts", "src/c.ts"], drop: ["src/b.ts"] });
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const fenced = parseFileTriage(
      '```json\n{"keep": ["src/a.ts"], "drop": ["src/b.ts"]}\n```',
      all,
    );
    expect(fenced.drop).toEqual(["src/b.ts"]);
    const prose = parseFileTriage(
      'Here you go:\n{"keep": ["src/a.ts"], "drop": ["src/b.ts"]}\nDone.',
      all,
    );
    expect(prose.drop).toEqual(["src/b.ts"]);
  });

  it("keeps every path when the model output is malformed or empty", () => {
    expect(parseFileTriage("", all)).toEqual({ keep: all, drop: [] });
    expect(parseFileTriage(null, all)).toEqual({ keep: all, drop: [] });
    expect(parseFileTriage("not json at all", all)).toEqual({ keep: all, drop: [] });
    expect(parseFileTriage('{"keep": "src/a.ts"}', all)).toEqual({ keep: all, drop: [] });
    expect(parseFileTriage('{"drop": [123]}', all)).toEqual({ keep: all, drop: [] });
  });

  it("keeps paths the model didn't mention", () => {
    const triage = parseFileTriage(JSON.stringify({ keep: ["src/a.ts"] }), all);
    expect(triage.keep).toEqual(all);
    expect(triage.drop).toEqual([]);
  });
});

describe("buildFileTriageInstruction", () => {
  it("embeds the summary and every path, and demands JSON-only output", () => {
    const instruction = buildFileTriageInstruction("recap text", ["src/a.ts", "src/b.ts"]);
    expect(instruction).toContain("recap text");
    expect(instruction).toContain("- src/a.ts");
    expect(instruction).toContain("- src/b.ts");
    expect(instruction).toMatch(/\{"keep": \["path1"[^\n]*\}/);
    expect(instruction).toMatch(/exactly one of the two arrays/);
  });
});
