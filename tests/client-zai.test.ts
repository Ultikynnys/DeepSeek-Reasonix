import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { isThinkingModeModel, thinkingModeForModel } from "../src/loop/thinking.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Z.AI GLM chat", () => {
  it("sends the documented top-level thinking parameters", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (input, requestInit) => {
      url = String(input);
      init = requestInit as RequestInit;
      return jsonResponse({
        choices: [{ message: { content: "ok", reasoning_content: "thought" } }],
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "zai-test-key",
      baseUrl: "https://api.z.ai/api/paas/v4/",
      fetch,
    });

    const response = await client.chat({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hello" }],
      thinking: "enabled",
      reasoningEffort: "max",
      temperature: 1,
    });

    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer zai-test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(body.reasoning_effort).toBe("max");
    expect(body.extra_body).toBeUndefined();
    expect(body.temperature).toBe(1);
    expect(response.reasoningContent).toBe("thought");
  });

  it("enables streamed tool calls and normalizes object arguments", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input, requestInit) => {
      body = JSON.parse(String((requestInit as RequestInit).body)) as Record<string, unknown>;
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: { query: "glm" } } }] }, finish_reason: "tool_calls" }] })}\n\n`,
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
    const client = new DeepSeekClient({
      apiKey: "zai-test-key",
      baseUrl: "https://api.z.ai/api/paas/v4",
      fetch,
    });

    const chunks = [];
    for await (const chunk of client.stream({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "search" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a query",
            parameters: { type: "object" },
          },
        },
      ],
      thinking: "enabled",
      reasoningEffort: "xhigh",
    })) {
      chunks.push(chunk);
    }

    expect(body?.tool_stream).toBe(true);
    expect(body?.stream_options).toBeUndefined();
    expect(body?.reasoning_effort).toBe("max");
    expect(chunks[0]?.reasoningDelta).toBe("think");
    expect(chunks[1]?.toolCallDelta?.argumentsDelta).toBe('{"query":"glm"}');
  });

  it("passes image_url content blocks through unchanged", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input, requestInit) => {
      body = JSON.parse(String((requestInit as RequestInit).body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "image" } }] });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "zai-test-key",
      baseUrl: "https://api.z.ai/api/paas/v4",
      fetch,
    });
    const content = [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text" as const, text: "describe" },
    ];

    await client.chat({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content }],
    });

    expect((body?.messages as Array<{ content: unknown }>)[0]?.content).toEqual(content);
  });

  it("classifies GLM models as preserved-thinking models", () => {
    expect(isThinkingModeModel("glm-5.3-flash")).toBe(true);
    expect(thinkingModeForModel("glm-5.3")).toBe("enabled");
  });
});
