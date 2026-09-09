import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import {
  HISTORY_FOLD_HEAD_KEEP_MAX_TOKENS,
  HISTORY_FOLD_MARKER,
  compactModelForProvider,
  headKeepCut,
} from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import type { ChatMessage, ToolSpec } from "../src/types.js";
import { type CapturedRequest, jsonOkResponse, makeFakeClient } from "./support/fake-client.js";

function fakeFetch(captured: CapturedRequest[], stubContent: string): typeof fetch {
  return makeFakeClient([{ content: stubContent }], { capture: (req) => captured.push(req) })
    .fetchMock as unknown as typeof fetch;
}

const SYSTEM_PROMPT =
  "You are a coding agent for project X.\nFollow the user's instructions.\nUse tools as needed.";

// Deliberately NOT alphabetical in the original fixture — order drift used to
// be possible. ImmutablePrefix now normalizes to name-sorted order (sortToolSpecs)
// so the tool list is byte-stable for the cache prefix; these are pre-sorted.
const TOOLS: ToolSpec[] = [
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
    expect(typeof trailing.content === "string" ? trailing.content : "").toMatch(
      /Compact the preceding conversation/,
    );

    // Strip system head + trailing instruction; what remains must equal a prefix of the pre-fold log.
    const middle = req.messages.slice(1, -1);
    for (let i = 0; i < middle.length; i++) {
      // The only allowed difference is the wire-level message id stamp, which
      // is additive and index-derived (wire index = log index + 1 for the
      // system head) — everything else must match the pre-fold log verbatim.
      const { id, ...rest } = middle[i]!;
      if (middle[i]!.role === "assistant" || middle[i]!.role === "tool") {
        expect(id).toBe(`msg-${i + 1}`);
      } else {
        expect(id).toBeUndefined();
      }
      expect(rest).toEqual(logBeforeFold[i]);
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
      fetch: fakeFetch(captured, "summary for the conversation."),
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
        return jsonOkResponse({
          choices: [{ message: { content: "SUMMARY of the conversation so far" } }],
        });
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
    // The triage failure is LOUD — the fold card explains why nothing dropped.
    expect(result.warn).toMatch(/file triage failed/);
    expect(loop.log.entries[0]!.content as string).not.toContain("<files-dropped-from-context>");
  });

  it("compactModelForProvider maps each provider family to a compatible model", () => {
    expect(compactModelForProvider("gpt-5.6-sol")).toBe("gpt-5.6-luna");
    expect(compactModelForProvider("gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(compactModelForProvider("claude-sonnet-4-6-thinking")).toBe(
      "claude-sonnet-4-6-thinking",
    );
    expect(compactModelForProvider("ollama/llama3.1:latest")).toBe("ollama/llama3.1:latest");
    expect(compactModelForProvider("glm-5.3")).toBe("glm-5.3-flash");
    expect(compactModelForProvider("deepseek-v4-pro")).toBe("deepseek-v4-flash");
  });

  it("summary request uses active Antigravity model when running on Gemini provider", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "compact prose summary." }] } }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new DeepSeekClient({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      allowMissingKey: true,
      geminiAuthResolver: async () => ({ accessToken: "at", projectId: "p-123" }),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "gemini-3.7-flash",
      stream: false,
    });
    seedTurns(loop, 8);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.model).toBe("gemini-3.7-flash");
  });

  it("gemini compaction succeeds when trimmed head contains tool calls", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "compact prose summary." }] } }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new DeepSeekClient({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      allowMissingKey: true,
      geminiAuthResolver: async () => ({ accessToken: "at", projectId: "p-123" }),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "gemini-3.7-flash",
      stream: false,
    });

    // Seed multiple turns containing tool calls and results
    for (let i = 0; i < 6; i++) {
      loop.log.append({
        role: "user",
        content: `q${i}: find info in file ${i} ${"context padding ".repeat(30)}`,
      });
      loop.log.append({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${i}`,
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ path: `file${i}.ts` }) },
          },
        ],
      });
      loop.log.append({
        role: "tool",
        tool_call_id: `call-${i}`,
        name: "Read",
        content: `content of file ${i} ${"data padding ".repeat(50)}`,
      });
      loop.log.append({
        role: "assistant",
        content: `found info for q${i}`,
      });
    }

    const result = await loop.compactHistory({ keepRecentTokens: 50 });
    expect(result.folded).toBe(true);

    const request = capturedBody?.request as {
      contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }>;
    };
    expect(request).toBeDefined();
    // Invariant 1: First content turn must always be "user"
    expect(request.contents[0]?.role).toBe("user");

    // Invariant 2: Any turn containing functionCall must come immediately after a user turn
    for (let j = 0; j < request.contents.length; j++) {
      const turn = request.contents[j]!;
      const hasFunctionCall = turn.parts.some((p) => Boolean(p.functionCall));
      if (hasFunctionCall) {
        expect(turn.role).toBe("model");
        expect(j).toBeGreaterThan(0);
        const prevTurn = request.contents[j - 1]!;
        expect(prevTurn.role).toBe("user");
      }
    }
  });
});

/** Small ctx window: keep budget = max(1024, min(8192, 2% of 20k)) = 1024 tokens. */
const HEAD_KEEP_TEST_MODEL = "test-fold-headkeep";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("headKeepCut (head-keep boundary selection)", () => {
  it("keeps the whole span when the budget allows it", () => {
    const messages = [msg("user", "q0"), msg("assistant", "a0"), msg("user", "q1")];
    const tokens = messages.reduce((acc, m) => acc + m.content.length, 0);
    expect(headKeepCut(messages, messages.length, tokens)).toBe(messages.length);
  });

  it("only cuts immediately before user messages — never between a call and its result", () => {
    const pair: ChatMessage[] = [
      msg("user", "q0"),
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "c1", content: "result" },
      msg("user", "q1"),
    ];
    // Budget fits the whole first turn but nothing more: cut must land after the
    // tool result (index 3), never between the assistant call and its result.
    const budget = [...pair.slice(0, 3)].reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
    expect(headKeepCut(pair, 3, budget)).toBe(3);
    // Budget can't fit the first turn: cut stays at 0 (fold from the head).
    expect(headKeepCut(pair, 3, 0)).toBe(0);
  });

  it("returns 0 when even the first turn doesn't fit the budget", () => {
    const messages = [msg("user", "huge user paste ".repeat(50)), msg("assistant", "a0")];
    expect(headKeepCut(messages, messages.length, 5)).toBe(0);
  });

  it("caps the cut at limitIdx — the tail span is never eaten by the head", () => {
    const messages = [msg("user", "q0"), msg("assistant", "a0"), msg("user", "q1")];
    expect(headKeepCut(messages, 2, Number.MAX_SAFE_INTEGER)).toBe(2);
  });
});

describe("head-keep fold (prefix-preserving compaction)", () => {
  afterEach(() => {
    delete DEEPSEEK_CONTEXT_TOKENS[HEAD_KEEP_TEST_MODEL];
  });

  function headKeepLoop(
    ctxTokens: number,
    captured: CapturedRequest[],
    stubContent: string,
  ): CacheFirstLoop {
    DEEPSEEK_CONTEXT_TOKENS[HEAD_KEEP_TEST_MODEL] = ctxTokens;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, stubContent),
    });
    return new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: HEAD_KEEP_TEST_MODEL,
      stream: false,
    });
  }

  it("fold keeps the earliest turns verbatim and summarizes only the middle span", async () => {
    const captured: CapturedRequest[] = [];
    const loop = headKeepLoop(20_000, captured, "compact prose summary.");
    seedTurns(loop, 40);
    const before = loop.log.toMessages();

    const result = await loop.compactHistory({ keepRecentTokens: 200 });

    expect(result.folded).toBe(true);
    const kept = result.keptHeadMessages;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(before.length);
    // Kept head: byte-identical to the pre-fold log — the provider-cached prefix.
    for (let i = 0; i < kept!; i++) {
      expect(loop.log.entries[i]).toEqual(before[i]);
    }
    expect(result.keptHeadTokens ?? 0).toBeLessThanOrEqual(1024);
    // The summary sits exactly at the cut and carries the fold marker.
    const summaryMsg = loop.log.entries[kept!]!;
    expect(summaryMsg.role).toBe("assistant");
    expect((summaryMsg.content as string).includes(HISTORY_FOLD_MARKER)).toBe(true);
    // The summarizer instruction carries the bridging note.
    const instruction = captured[0]!.messages[captured[0]!.messages.length - 1]!;
    expect(instruction.content).toContain("retained verbatim");
    // The most recent messages survive verbatim after the summary.
    expect(loop.log.entries[loop.log.length - 1]).toEqual(before[before.length - 1]);
    // The log shrank: the middle span was replaced by one summary message.
    expect(loop.log.length).toBeLessThan(before.length);
  });

  it("a tool-call pair at the keep boundary is never split by the cut", async () => {
    const captured: CapturedRequest[] = [];
    const loop = headKeepLoop(20_000, captured, "compact prose summary.");
    // Turn 1 carries a tool-call pair; the later turns carry the weight.
    loop.log.append({ role: "user", content: "read the config" });
    loop.log.append({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"cfg.ts"}' } },
      ],
    });
    loop.log.append({ role: "tool", tool_call_id: "c1", content: "config body" });
    seedTurns(loop, 40);
    const before = loop.log.toMessages();

    const result = await loop.compactHistory({ keepRecentTokens: 200 });

    expect(result.folded).toBe(true);
    const kept = result.keptHeadMessages ?? 0;
    const head = loop.log.entries.slice(0, kept);
    // Every tool result inside the kept head has its call inside the kept head —
    // the cut never orphaned a result (or a call) at the boundary.
    const callIds = new Set(
      head.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])),
    );
    for (const m of head) {
      if (m.role === "tool") expect(callIds.has(m.tool_call_id)).toBe(true);
    }
    // The kept head prefix is byte-identical to the pre-fold log.
    for (let i = 0; i < kept; i++) {
      expect(loop.log.entries[i]).toEqual(before[i]);
    }
  });

  it("degenerate folds (whole span fits the keep budget) fall back to folding from the head", async () => {
    const captured: CapturedRequest[] = [];
    const loop = headKeepLoop(20_000, captured, "compact prose summary.");
    seedTurns(loop, 8);
    const before = loop.log.toMessages();

    const result = await loop.compactHistory({ keepRecentTokens: 40, keepHeadTokens: 0 });

    expect(result.folded).toBe(true);
    expect(result.keptHeadMessages).toBeUndefined();
    // Old shape: the summary is the first log entry.
    const first = loop.log.entries[0]!;
    expect(first.role).toBe("assistant");
    expect((first.content as string).includes(HISTORY_FOLD_MARKER)).toBe(true);
    expect(loop.log.length).toBeLessThan(before.length);
  });

  it("keep budget clamps to HISTORY_FOLD_HEAD_KEEP_MAX_TOKENS on huge windows", async () => {
    const captured: CapturedRequest[] = [];
    // 2% of 1M = 20k, clamped down to the 8192 cap — the kept head stays bounded
    // even when the window is enormous and the log dwarfs the cap.
    const loop = headKeepLoop(1_000_000, captured, "compact prose summary.");
    seedTurns(loop, 300);

    const result = await loop.compactHistory({ keepRecentTokens: 2000 });

    expect(result.folded).toBe(true);
    expect(result.keptHeadTokens ?? 0).toBeGreaterThan(1024);
    expect(result.keptHeadTokens ?? 0).toBeLessThanOrEqual(HISTORY_FOLD_HEAD_KEEP_MAX_TOKENS);
  });
});
