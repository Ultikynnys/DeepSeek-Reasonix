import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage, ToolSpec } from "../src/types.js";
import { type CapturedRequest, jsonOkResponse, makeFakeClient } from "./support/fake-client.js";

function fakeFetch(captured: CapturedRequest[], stubContent: string): typeof fetch {
  return makeFakeClient([{ content: stubContent }], { capture: (req) => captured.push(req) })
    .fetchMock as unknown as typeof fetch;
}

const SYSTEM_PROMPT =
  "You are a coding agent for project X.\nFollow the user's instructions.\nUse tools as needed.";

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

function seedTurns(loop: CacheFirstLoop, n: number, padding = 8): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({
      role: "user",
      content: `q${i}: ${"context padding to weigh the turn ".repeat(padding)}`,
    });
    loop.log.append({
      role: "assistant",
      content: `a${i}: ${"reply padding to weigh the turn ".repeat(padding)}`,
    });
  }
}

describe("ContextManager fold sends cache-aligned summary request", () => {
  it("summary request reuses the main agent's system prompt verbatim", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "compact prose summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 8);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);
    expect(captured).toHaveLength(1);

    const req = captured[0]!;
    expect(req.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });

  it("summary request reuses the main agent's tool list byte-for-byte", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 8);

    await loop.compactHistory({ keepRecentTokens: 40 });
    const req = captured[0]!;

    expect(req.tools).toBeDefined();
    expect(req.tools).toEqual(TOOLS);
    expect(JSON.stringify(req.tools)).toBe(JSON.stringify(TOOLS));
  });

  it("summary request preserves the head conversation bytes (head messages unmodified)", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 8);
    const logBeforeFold = loop.log.toMessages();

    await loop.compactHistory({ keepRecentTokens: 40 });
    const req = captured[0]!;

    expect(req.messages[0]!.role).toBe("system");
    const trailing = req.messages[req.messages.length - 1]!;
    expect(trailing.role).toBe("user");
    expect(typeof trailing.content === "string" ? trailing.content : "").toMatch(/Summarize/);

    // Strip system head + trailing instruction; what remains must equal a prefix of the pre-fold log.
    const middle = req.messages.slice(1, -1);
    for (let i = 0; i < middle.length; i++) {
      expect(middle[i]).toEqual(logBeforeFold[i]);
    }
  });

  it("summary request omits reasoning to avoid burning thinking tokens on paraphrase", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 8);

    await loop.compactHistory({ keepRecentTokens: 40 });
    const req = captured[0]!;
    expect(req.thinking).toBe("disabled");
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  it("summary request pins to flash even when the session model is pro", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-pro",
      stream: false,
    });
    seedTurns(loop, 8);

    await loop.compactHistory({ keepRecentTokens: 40 });
    expect(captured[0]!.model).toBe("deepseek-v4-flash");
  });

  it("skill-pinned bodies are sent to summarizer verbatim (head bytes unchanged)", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });

    const skillBody =
      '<skill-pin name="explore">\n# Skill: explore\n\nStep 1. Read entrypoints.\nStep 2. Trace flow.\n</skill-pin>';
    loop.log.append({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "run_skill", arguments: "{}" } },
      ],
    });
    loop.log.append({ role: "tool", tool_call_id: "c1", content: skillBody });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);

    const req = captured[0]!;
    const serialized = JSON.stringify(req.messages);
    expect(serialized).toContain("Step 1. Read entrypoints.");
    expect(serialized).toContain("Step 2. Trace flow.");
    expect(serialized).not.toContain("preserved separately, do not summarize");

    const trailing = req.messages[req.messages.length - 1]!;
    const instruction = typeof trailing.content === "string" ? trailing.content : "";
    expect(instruction).toMatch(/pinned verbatim/);
    expect(instruction).toContain('"explore"');
  });

  it("trailing instruction is the only message after the head — everything before is cache prefix", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 8);

    await loop.compactHistory({ keepRecentTokens: 40 });
    const req = captured[0]!;
    const last = req.messages[req.messages.length - 1]!;
    const secondLast = req.messages[req.messages.length - 2]!;

    expect(last.role).toBe("user");
    // The instruction sits adjacent to the original head's final message —
    // no separator / wrapper that would push the cache-miss boundary inward.
    expect(secondLast).toBeDefined();
    expect(secondLast.role === "assistant" || secondLast.role === "tool").toBe(true);
  });

  it("file relevance triage runs as its own step after the summary", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: makeFakeClient(
        [
          { content: "compact prose summary." },
          {
            content: JSON.stringify({
              keep: ["src/keep.ts"],
              drop: ["src/drop.ts", "ghost.ts"],
            }),
          },
        ],
        { capture: (req) => captured.push(req) },
      ).fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 6);
    loop.log.append({ role: "user", content: "work on these files" });
    loop.log.append({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "r1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/keep.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "r1",
      name: "read_file",
      content: "keep contents ".repeat(200),
    });
    loop.log.append({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "r2",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/drop.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "r2",
      name: "read_file",
      content: "drop contents ".repeat(200),
    });

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);
    // Summary request + triage request — exactly two model calls.
    expect(captured).toHaveLength(2);

    // Step 3 is a SMALL request: no tools, minimal system prompt, no head
    // re-prefill — the prompt is the fresh summary + the path list.
    const triageReq = captured[1]!;
    expect(triageReq.model).toBe("deepseek-v4-flash");
    expect(triageReq.thinking).toBe("disabled");
    expect(triageReq.tools).toBeUndefined();
    expect(triageReq.messages).toHaveLength(2);
    expect(triageReq.messages[0]!.role).toBe("system");
    const instruction = triageReq.messages[1]!.content as string;
    expect(instruction).toContain("compact prose summary.");
    expect(instruction).toContain("- src/keep.ts");
    expect(instruction).toContain("- src/drop.ts");

    // Drop lands on FoldResult for the UI, unknown paths are ignored, and the
    // decision is persisted as a marker in the summary message so a session
    // reload re-derives the same reduced list.
    expect(result.droppedFiles).toEqual(["src/drop.ts"]);
    const summaryContent = loop.log.entries[0]!.content as string;
    expect(summaryContent).toContain("<files-dropped-from-context>");
    expect(summaryContent).toContain("src/drop.ts");
    expect(summaryContent).not.toContain("ghost.ts");
  });

  it("triage failure fails open — the fold commits with no drops", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: (async (_url: unknown, init: { body?: string } | undefined) => {
        const body = init?.body ? (JSON.parse(init.body) as { messages?: ChatMessage[] }) : {};
        const last = body.messages?.[body.messages.length - 1];
        const content = typeof last?.content === "string" ? last.content : "";
        if (content.includes("[FILES TO CLASSIFY]")) {
          throw new Error("triage model unavailable");
        }
        return jsonOkResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 6);
    loop.log.append({ role: "user", content: "read these" });
    loop.log.append({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "r1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "r1",
      name: "read_file",
      content: "a contents ".repeat(200),
    });

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    // The fold still commits — relevance is advisory, never a fold-killer.
    expect(result.folded).toBe(true);
    expect(result.droppedFiles).toBeUndefined();
    expect(loop.log.entries[0]!.content as string).not.toContain("<files-dropped-from-context>");
  });
});
