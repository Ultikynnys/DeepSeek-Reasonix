import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { pruneStubFor, pruneUnusedFileReads } from "../src/file-prune.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage } from "../src/types.js";
import { jsonOkResponse as okJsonResponse } from "./support/fake-client.js";

function readExchange(path: string, content: string, callId: string): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path }) },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, name: "read_file", content },
  ];
}

function editCall(path: string, callId: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: {
          name: "edit_file",
          arguments: JSON.stringify({ path, search: "old", replace: "new" }),
        },
      },
    ],
  };
}

/** A later user turn — moves lastUserIdx past the reads so they are prunable
 *  candidates instead of being protected as the active exchange. */
function nextTurn(): ChatMessage[] {
  return [
    { role: "user", content: "next turn" },
    { role: "assistant", content: "ok" },
  ];
}

describe("pruneUnusedFileReads", () => {
  it("stubs a read_file result whose path is never referenced again", () => {
    const big = "DEAD BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "look at src/dead.ts" },
      ...readExchange("src/dead.ts", big, "call-1"),
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    expect(result.prunedFiles).toEqual(["src/dead.ts"]);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.messages[2]?.content).toContain("[file pruned: src/dead.ts");
    expect(result.messages[2]?.content).not.toContain("DEAD BODY");
    // pairing fields untouched — the API contract stays valid
    expect(result.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      name: "read_file",
    });
  });

  it("keeps a read referenced by a later edit_file", () => {
    const big = "LIVE BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "work on src/live.ts" },
      ...readExchange("src/live.ts", big, "call-1"),
      editCall("src/live.ts", "call-2"),
      {
        role: "tool",
        tool_call_id: "call-2",
        name: "edit_file",
        content: "edit blocks: 1/1 applied",
      },
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    expect(result.prunedFiles).toEqual([]);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[2]?.content).toBe(big);
  });

  it("prunes only the LAST read of a path — earlier reads stay load-bearing", () => {
    const big = "FULL BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "first" },
      ...readExchange("src/x.ts", big, "call-1"),
      ...readExchange("src/x.ts", "RANGE BODY ".repeat(40), "call-2"),
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    // The earlier read is load-bearing for the later (possibly partial) read;
    // only the final, unreferenced read of the path gets stubbed.
    expect(result.prunedFiles).toEqual(["src/x.ts"]);
    expect(result.messages[2]?.content).toBe(big);
    expect(result.messages[4]?.content).toContain("[file pruned: src/x.ts");
  });

  it("keeps reads in the active exchange (after the last user message)", () => {
    const big = "ACTIVE BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "earlier" },
      { role: "user", content: "read src/current.ts" },
      ...readExchange("src/current.ts", big, "call-1"),
    ];
    const result = pruneUnusedFileReads(log);

    // No later reference anywhere, yet the read must survive: the turn that
    // produced it is still the one the fold protects (protectActiveExchange).
    expect(result.prunedFiles).toEqual([]);
    expect(result.messages[3]?.content).toBe(big);
  });

  it("prunes only the unreferenced member of parallel reads", () => {
    const log: ChatMessage[] = [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-a",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
          },
          {
            id: "call-b",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/b.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-a", name: "read_file", content: "A ".repeat(100) },
      { role: "tool", tool_call_id: "call-b", name: "read_file", content: "B ".repeat(100) },
      editCall("src/b.ts", "call-edit"),
      { role: "tool", tool_call_id: "call-edit", name: "edit_file", content: "applied" },
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    expect(result.prunedFiles).toEqual(["src/a.ts"]);
    expect(result.messages[2]?.content).toContain("[file pruned: src/a.ts");
    expect(result.messages[3]?.content).toContain("B ");
  });

  it("keeps a read when a sibling call in the same message references the path", () => {
    const big = "BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "read then edit src/p.ts" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/p.ts" }) },
          },
          {
            id: "call-edit",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({ path: "src/p.ts", search: "a", replace: "b" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-read", name: "read_file", content: big },
      { role: "tool", tool_call_id: "call-edit", name: "edit_file", content: "applied" },
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    // The same-message edit references the path — the read's content is still
    // load-bearing, only the read's own call is exempt from the scan.
    expect(result.prunedFiles).toEqual([]);
    expect(result.messages[2]?.content).toBe(big);
  });

  it("keeps short results verbatim (stubbing would save nothing)", () => {
    const log: ChatMessage[] = [
      { role: "user", content: "read src/tiny.ts" },
      ...readExchange("src/tiny.ts", "just a few tokens", "call-1"),
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    expect(result.prunedFiles).toEqual([]);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[2]?.content).toBe("just a few tokens");
  });

  it("leaves reads without a tool_call_id untouched", () => {
    const big = "BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "read src/anonymous.ts" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/anonymous.ts" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "", name: "read_file", content: big },
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    expect(result.prunedFiles).toEqual([]);
    expect(result.messages[2]?.content).toBe(big);
  });

  it("does not mutate the input array", () => {
    const big = "BODY ".repeat(50);
    const log: ChatMessage[] = [
      { role: "user", content: "read src/dead.ts" },
      ...readExchange("src/dead.ts", big, "call-1"),
    ];
    pruneUnusedFileReads(log);

    expect(log[2]?.content).toBe(big);
  });

  it("keeps parallel duplicate reads of the same path (sibling refs count)", () => {
    const log: ChatMessage[] = [
      { role: "user", content: "read src/dead.ts twice" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/dead.ts" }) },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/dead.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", name: "read_file", content: "BODY ".repeat(100) },
      { role: "tool", tool_call_id: "call-2", name: "read_file", content: "BODY ".repeat(100) },
      ...nextTurn(),
    ];
    const result = pruneUnusedFileReads(log);

    // Each duplicate's sibling read references the path, so both are treated
    // as load-bearing and survive — conservative, no content loss.
    expect(result.prunedFiles).toEqual([]);
    expect(result.messages[2]?.content).toContain("BODY ");
    expect(result.messages[3]?.content).toContain("BODY ");
  });
});

