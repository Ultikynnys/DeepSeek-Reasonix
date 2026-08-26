/** Gemini provider (Antigravity/Cloud Code API): payload shape, wrapped
 *  response parsing, and SSE streaming. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

const auth = { accessToken: "google-token", projectId: "proj-123" };

function geminiClient(fetch: typeof fetch): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://cloudcode-pa.googleapis.com",
    allowMissingKey: true,
    geminiAuthResolver: async () => auth,
    fetch,
  });
}

function wrappedResponse(parts: unknown[], usage?: unknown): unknown {
  return {
    response: {
      candidates: [{ content: { parts }, finishReason: "STOP" }],
      usageMetadata: usage ?? {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gemini payload", () => {
  it("posts to /v1internal:generateContent with contents + systemInstruction + tools", async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(init?.body as string),
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response(JSON.stringify(wrappedResponse([{ text: "hi" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const res = await client.chat({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    expect(captured?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(captured?.headers.authorization).toBe("Bearer google-token");
    expect(captured?.headers["user-agent"]).toBe("antigravity");
    const body = captured?.body as {
      model: string;
      project: string;
      user_prompt_id: string;
      request: {
        contents: unknown[];
        systemInstruction: unknown;
        tools: unknown[];
        toolConfig: unknown;
      };
    };
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.project).toBe("proj-123");
    expect(body.user_prompt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.request.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.request.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "be brief" }],
    });
    expect(body.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(res.content).toBe("hi");
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(5);
  });

  it("wraps string and text-part tool outputs in structured function responses", async () => {
    const bodies: Array<{
      request: {
        contents: Array<{
          role: string;
          parts: Array<{
            functionResponse?: {
              name: string;
              response: unknown;
            };
          }>;
        }>;
      };
    }> = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = geminiClient(fetch);

    await client.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "tool", name: "list_directory", content: "a/\nb.txt" }],
    });
    await client.chat({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "tool",
          name: "read_file",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ],
    });

    expect(bodies[0]?.request.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_directory",
              response: { result: "a/\nb.txt" },
            },
          },
        ],
      },
    ]);
    expect(bodies[1]?.request.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "read_file",
              response: { result: "first\nsecond" },
            },
          },
        ],
      },
    ]);
  });

  it("echoes a Gemini thoughtSignature back on the function call", async () => {
    let captured: unknown = null;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = geminiClient(fetch);

    await client.chat({
      model: "gemini-3.1-flash-high",
      messages: [
        { role: "user", content: "use the tool" },
        {
          role: "assistant",
          tool_calls: [
            {
              function: { name: "read_file", arguments: '{"path":"/a"}' },
              thoughtSignature: "signature-abc-123",
            },
          ],
        },
      ],
    });

    const contents = (captured as { request: { contents: unknown[] } }).request.contents;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: { name: "read_file", args: { path: "/a" } },
          thoughtSignature: "signature-abc-123",
        },
      ],
    });
  });

  it("coalesces parallel tool responses into one user turn", async () => {
    let captured: unknown = null;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = geminiClient(fetch);

    await client.chat({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            { function: { name: "a", arguments: "{}" } },
            { function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", name: "a", tool_call_id: "", content: "ra" },
        { role: "tool", name: "b", tool_call_id: "", content: "rb" },
      ],
    });

    const contents = (captured as { request: { contents: unknown[] } }).request.contents;
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "a", args: {} } },
          { functionCall: { name: "b", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "a", response: { result: "ra" } } },
          { functionResponse: { name: "b", response: { result: "rb" } } },
        ],
      },
    ]);
  });

  it("skips user contents with zero parts", async () => {
    let captured: unknown = null;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = geminiClient(fetch);

    await client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "" }] });

    const contents = (captured as { request: { contents: unknown[] } }).request.contents;
    expect(contents).toEqual([]);
  });

  it("strips Gemini-incompatible JSON-Schema keywords from tool parameters", async () => {
    let captured: unknown = null;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = geminiClient(fetch);

    await client.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "mcp_tool",
            description: "d",
            parameters: {
              type: "object",
              $schema: "http://json-schema.org/draft-07/schema#",
              additionalProperties: false,
              oneOf: [{ type: "string" }],
              properties: {
                file: { type: "string", $ref: "#/$defs/x", pattern: "^[a-z]+$" },
                dir: { type: "object", items: { type: "string", anyOf: [{ type: "string" }] } },
              },
            },
          },
        },
      ],
    });

    const tools = (captured as { request: { tools: { functionDeclarations: unknown[] }[] } })
      .request.tools;
    expect(tools[0]?.functionDeclarations[0]).toEqual({
      name: "mcp_tool",
      description: "d",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", pattern: "^[a-z]+$" },
          dir: { type: "object", items: { type: "string" } },
        },
      },
    });
  });

  it("surfaces daily endpoint failures without gateway fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("unavailable", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;
    const client = geminiClient(fetch);

    await expect(
      client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("Upstream 503: unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
  });

  it("maps functionCall parts to ToolCall with JSON-stringified args", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify(wrappedResponse([{ functionCall: { name: "read", args: { path: "/a" } } }])),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const res = await client.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "read /a" }],
    });
    expect(res.toolCalls).toEqual([
      { type: "function", function: { name: "read", arguments: '{"path":"/a"}' } },
    ]);
  });

  it("captures the sibling thoughtSignature on a functionCall part", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify(
          wrappedResponse([
            {
              functionCall: { name: "read", args: { path: "/a" } },
              thoughtSignature: "sig-xyz",
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const res = await client.chat({
      model: "gemini-3.1-flash-high",
      messages: [{ role: "user", content: "read /a" }],
    });
    expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-xyz");
  });

  it("serializes image_url parts to inlineData for the vision API", async () => {
    let captured: { body: unknown } | null = null;
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = { body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify(wrappedResponse([{ text: "seen" }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const res = await client.chat({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
            },
          ],
        },
      ],
    });

    const body = captured?.body as {
      request: { contents: Array<{ role: string; parts: unknown[] }> };
    };
    expect(body.request.contents[0]?.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
    ]);
    expect(res.content).toBe("seen");
  });

  it("throws a clear error when not signed in", async () => {
    const client = new DeepSeekClient({
      baseUrl: "https://cloudcode-pa.googleapis.com",
      allowMissingKey: true,
      geminiAuthResolver: async () => null,
    });
    await expect(
      client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/Not signed in to Google Antigravity/);
  });

  it("surfaces SUBSCRIPTION_REQUIRED without retrying or downgrading the model", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            details: [{ reason: "SUBSCRIPTION_REQUIRED" }],
          },
        }),
        { status: 403 },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = geminiClient(fetch);

    await expect(
      client.chat({
        model: "claude-sonnet-4-6-thinking",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/licensed Gemini Code Assist access.*not downgraded or retried/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body.model).toBe("claude-sonnet-4-6-thinking");
  });

  it("does not send a request without a companion project", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://cloudcode-pa.googleapis.com",
      allowMissingKey: true,
      geminiAuthResolver: async () => ({ accessToken: "google-token" }),
      fetch,
    });

    await expect(
      client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/did not provide a companion project/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("gemini streaming", () => {
  it("parses SSE envelopes into content deltas and usage", async () => {
    const noUsage = (parts: unknown[]) => ({
      response: { candidates: [{ content: { parts }, finishReason: "STOP" }] },
    });
    const sse = [
      `data: ${JSON.stringify(noUsage([{ text: "hel" }]))}`,
      `data: ${JSON.stringify(noUsage([{ text: "lo" }]))}`,
      `data: ${JSON.stringify(wrappedResponse([], { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }))}`,
      "data: [DONE]",
    ].join("\n\n");

    const fetch = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      );
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const chunks = [];
    for await (const chunk of client.stream({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const text = chunks.map((c) => c.contentDelta ?? "").join("");
    expect(text).toBe("hello");
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage?.promptTokens).toBe(3);
    expect(usageChunk?.usage?.completionTokens).toBe(2);
  });

  it("captures an inlineData image part as StreamChunk.image", async () => {
    const b64 = Buffer.from("fake-bytes").toString("base64");
    const sse = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }] } },
          ],
        },
      })}`,
      "data: [DONE]",
    ].join("\n\n");

    const fetch = vi.fn(async () => {
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const chunks: Array<{ image?: { dataUrl: string; mimeType: string } }> = [];
    for await (const chunk of client.stream({
      model: "gemini-3.1-flash-image",
      messages: [{ role: "user", content: "draw a square" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.image)).toBe(true);
    expect(chunks.find((c) => c.image)?.image).toEqual({
      dataUrl: `data:image/jpeg;base64,${b64}`,
      mimeType: "image/jpeg",
    });
  });
});

describe("gemini inlineData image parsing", () => {
  it("captures an inlineData part as ChatResponse.image (non-streaming)", async () => {
    const b64 = Buffer.from("fake-bytes").toString("base64");
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify(wrappedResponse([{ inlineData: { mimeType: "image/jpeg", data: b64 } }])),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = geminiClient(fetch);
    const res = await client.chat({
      model: "gemini-3.1-flash-image",
      messages: [{ role: "user", content: "draw a square" }],
    });

    expect(res.image).toEqual({
      dataUrl: `data:image/jpeg;base64,${b64}`,
      mimeType: "image/jpeg",
    });
  });
});
