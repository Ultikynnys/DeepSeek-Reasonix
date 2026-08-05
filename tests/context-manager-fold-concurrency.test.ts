import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

function okJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function abortableNeverFetch(): typeof fetch {
  return vi.fn((_url: unknown, init: { signal?: AbortSignal } | undefined) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

function seedTurns(loop: CacheFirstLoop, n: number): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({
      role: "user",
      content: `question ${i}: ${"context padding for fold concurrency regression ".repeat(8)}`,
    });
    loop.log.append({
      role: "assistant",
      content: `answer ${i}: ${"more context padding for fold concurrency regression ".repeat(8)}`,
    });
  }
}

describe("ContextManager fold concurrency + failure surfacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a tool result appended while the fold summary request is in flight", async () => {
    // The fetch closure appends a tool result mid-request — exactly the
    // /compact-during-tool-read race: the fold snapshots the log, spends
    // seconds summarizing, and the read lands while the summarizer runs.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        loop.log.append({
          role: "tool",
          tool_call_id: "call-1",
          name: "read_file",
          content: "the read result",
        });
        return okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    // Mimic an in-flight read: assistant tool_calls whose result has not
    // landed yet when the fold starts.
    loop.log.append({ role: "user", content: "read src/loop.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);
    // The synthesized summary travels on FoldResult so the UI card can render it.
    expect(result.summary).toBe("SUMMARY");

    const msgs = loop.log.entries;
    expect(msgs[0]?.content).toContain("SUMMARY");
    // The in-flight exchange survives the fold AND the result that landed
    // mid-fold is preserved right after its parent — not clobbered by the
    // wholesale replacement (regression: orphaned tool results were dropped
    // by fixToolCallPairing, so the model never saw the read).
    const tail = msgs.slice(1);
    const parent = tail.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length === 1,
    );
    expect(parent).toBeDefined();
    expect(tail.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: "the read result",
    });
  });

  it("reports a failure reason when the summary request times out", async () => {
    vi.useFakeTimers();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: abortableNeverFetch() });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    const beforeMessages = loop.log.length;

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    // Deadline is scaled by head size — advancing past the ceiling is
    // guaranteed to fire the fold timeout for any head.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS + 1_000);
    const result = await resultPromise;

    // Fail-open stays, but the reason is no longer swallowed — the loop
    // warns instead of the "compacting history…" status silently no-opping.
    expect(result).toMatchObject({
      folded: false,
      beforeMessages,
      afterMessages: beforeMessages,
      summaryChars: 0,
    });
    expect(result.error).toMatch(/timed out/i);
    expect(loop.log.length).toBe(beforeMessages);
  });

  it("ignores a turn abort — the fold still runs until its scaled deadline", async () => {
    vi.useFakeTimers();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: abortableNeverFetch() });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    const beforeMessages = loop.log.length;

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    // Esc / Stop mid-fold: compaction is non-interruptible by design, so the
    // turn abort must NOT cancel the summarizer — only the scaled deadline
    // can end it (and fail it open with a visible reason).
    loop.abort();
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS + 1_000);

    const result = await resultPromise;
    expect(result).toMatchObject({
      folded: false,
      beforeMessages,
      afterMessages: beforeMessages,
      summaryChars: 0,
      error: "summary request timed out",
    });
    expect(loop.log.length).toBe(beforeMessages);
  });

  it("commits the fold even when the turn was aborted while summarizing", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        // Let the abort land before the summary response arrives.
        await Promise.resolve();
        return okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    loop.abort(); // Esc arrives mid-summary — must not cancel the request.

    const result = await resultPromise;
    expect(result.folded).toBe(true);
    // The folded log is committed even though the turn was aborted.
    expect(loop.log.entries[0]?.content).toContain("SUMMARY");
    expect(loop.log.length).toBeLessThan(13);
  });

  it("protectActiveExchange keeps the last user→assistant exchange in the tail when tool results blow the budget", async () => {
    // Post-response fold runs AFTER dispatch: the log ends with a COMPLETED
    // exchange [user, assistant(tool_calls), tool(result)]. A large result can
    // blow the tail budget before the walk reaches the user message — without
    // protectActiveExchange the whole exchange (including the read result)
    // lands in the summarized head and the model never sees the read.
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
    loop.log.append({ role: "user", content: "read src/loop.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    // Completed read result (~200 tokens) — far past the 40-token tail budget.
    loop.log.append({
      role: "tool",
      tool_call_id: "call-1",
      name: "read_file",
      content: "y".repeat(800),
    });

    // Without the flag the boundary stays at all.length → everything (including
    // the active exchange) collapses into the summary.
    const unguarded = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(unguarded.folded).toBe(true);
    expect(unguarded.afterMessages).toBe(1);

    // Rebuild the same log for the guarded fold.
    loop.log.compactInPlace([]);
    seedTurns(loop, 6);
    loop.log.append({ role: "user", content: "read src/loop.ts" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "call-1",
      name: "read_file",
      content: "y".repeat(800),
    });

    const beforeMessages = loop.log.length;
    const guarded = await loop.compactHistory({
      keepRecentTokens: 40,
      protectActiveExchange: true,
    });
    expect(guarded.folded).toBe(true);
    // The fold counts the whole log — the guard keeps the active exchange in
    // the tail instead of dropping it (and the read result) into the summary.
    expect(guarded.beforeMessages).toBe(beforeMessages);
    expect(guarded.afterMessages).toBeLessThan(beforeMessages);
    const msgs = loop.log.entries;
    expect(msgs[0]?.content).toContain("SUMMARY");
    // The active exchange survives into the tail — the model still sees the read.
    const tail = msgs.slice(1);
    const parent = tail.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length === 1,
    );
    expect(parent).toBeDefined();
    expect(tail.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect((tail.at(-1) as { content: string }).content).toBe("y".repeat(800));
  });

  it("refuses to clobber a log that was replaced while the summary was in flight", async () => {
    const replacement = { role: "user" as const, content: "replacement log" };
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        // A concurrent compaction / clear swapped the log array mid-fold.
        loop.log.compactInPlace([replacement]);
        return okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });

    // The fold refuses to apply rather than resurrect the snapshot head.
    expect(result.folded).toBe(false);
    expect(result.error).toMatch(/rewritten while compaction/i);
    expect(loop.log.entries).toEqual([replacement]);
  });
});
