/** Codex backend (ChatGPT plan quota) transport — the endpoint speaks the OpenAI Responses API: payloads convert messages→input, responses parse from envelopes / SSE events (400 "Unsupported parameter: messages"). */
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type ResolvedTransport } from "../src/client.js";

const CODEX_TRANSPORT: ResolvedTransport = {
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  headers: { Authorization: "Bearer oauth", "ChatGPT-Account-Id": "acct-1" },
  api: "responses",
};

function codexClient(fetch: typeof fetch): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://api.openai.com/v1",
    fetch,
    transportResolver: async () => CODEX_TRANSPORT,
    retry: { maxAttempts: 1 },
  });
}

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

describe("Responses payload conversion (codex backend)", () => {
  it("sends input/instructions/flat tools/reasoning.effort — never chat-completions fields", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = codexClient(spy as unknown as typeof fetch);
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "hi" },
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
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
        { role: "user", content: "thanks" },
      ],
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
      reasoningEffort: "high",
      maxTokens: 500,
      temperature: 0.2,
      thinking: "enabled",
    });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(CODEX_TRANSPORT.endpoint);
    expect((init!.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe("acct-1");
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.messages).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("you are a coding agent");
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        // gpt-* models must not burst parallel tool calls — one call per
        // response so the loop feeds each result back before the next round.
        parallel_tool_calls: false,
      },
    ]);
    expect(body.input).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
      { type: "message", role: "user", content: "thanks" },
    ]);
  });

  it("maps image parts to input_image with a bare URL string", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = codexClient(spy as unknown as typeof fetch);
    await client.chat({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } },
          ],
        },
      ],
    });
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
        ],
      },
    ]);
  });

  it("keeps chat-completions payloads for non-responses transports (DeepSeek regression)", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch: spy as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
    });
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.input).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.extra_body).toEqual({ thinking: { type: "enabled" } });
  });
});

describe("Responses chat() → internal streaming (Codex requires stream:true)", () => {
  it("collects streamed output into a ChatResponse: text, reasoning, tool calls, usage", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"edit_file","arguments":""}}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking about it"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"the answer"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"edit_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40}}}}\n\n',
      ]),
    );
    const resp = await client.chat({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.content).toBe("the answer");
    expect(resp.reasoningContent).toBe("thinking about it");
    expect(resp.toolCalls).toEqual([
      {
        id: "call_9",
        type: "function",
        function: { name: "edit_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(resp.usage.promptTokens).toBe(100);
    expect(resp.usage.completionTokens).toBe(20);
    expect(resp.usage.totalTokens).toBe(120);
    expect(resp.usage.promptCacheHitTokens).toBe(40);
  });

  it("throws a formatted error on response.failed", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.failed","code":"invalid_prompt","message":"quota exceeded"}\n\n',
      ]),
    );
    await expect(
      client.chat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/^OpenAI 400: quota exceeded/);
  });
});

describe("Responses streaming", () => {
  it("maps output_text / reasoning_summary_text deltas, tool-call deltas and completed usage", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.created"}\n\n',
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":""}}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"let me check"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"looking"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" up"}\n\n',
        'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55,"input_tokens_details":{"cached_tokens":10}}}}\n\n',
      ]),
    );
    const chunks: any[] = [];
    for await (const c of client.stream({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    const text = chunks
      .map((c) => c.contentDelta)
      .filter(Boolean)
      .join("");
    expect(text).toBe("looking up");
    expect(
      chunks
        .map((c) => c.reasoningDelta)
        .filter(Boolean)
        .join(""),
    ).toBe("let me check");
    // Tool calls arrive as a name-bearing `.added` chunk plus argument deltas
    // — accumulate exactly like the loop consumer does.
    const tcs = chunks.map((c) => c.toolCallDelta).filter(Boolean);
    expect(tcs[0]).toMatchObject({ index: 1, id: "call_1", name: "read_file" });
    expect(tcs.map((t) => t.argumentsDelta ?? "").join("")).toBe('{"path":"a.ts"}');
    const last = chunks.at(-1);
    expect(last?.usage?.promptTokens).toBe(50);
    expect(last?.usage?.promptCacheHitTokens).toBe(10);
    expect(last?.finishReason).toBe("stop");
  });

  it("falls back to the output_item.done snapshot when no argument deltas arrive", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_2","name":"search","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]),
    );
    const chunks: any[] = [];
    for await (const c of client.stream({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    expect(chunks.find((c) => c.toolCallDelta)?.toolCallDelta).toEqual({
      index: 0,
      id: "call_2",
      name: "search",
      argumentsDelta: '{"q":"x"}',
    });
  });

  it("throws the nested provider error on response.failed", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.failed","response":{"error":{"code":"invalid_prompt","message":"prompt is not allowed"}}}\n\n',
      ]),
    );
    const chunks: any[] = [];
    await expect(async () => {
      for await (const c of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
    }).rejects.toThrow(/^OpenAI 400: prompt is not allowed \(invalid_prompt\)$/);
    expect(chunks.some((c) => c.contentDelta === "partial")).toBe(true);
  });

  it.each([
    [
      "top-level compatibility",
      { code: "invalid_prompt", message: "legacy failure" },
      "OpenAI 400: legacy failure (invalid_prompt)",
    ],
    [
      "nested message only",
      { response: { error: { message: "model unavailable" } } },
      "OpenAI 400: model unavailable",
    ],
    ["malformed nested error", { response: { error: "unknown" } }, "OpenAI 400: response failed"],
  ])("formats %s response.failed details", async (_name, failure, expected) => {
    const client = codexClient(
      sseFetch([`data: ${JSON.stringify({ type: "response.failed", ...failure })}\n\n`]),
    );

    await expect(async () => {
      for await (const _chunk of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // Consume the stream so its terminal failure is raised.
      }
    }).rejects.toThrow(expected);
  });

  it("marks incomplete streams with finishReason incomplete", async () => {
    const client = codexClient(
      sseFetch([
        'data: {"type":"response.incomplete"}\n\n',
        'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n',
      ]),
    );
    const chunks: any[] = [];
    for await (const c of client.stream({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.finishReason).map((c) => c.finishReason)).toEqual([
      "incomplete",
      "incomplete",
    ]);
  });
});
