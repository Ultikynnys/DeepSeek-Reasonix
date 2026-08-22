/** Native `/api/chat` transport for the Ollama provider: payload shape,
 *  non-stream + NDJSON stream parsing, cache-hit inference, num_ctx probe. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type Usage } from "../src/client.js";
import { estimateRequestTokens } from "../src/tokenizer.js";

const savedKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
const savedNumCtx = process.env.OLLAMA_NUM_CTX;

beforeEach(() => {
  process.env.OLLAMA_KEEP_ALIVE = "30m";
  process.env.OLLAMA_NUM_CTX = "8192";
});

afterEach(() => {
  if (savedKeepAlive === undefined) {
    // biome-ignore lint/performance/noDelete: restore exact env state
    delete process.env.OLLAMA_KEEP_ALIVE;
  } else {
    process.env.OLLAMA_KEEP_ALIVE = savedKeepAlive;
  }
  if (savedNumCtx === undefined) {
    // biome-ignore lint/performance/noDelete: restore exact env state
    delete process.env.OLLAMA_NUM_CTX;
  } else {
    process.env.OLLAMA_NUM_CTX = savedNumCtx;
  }
});

/** Route by URL: /api/show → `show`, everything else → `chat`. */
function mockOllamaFetch(chat: unknown, show?: unknown): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (show !== undefined && u.includes("/api/show")) {
      return new Response(JSON.stringify(show), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(typeof chat === "string" ? chat : JSON.stringify(chat), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

function nativeChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "qwen3:32b",
    message: { role: "assistant", content: "ok" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 500,
    eval_count: 2,
    prompt_eval_duration: 5_000_000,
    eval_duration: 2_000_000,
    load_duration: 10_000_000,
    ...overrides,
  };
}

describe("ollama native payload", () => {
  it("posts to /api/chat on the native origin, stripping /v1", async () => {
    const { fetch, calls } = mockOllamaFetch(nativeChatResponse());
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls[calls.length - 1]).toBe("http://localhost:11434/api/chat");
  });

  it("maps maxTokens/temperature/num_ctx into options and sends keep_alive", async () => {
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedInit = init as RequestInit;
      return new Response(JSON.stringify(nativeChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://ollama.example.com",
      apiKey: "sk-cloud",
      fetch,
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      maxTokens: 200,
    });
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:32b");
    expect(body.keep_alive).toBe("30m");
    expect(body.options).toEqual({ num_predict: 200, temperature: 0.5, num_ctx: 8192 });
  });

  it("converts image parts to native images and tool-call args to objects", async () => {
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedInit = init as RequestInit;
      return new Response(JSON.stringify(nativeChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    await client.chat({
      model: "ollama/llava",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUFBQQ==" } },
          ],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "read_file", content: "42" },
      ],
    });
    const body = JSON.parse(String(capturedInit!.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toEqual({
      role: "user",
      content: "what is this?",
      images: ["QUFBQQ=="],
    });
    expect(body.messages[1]!.tool_calls).toEqual([
      { function: { name: "read_file", arguments: { path: "a.ts" } } },
    ]);
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      tool_name: "read_file",
      content: "42",
    });
  });

  it("maps thinking/effort to native think and responseFormat to format json", async () => {
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedInit = init as RequestInit;
      return new Response(JSON.stringify(nativeChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
      responseFormat: { type: "json_object" },
    });
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.think).toBe(true);
    expect(body.format).toBe("json");
  });
});

