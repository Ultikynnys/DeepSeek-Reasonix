/** Gemini provider (Antigravity/Cloud Code API): payload shape, wrapped
 *  response parsing, and SSE streaming. */

import { afterEach, describe, expect, it, vi } from "vitest";
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
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
    );
    expect(captured?.headers.authorization).toBe("Bearer google-token");
    expect(captured?.headers["x-goog-api-client"]).toBe(
      "google-cloud-sdk vscode_cloudshelleditor/0.1",
    );
    const body = captured?.body as {
      model: string;
      project: string;
      userAgent: string;
      requestId: string;
      request: {
        contents: unknown[];
        systemInstruction: unknown;
        tools: unknown[];
        toolConfig: unknown;
      };
    };
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.project).toBe("proj-123");
    expect(body.userAgent).toBe("antigravity");
    expect(body.requestId).toMatch(/^reasonix-/);
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

  it("falls back to production when sandbox endpoints are unavailable", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(wrappedResponse([{ text: "fallback" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof globalThis.fetch;
    const client = geminiClient(fetch);

    await expect(
      client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    ).resolves.toMatchObject({ content: "fallback" });
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
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
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
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
});
