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

  it("stays silent (no error) when the turn aborts during the fold", async () => {
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: abortableNeverFetch() });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    loop.abort();
    const result = await resultPromise;

    // Esc aborts the turn — the abort path owns the messaging, so a fold
    // interrupted by it must not surface a spurious compaction warning.
    expect(result.folded).toBe(false);
    expect(result.error).toBeUndefined();
  });
});