describe("fold integration — the prune step", () => {
  function seedTurns(loop: CacheFirstLoop, n: number): void {
    for (let i = 0; i < n; i++) {
      loop.log.append({
        role: "user",
        content: `question ${i}: ${"context padding for prune step regression ".repeat(8)}`,
      });
      loop.log.append({
        role: "assistant",
        content: `answer ${i}: ${"more context padding for prune step regression ".repeat(8)}`,
      });
    }
  }

  it("summarizer receives the pruned head; result reports the prune step", async () => {
    // One body per request — the fold now runs the file-triage step as a
    // SECOND call, so capturing a single slot would let the triage request
    // clobber the summary body under assertion.
    const capturedBodies: Array<{ messages: ChatMessage[] }> = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
        capturedBodies.push(JSON.parse(init?.body ?? "{}") as { messages: ChatMessage[] });
        return okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    // Dead read lands in the fold head — never referenced afterwards.
    loop.log.append({ role: "user", content: "read src/dead.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-dead",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/dead.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "call-dead",
      name: "read_file",
      content: "DEAD BODY ".repeat(40),
    });
    // Live exchange fits the tail budget and survives the fold verbatim.
    loop.log.append({ role: "user", content: "read src/live.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-live",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/live.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "call-live",
      name: "read_file",
      content: "LIVE BODY ".repeat(10),
    });
    loop.log.append(editCall("src/live.ts", "call-edit"));
    loop.log.append({
      role: "tool",
      tool_call_id: "call-edit",
      name: "edit_file",
      content: "edit blocks: 1/1 applied",
    });

    const result = await loop.compactHistory({ keepRecentTokens: 140 });

    expect(result.folded).toBe(true);
    // The prune step ran as its own pass and reported its accounting.
    expect(result.prunedFiles).toBe(1);
    expect(result.prunedTokens).toBeGreaterThan(0);

    // The summarizer never saw the dead file body — only the stub.
    // (capturedBodies[0] is the summary request; [1] is the file-triage step.)
    const deadInRequest = capturedBodies[0]?.messages.find((m) => m.tool_call_id === "call-dead");
    expect(deadInRequest?.content).toContain("[file pruned: src/dead.ts");
    expect(deadInRequest?.content).not.toContain("DEAD BODY");
    // The live read is in the tail, not the head — the summarizer never sees it.
    const liveInRequest = capturedBodies[0]?.messages.find((m) => m.tool_call_id === "call-live");
    expect(liveInRequest).toBeUndefined();

    // Committed log: summary first, live exchange survives untouched.
    const msgs = loop.log.entries;
    expect(msgs[0]?.content).toContain("SUMMARY");
    const liveInLog = msgs.find((m) => m.tool_call_id === "call-live");
    expect(liveInLog?.content).toContain("LIVE BODY");
    // The dead content is gone from the log entirely (head replaced).
    expect(msgs.some((m) => String(m.content).includes("DEAD BODY"))).toBe(false);
  });

  it("never prunes reads from the active exchange, even under a forced fold", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] })),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    // The ONLY read sits in the last user→assistant exchange — no later
    // reference exists, but it must survive the fold verbatim.
    loop.log.append({ role: "user", content: "read src/current.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-cur",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/current.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "call-cur",
      name: "read_file",
      content: "CURRENT BODY ".repeat(10),
    });

    const result = await loop.compactHistory({ keepRecentTokens: 100 });

    expect(result.folded).toBe(true);
    expect(result.prunedFiles).toBeUndefined();

    const msgs = loop.log.entries;
    const cur = msgs.find((m) => m.tool_call_id === "call-cur");
    expect(cur?.content).toContain("CURRENT BODY");
    expect(cur?.content).not.toContain("pruned");
  });

  it("a noop fold leaves the log untouched — pruning never leaks without a commit", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] })),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 2);
    // Old unreferenced read + a tiny active exchange — everything fits the
    // tail budget, so the boundary walk lands at 0 and the fold must noop
    // without applying the pruning (no log mutation on the noop path).
    loop.log.append({ role: "user", content: "read src/old.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-old",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/old.ts" }) },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "call-old",
      name: "read_file",
      content: "OLD BODY ".repeat(10),
    });
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({ role: "assistant", content: "hello" });

    const result = await loop.compactHistory({ keepRecentTokens: 2000 });

    expect(result.folded).toBe(false);
    expect(result.prunedFiles).toBeUndefined();
    const old = loop.log.entries.find((m) => m.tool_call_id === "call-old");
    expect(old?.content).toContain("OLD BODY");
    expect(old?.content).not.toContain("pruned");
  });
});
