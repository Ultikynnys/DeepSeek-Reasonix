/** Model refusal / filter / empty-stop handling — the loop must explain stops, never fail silently. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, normalizeStopReason } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function chatBody(message: Record<string, unknown>, finishReason: string): unknown {
  return {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 0,
      total_tokens: 5,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 5,
    },
  };
}

describe("normalizeStopReason", () => {
  it("surfaces an explicit refusal string", () => {
    expect(normalizeStopReason({ refusal: "I can't help with that." })).toBe(
      "the model refused: I can't help with that.",
    );
  });

  it("maps refusal / safety / filter finish reasons case-insensitively", () => {
    expect(normalizeStopReason({ finishReason: "content_filter" })).toMatch(/content filter/);
    expect(normalizeStopReason({ finishReason: "SAFETY" })).toMatch(/safety/);
    expect(normalizeStopReason({ finishReason: "RECITATION" })).toMatch(/recitation/);
    expect(normalizeStopReason({ finishReason: "stop" })).toBeUndefined();
    expect(normalizeStopReason({})).toBeUndefined();
  });
});

describe("client.chat stop-reason wiring", () => {
  it("captures a chat-completions refusal field", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () =>
        jsonResponse(chatBody({ role: "assistant", content: null, refusal: "No." }, "stop")),
      ) as unknown as typeof fetch,
    });
    const resp = await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.content).toBe("");
    expect(resp.stopReason).toBe("the model refused: No.");
  });

  it("captures a content-filter finish reason", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () =>
        jsonResponse(chatBody({ role: "assistant", content: "" }, "content_filter")),
      ) as unknown as typeof fetch,
    });
    const resp = await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.stopReason).toMatch(/content filter/);
  });
});

describe("loop — a model that refuses to answer", () => {
  it("surfaces the stop reason instead of ending the turn silently", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () =>
        jsonResponse(chatBody({ role: "assistant", content: "" }, "content_filter")),
      ) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("do the thing")) events.push(ev);

    const giveUp = events.find(
      (ev) => ev.role === "warning" && ev.severity === "high" && /content filter/i.test(ev.content),
    );
    expect(giveUp).toBeDefined();
    // No answer was produced — the turn must not look like a success.
    expect(events.some((ev) => ev.role === "assistant_final")).toBe(false);
  });
});
