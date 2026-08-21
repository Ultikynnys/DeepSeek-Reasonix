/** GPT-5.6 (OpenAI) payload compatibility — reasoning field, error prefixes, no DeepSeek-only fields. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function sseFetch(events: string[]): typeof fetch {
  return vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) controller.enqueue(new TextEncoder().encode(ev));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("DeepSeekClient with OpenAI GPT-5.6 payloads", () => {
  it("streams OpenAI's delta.reasoning as reasoningDelta", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetch: sseFetch([
        'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"ing hard"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const chunks: any[] = [];
    for await (const c of client.stream({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    const reasoning = chunks
      .map((c) => c.reasoningDelta)
      .filter(Boolean)
      .join("");
    expect(reasoning).toBe("thinking hard");
    expect(chunks.some((c) => c.contentDelta === "answer")).toBe(true);
  });

  it("still streams DeepSeek's delta.reasoning_content", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch: sseFetch([
        'data: {"choices":[{"delta":{"reasoning_content":"ds think"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const chunks: any[] = [];
    for await (const c of client.stream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    expect(
      chunks
        .map((c) => c.reasoningDelta)
        .filter(Boolean)
        .join(""),
    ).toBe("ds think");
  });

  it("non-streaming chat() reads message.reasoning", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetch: jsonFetch(200, {
        choices: [{ message: { content: "ok", reasoning: "inner monologue" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const resp = await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.reasoningContent).toBe("inner monologue");
    expect(resp.content).toBe("ok");
  });

  it("prefixes errors Upstream on OpenAI hosts, DeepSeek on deepseek hosts", async () => {
    const openai = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetch: jsonFetch(401, { error: { message: "invalid api key" } }),
      retry: { maxAttempts: 1 },
    });
    await expect(
      openai.chat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/^Upstream 401:/);

    const ds = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch: jsonFetch(401, { error: { message: "bad key" } }),
      retry: { maxAttempts: 1 },
    });
    await expect(
      ds.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/^DeepSeek 401:/);
  });

  it("never sends extra_body.thinking for gpt models, still sends it for deepseek", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetch: spy as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
      reasoningEffort: "xhigh",
    });
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.extra_body).toBeUndefined();
    expect(body.reasoning_effort).toBe("xhigh");

    const dsClient = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch: spy as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await dsClient.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
    });
    const [, init2] = spy.mock.calls[1]!;
    const body2 = JSON.parse(String(init2!.body)) as Record<string, unknown>;
    expect(body2.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("sends parallel_tool_calls:false for gpt models, never for deepseek", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetch: spy as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);

    const dsClient = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch: spy as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await dsClient.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    const [, init2] = spy.mock.calls[1]!;
    const body2 = JSON.parse(String(init2!.body)) as Record<string, unknown>;
    expect(body2.store).toBeUndefined();
    expect(body2.parallel_tool_calls).toBeUndefined();
  });

  it("apiKeyResolver supplies the per-request Authorization when no static key exists", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const resolver = vi.fn(async () => "oauth-token-1");
    const client = new DeepSeekClient({
      baseUrl: "https://api.openai.com/v1",
      fetch: spy as unknown as typeof fetch,
      apiKeyResolver: resolver,
    });
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    const [, init] = spy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer oauth-token-1");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("apiKeyResolver falling back to undefined uses the static key", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-static",
      baseUrl: "https://api.openai.com/v1",
      fetch: spy as unknown as typeof fetch,
      apiKeyResolver: async () => undefined,
    });
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    const [, init] = spy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-static");
  });

  it("constructor still throws without a key and without a resolver", () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: restore exact env state
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => new DeepSeekClient({ baseUrl: "https://api.openai.com/v1" })).toThrow(
        /No API key/,
      );
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: restore exact env state
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = prev;
      }
    }
  });
});
