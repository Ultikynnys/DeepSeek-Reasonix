import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import {
  HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS,
  HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS,
  HISTORY_FOLD_SUMMARY_TIMEOUT_MS,
} from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  neverResolvingFetch as abortableNeverFetch,
  jsonOkResponse as okJsonResponse,
} from "./support/fake-client.js";

function serviceUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function seedTurns(loop: CacheFirstLoop, n: number): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({
      role: "user",
      content: `question ${i}: ${"context padding for fold timeout regression ".repeat(8)}`,
    });
    loop.log.append({
      role: "assistant",
      content: `answer ${i}: ${"more context padding for fold timeout regression ".repeat(8)}`,
    });
  }
}

describe("ContextManager fold timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails open when the summary request hangs", async () => {
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
    // The deadline is scaled by head size; advancing past the ceiling is
    // guaranteed to fire the fold timeout regardless of how large the head is.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS + 1_000);

    const result = await Promise.race([resultPromise, Promise.resolve("still-pending" as const)]);
    expect(result).not.toBe("still-pending");
    expect(result).toMatchObject({
      folded: false,
      beforeMessages,
      afterMessages: beforeMessages,
      summaryChars: 0,
      error: "summary request timed out",
    });
    expect(loop.log.length).toBe(beforeMessages);
  });

  it("scales the deadline with head size — a large log is not killed at the base timeout", async () => {
    vi.useFakeTimers();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: abortableNeverFetch() });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    // 30 turns × ~450 tokens/message → ~27k total tokens, so the head alone
    // pushes the scaled deadline well past the 15s base (≈ 15s + 13k × 0.5ms).
    const pad = "context padding for fold timeout regression ".repeat(40);
    for (let i = 0; i < 30; i++) {
      loop.log.append({ role: "user", content: `question ${i}: ${pad}` });
      loop.log.append({ role: "assistant", content: `answer ${i}: ${pad}` });
    }
    const beforeMessages = loop.log.length;

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });

    // At the old fixed 15s deadline the request would already have been killed.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_TIMEOUT_MS);
    expect(await Promise.race([resultPromise, Promise.resolve("still-pending" as const)])).toBe(
      "still-pending",
    );

    // Once the scaled deadline elapses the fold still fails open.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS);
    const result = await Promise.race([resultPromise, Promise.resolve("still-pending" as const)]);
    expect(result).not.toBe("still-pending");
    expect(result).toMatchObject({
      folded: false,
      beforeMessages,
      afterMessages: beforeMessages,
      summaryChars: 0,
      error: "summary request timed out",
    });
  });

  it("retries a retryable 503 once and folds successfully when the service recovers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        calls++;
        // First chat() call: all 4 client-level attempts hit the outage.
        // Fold attempt 2's chat() succeeds on its first fetch.
        return calls <= 4
          ? serviceUnavailableResponse()
          : okJsonResponse({
              choices: [{ message: { content: "SUMMARY of the conversation so far" } }],
            });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    const beforeMessages = loop.log.length;

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    // Attempt 1 exhausts the client's internal 4× backoff retries and fails fast;
    // the fold is now in its 30s retry pause. Advance most of the pause — the
    // scaled deadline (base + head×1ms) has ample headroom over it.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS - 1_000);
    expect(await Promise.race([resultPromise, Promise.resolve("still-pending" as const)])).toBe(
      "still-pending",
    );
    // The 30s retry pause elapses; attempt 2 succeeds immediately.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS);
    const result = await Promise.race([resultPromise, Promise.resolve("still-pending" as const)]);
    expect(result).not.toBe("still-pending");
    expect(result).toMatchObject({
      folded: true,
      beforeMessages,
      summaryChars: 34,
    });
    expect(loop.log.length).toBeLessThan(beforeMessages);
    expect(calls).toBe(5);
  });

  it("retries a response-body drop after the provider returns headers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("connection reset by peer"));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return okJsonResponse({
          choices: [{ message: { content: "SUMMARY after provider recovery" } }],
        });
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS);
    const result = await resultPromise;

    expect(result.folded).toBe(true);
    expect(result.summary).toBe("SUMMARY after provider recovery");
    expect(calls).toBe(2);
  });

  it("gives up with the 503 error after the automatic retry when the outage persists", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        calls++;
        return serviceUnavailableResponse();
      }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedTurns(loop, 6);
    const beforeMessages = loop.log.length;

    const resultPromise = loop.compactHistory({ keepRecentTokens: 40 });
    // Attempt 1 fails fast; the fold is now in its 30s retry pause — advance most
    // of the pause, not the deadline base, so the assertion holds at any base.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS - 1_000);
    expect(await Promise.race([resultPromise, Promise.resolve("still-pending" as const)])).toBe(
      "still-pending",
    );
    // Pause elapses and attempt 2 also exhausts the client's retries.
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS);
    const result = await Promise.race([resultPromise, Promise.resolve("still-pending" as const)]);
    expect(result).not.toBe("still-pending");
    expect(result).toMatchObject({
      folded: false,
      beforeMessages,
      afterMessages: beforeMessages,
      summaryChars: 0,
    });
    expect((result as { error?: string }).error).toMatch(/503/);
    expect(calls).toBe(8);
  });
});
