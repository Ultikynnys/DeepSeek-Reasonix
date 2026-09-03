import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function makeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("DeepSeekClient.listModels", () => {
  it("parses the OpenAI-style model list", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: makeFetch(200, {
        object: "list",
        data: [
          { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
          { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
        ],
      }),
    });
    const list = await client.listModels();
    expect(list).not.toBeNull();
    expect(list!.data.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("returns null on non-2xx (bad key / offline)", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-bad",
      fetch: makeFetch(401, { error: "unauthorized" }),
    });
    expect(await client.listModels()).toBeNull();
  });

  it("returns null on malformed payload", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: makeFetch(200, { whatever: "not a list" }),
    });
    expect(await client.listModels()).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await client.listModels()).toBeNull();
  });

  it("sends the bearer token header", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-xyz",
      fetch: spy as unknown as typeof fetch,
    });
    await client.listModels();
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("GET");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-xyz");
  });
});

describe("DeepSeekClient rateLimit", () => {
  it("waits between chat requests when rpm is configured", async () => {
    vi.useFakeTimers();
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: spy as unknown as typeof fetch,
      rateLimit: { rpm: 30 },
    });
    try {
      await client.chat({ model: "deepseek-chat", messages: [] });
      const second = client.chat({ model: "deepseek-chat", messages: [] });
      await Promise.resolve();
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DeepSeekClient usage parsing", () => {
  it("parses Ollama native top-level token metrics", async () => {
    const client = new DeepSeekClient({
      apiKey: "ollama",
      fetch: makeFetch(200, {
        model: "gpt-oss:20b",
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 42,
        eval_count: 7,
      }),
    });
    const resp = await client.chat({ model: "gpt-oss:20b", messages: [] });
    expect(resp.usage.promptTokens).toBe(42);
    expect(resp.usage.completionTokens).toBe(7);
    expect(resp.usage.totalTokens).toBe(49);
    expect(resp.usage.promptCacheMissTokens).toBe(42);
  });

  it("requests usage metadata for streaming calls", async () => {
    let body: { stream_options?: unknown } | null = null;
    const fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body)) as { stream_options?: unknown };
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch });

    const chunks = [];
    for await (const chunk of client.stream({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(chunks.at(-1)?.usage?.promptTokens).toBe(10);
    expect(chunks.at(-1)?.usage?.promptCacheMissTokens).toBe(10);
  });
});

describe("DeepSeekClient request serialization", () => {
  it("replaces lone UTF-16 surrogates before sending JSON", async () => {
    let sentBody = "";
    const spy = vi.fn(async (_url: unknown, init: unknown) => {
      sentBody = String((init as RequestInit).body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: spy as unknown as typeof fetch,
    });

    await client.chat({
      model: "deepseek-chat",
      messages: [{ role: "user", content: `bad ${String.fromCharCode(0xd800)} text` }],
    });

    expect(sentBody).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(JSON.parse(sentBody).messages[0].content).toBe("bad \uFFFD text");
  });
});

describe("DeepSeekClient ollama provider (keyless + prefix strip)", () => {
  it("allowMissingKey skips the no-key constructor throw", () => {
    expect(
      () => new DeepSeekClient({ baseUrl: "http://localhost:11434/v1", allowMissingKey: true }),
    ).not.toThrow();
  });

  it("without allowMissingKey the constructor still throws for a missing key", () => {
    // The runner env may carry DEEPSEEK_API_KEY — the fallback must not mask
    // the missing-key throw, so clear it for this assertion.
    const saved = process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: restore exact env state
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => new DeepSeekClient({ baseUrl: "http://localhost:11434/v1" })).toThrow(
        "No authentication configured for the resolved model endpoint",
      );
    } finally {
      if (saved === undefined) {
        // biome-ignore lint/performance/noDelete: restore exact env state
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = saved;
      }
    }
  });

  it("keyless chat omits the Authorization header, strips the ollama/ prefix, and hits the native /api/chat endpoint", async () => {
    const savedKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
    const savedNumCtx = process.env.OLLAMA_NUM_CTX;
    process.env.OLLAMA_KEEP_ALIVE = "30m";
    // biome-ignore lint/performance/noDelete: test needs the env unset
    delete process.env.OLLAMA_NUM_CTX;
    try {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init as RequestInit;
        return new Response(
          JSON.stringify({
            model: "llama3.1:latest",
            message: { role: "assistant", content: "hi" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 5,
            eval_count: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });

      const res = await client.chat({
        model: "ollama/llama3.1:latest",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(capturedUrl).toBe("http://localhost:11434/api/chat");
      expect(capturedInit!.headers).not.toHaveProperty("Authorization");
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      expect(body.model).toBe("llama3.1:latest");
      expect(body.keep_alive).toBe("30m");
      expect(body.options).toBeUndefined();
      expect(res.content).toBe("hi");
    } finally {
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
    }
  });

  it("a cloud key IS sent when configured, and ollama maps effort to think instead of DeepSeek fields", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init as RequestInit;
      return new Response(
        JSON.stringify({
          model: "qwen3:32b",
          message: { role: "assistant", content: "ok" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://ollama.example.com",
      apiKey: "sk-ollama-cloud",
      fetch,
    });

    await client.chat({
      model: "ollama/qwen3:32b",
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
      reasoningEffort: "high",
    });

    expect(capturedUrl).toBe("https://ollama.example.com/api/chat");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-ollama-cloud");
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:32b");
    expect(body.extra_body).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    // thinking wins over effort in the native `think` field.
    expect(body.think).toBe(true);
  });
});
