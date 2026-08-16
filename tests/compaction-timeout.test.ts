/** Compaction model-call deadlines: forced summary + fold triage settle even when the upstream hangs. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { ContextManager, FILE_TRIAGE_TIMEOUT_MS } from "../src/context-manager.js";
import { COMPACTION_RETRY_DELAY_MS } from "../src/loop/compaction-retry.js";
import { type ForceSummaryContext, forceSummaryAfterIterLimit } from "../src/loop/force-summary.js";
import type { LoopEvent } from "../src/loop/types.js";
import { AppendOnlyLog } from "../src/memory/runtime.js";
import { SessionStats } from "../src/telemetry/stats.js";
import type { ChatMessage } from "../src/types.js";

/** Fetch that NEVER settles and ignores abort — the worst-case hung connection. */
function hangForeverFetch(): typeof fetch {
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

function summaryJsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, reasoning_content: null },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 50,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("compaction model-call deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forceSummaryAfterIterLimit settles with an error when the summary call hangs", async () => {
    vi.useFakeTimers();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: hangForeverFetch() });
    const ctx: ForceSummaryContext = {
      client,
      buildMessages: () => [{ role: "user", content: "do the thing" }],
      replaceLog: vi.fn(),
      // Never reached on the timeout path — only needed to satisfy the type.
      recordStats: (() => ({})) as unknown as ForceSummaryContext["recordStats"],
      turn: 1,
      model: "deepseek-v4-flash",
      getSystemPrompt: () => "system",
    };

    const gen = forceSummaryAfterIterLimit(ctx, { reason: "context-guard" });
    // Status card first — the loop shows "summarizing…" while the call runs.
    expect((await gen.next()).value).toMatchObject({ role: "status" });

    const next = gen.next();
    // Tiny context → base deadline (~15s), well under the 30s advance.
    await vi.advanceTimersByTimeAsync(30_000);
    const errorEv = await next;
    expect(errorEv.done).toBe(false);
    const ev = errorEv.value as LoopEvent & { error?: string; errorDetail?: { name?: string } };
    expect(ev.role).toBe("error");
    expect(ev.errorDetail?.name).toBe("ForceSummaryFailed");
    expect(ev.error).toContain("timed out");

    // The loop gets its done event and the turn can continue instead of
    // freezing until the client's 11-minute socket cap.
    const doneEv = await gen.next();
    expect((doneEv.value as LoopEvent).role).toBe("done");
    const ret = await gen.next();
    expect(ret.value).toBe("");
    expect(ret.done).toBe(true);
  });

  it("retries a forced summary after a transient provider body drop", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("provider connection reset"));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return summaryJsonResponse("recovered forced summary");
      }),
    });
    const ctx: ForceSummaryContext = {
      client,
      buildMessages: () => [{ role: "user", content: "do the thing" }],
      replaceLog: vi.fn(),
      recordStats: (() => ({})) as unknown as ForceSummaryContext["recordStats"],
      turn: 1,
      model: "deepseek-v4-flash",
      getSystemPrompt: () => "system",
    };

    const gen = forceSummaryAfterIterLimit(ctx, { reason: "context-guard" });
    expect((await gen.next()).value).toMatchObject({ role: "status" });
    const pending = gen.next();
    await vi.advanceTimersByTimeAsync(COMPACTION_RETRY_DELAY_MS);
    const final = await pending;

    expect(final.value).toMatchObject({
      role: "assistant_final",
      content: expect.stringContaining("recovered forced summary"),
    });
    expect(calls).toBe(2);
    expect((await gen.next()).value).toMatchObject({ role: "done" });
  });

  it("forceSummaryAfterIterLimit full-folds: replaceLog carries the marker, summary, and pinned constraints", async () => {
    const replaceLog = vi.fn();
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () =>
        summaryJsonResponse("Earlier turns explored auth; objective: ship the refactor."),
      ) as unknown as typeof fetch,
    });
    const ctx: ForceSummaryContext = {
      client,
      buildMessages: () => [{ role: "user", content: "ship the refactor" }],
      replaceLog,
      recordStats: (() => ({})) as unknown as ForceSummaryContext["recordStats"],
      turn: 1,
      model: "deepseek-v4-flash",
      getSystemPrompt: () =>
        "# HIGH PRIORITY constraints (must observe)\n\nNever launch Blender.\n\n# User memory\n\nDo not publish without review.\n",
    };

    const events: LoopEvent[] = [];
    for await (const ev of forceSummaryAfterIterLimit(ctx, { reason: "context-guard" })) {
      events.push(ev);
    }

    expect(events.some((e) => e.role === "assistant_final")).toBe(true);
    expect(replaceLog).toHaveBeenCalledTimes(1);
    const committed = replaceLog.mock.calls[0]![0] as ChatMessage;
    const text = typeof committed.content === "string" ? committed.content : "";
    // Marker → the summary renders as a compaction recap, not a fresh answer.
    expect(text).toContain("CONVERSATION HISTORY SUMMARY");
    expect(text).toContain("ship the refactor");
    // Pinned constraints survive the full fold verbatim.
    expect(text).toContain("Never launch Blender");
    expect(text).toContain("[PINNED CONSTRAINTS — preserved verbatim]");
  });

  it("fold completes fail-open when the file-triage call hangs past its deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Call #1 = fold summarizer → resolves; call #2 = file triage → hangs
      // forever, ignoring abort. The fold must still commit (fail-open).
      if (calls === 1) return summaryJsonResponse("Earlier turns explored topic X.");
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fetchMock });

    const log = new AppendOnlyLog();
    const big =
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
        40,
      );
    log.append({ role: "user", content: big });
    log.append({ role: "assistant", content: big });
    // A file-path tool call so the fold's triage step actually runs.
    log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "src/foo.ts" }) },
        },
      ],
    });
    log.append({ role: "tool", tool_call_id: "t1", content: "file contents" });
    log.append({ role: "user", content: "keep going" });
    log.append({ role: "assistant", content: big });

    const cm = new ContextManager({
      client,
      log,
      stats: new SessionStats(),
      sessionName: null,
      getCurrentTurn: () => 0,
      getSystemPrompt: () => "system",
    });

    const pending = cm.fold("test-model", { keepRecentTokens: 500 });
    await vi.advanceTimersByTimeAsync(FILE_TRIAGE_TIMEOUT_MS + 100);
    const result = await pending;

    // The triage hang must not stall the fold: it commits with zero drops.
    expect(calls).toBe(2);
    expect(result.folded).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.droppedFiles).toBeUndefined();
    expect(log.length).toBe(1);
  });
});