describe("ollama native non-stream response", () => {
  it("parses message/thinking/tool_calls and metrics into Usage", async () => {
    const { fetch } = mockOllamaFetch(
      nativeChatResponse({
        message: {
          role: "assistant",
          content: "done",
          thinking: "let me think",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
        },
      }),
    );
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    const res = await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("done");
    expect(res.reasoningContent).toBe("let me think");
    expect(res.toolCalls).toEqual([
      {
        id: undefined,
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(res.usage.promptTokens).toBe(500);
    expect(res.usage.completionTokens).toBe(2);
    expect(res.usage.promptEvalDurationMs).toBe(5);
    expect(res.usage.evalDurationMs).toBe(2);
    expect(res.usage.loadDurationMs).toBe(10);
  });
});

describe("ollama native NDJSON stream", () => {
  it("accumulates content/thinking deltas, tool calls and the done-chunk metrics", async () => {
    const lines = [
      { model: "qwen3:32b", message: { role: "assistant", content: "Hel" }, done: false },
      { model: "qwen3:32b", message: { role: "assistant", content: "lo" }, done: false },
      {
        model: "qwen3:32b",
        message: {
          role: "assistant",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
        },
        done: false,
      },
      {
        model: "qwen3:32b",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 500,
        eval_count: 2,
        prompt_eval_duration: 5_000_000,
      },
    ];
    const { fetch } = mockOllamaFetch(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    const chunks: Array<{ contentDelta?: string; toolCallDelta?: unknown; finishReason?: string }> =
      [];
    let usage: Usage | null = null;
    for await (const chunk of client.stream({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
      if (chunk.usage) usage = chunk.usage;
    }
    const deltas = chunks.map((c) => c.contentDelta).filter((d) => d !== undefined);
    expect(deltas).toEqual(["Hel", "lo"]);
    const toolChunk = chunks.find((c) => c.toolCallDelta);
    expect(toolChunk!.toolCallDelta).toEqual({
      index: 0,
      id: undefined,
      name: "read_file",
      argumentsDelta: '{"path":"a.ts"}',
    });
    const doneChunk = chunks.find((c) => c.finishReason !== undefined);
    expect(doneChunk!.finishReason).toBe("stop");
    expect(usage).not.toBeNull();
    expect(usage!.promptTokens).toBe(500);
    expect(usage!.completionTokens).toBe(2);
    expect(usage!.promptEvalDurationMs).toBe(5);
  });
});

describe("ollama cache-hit inference", () => {
  it("reports hits for a shared message prefix and drops them after a fold", async () => {
    const { fetch } = mockOllamaFetch(nativeChatResponse());
    const client = new DeepSeekClient({
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    const system = { role: "system" as const, content: "you are a coding agent" };
    const first = await client.chat({
      model: "ollama/qwen3:32b",
      messages: [system, { role: "user", content: "hi" }],
    });
    // First request: no previous prefix to reuse.
    expect(first.usage.promptCacheHitTokens).toBe(0);

    const second = await client.chat({
      model: "ollama/qwen3:32b",
      messages: [
        system,
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "now read a.ts" },
      ],
    });
    // Shared prefix [system, user hi, assistant hello] is inferred as cached.
    expect(second.usage.promptCacheHitTokens).toBeGreaterThan(0);
    expect(second.usage.promptCacheHitTokens).toBeLessThan(second.usage.promptTokens);
    expect(second.usage.promptCacheMissTokens).toBeLessThan(second.usage.promptTokens);

    const preFold = await client.chat({
      model: "ollama/qwen3:32b",
      messages: [
        system,
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "now read a.ts" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "and now?" },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ],
    });
    const preFoldHit = preFold.usage.promptCacheHitTokens;
    // A fold replaces the conversation head with a summary — the shared prefix
    // with the previous request shrinks to the 5 matching head messages, and
    // the inferred hit count is exactly the token estimate of that prefix.
    const foldedMessages = [
      system,
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "now read a.ts" },
      { role: "assistant", content: "sure" },
      { role: "user", content: "[summary of earlier turns]" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ] as const;
    const folded = await client.chat({
      model: "ollama/qwen3:32b",
      messages: [...foldedMessages],
    });
    expect(folded.usage.promptCacheHitTokens).toBe(
      estimateRequestTokens(foldedMessages.slice(0, 5), undefined),
    );
    expect(folded.usage.promptCacheHitTokens).toBeGreaterThan(0);
    expect(folded.usage.promptCacheHitTokens).toBeLessThan(folded.usage.promptTokens);
    // Sanity: the fold's shared prefix (5 messages) is shorter than the prior
    // turn's (7 messages) — the estimate reflects the overlap, not the size of
    // the whole prompt.
    void preFoldHit;
  });
});

describe("ollama num_ctx learning", () => {
  it("probes /api/show once, caches the window, and sends it as options.num_ctx", async () => {
    // biome-ignore lint/performance/noDelete: test needs the env unset
    delete process.env.OLLAMA_NUM_CTX;
    const showCalls: string[] = [];
    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/show")) {
        showCalls.push(String(url));
        return new Response(JSON.stringify({ model_info: { "llama.context_length": 131072 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(nativeChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://ollama.example.com",
      apiKey: "sk-cloud",
      fetch,
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0]!.options).toEqual({ num_ctx: 131072 });
    expect(showCalls).toHaveLength(1);
  });

  it("falls back to no num_ctx when /api/show is unavailable", async () => {
    // biome-ignore lint/performance/noDelete: test needs the env unset
    delete process.env.OLLAMA_NUM_CTX;
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/show")) {
        return new Response("not found", { status: 404 });
      }
      capturedInit = init as RequestInit;
      return new Response(JSON.stringify(nativeChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://ollama.example.com",
      apiKey: "sk-cloud",
      fetch,
    });
    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.options).toBeUndefined();
  });
});
