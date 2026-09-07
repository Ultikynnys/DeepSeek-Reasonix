import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

/** SSE body with the given frames, then a clean EOF. */
function sseFetch(frames: string[]): { fetch: typeof fetch; calls: () => number } {
  const fn = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.join("")));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return {
    fetch: fn,
    calls: () => (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
  };
}

describe("chat-completions SSE mid-stream error frames", () => {
  it("surfaces an OpenCode upstream-failure error frame instead of silently ending the stream", async () => {
    const { fetch } = sseFetch([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"error":{"message":"Upstream request failed: [server_error] The model failed to generate a response.","type":"server_error"}}\n\n',
    ]);
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      fetch,
      retry: { maxAttempts: 1 },
    });

    const consume = async () => {
      for await (const _ of client.stream({
        model: "glm-5-free",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    };

    // server_error-classified → synthetic 500, provider-branded, with the
    // loop-replay metadata the responses-path failure carries.
    await expect(consume()).rejects.toMatchObject({
      message: expect.stringContaining(
        "OpenCode 500: Upstream request failed: [server_error] The model failed to generate a response.",
      ),
      phase: "stream_body_read",
      code: "server_error",
    });
  });

  it("maps a bare-string error frame to a 400-class error for non-server codes", async () => {
    const { fetch } = sseFetch(['data: {"error":"upstream exploded"}\n\n']);
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      retry: { maxAttempts: 1 },
    });

    const consume = async () => {
      for await (const _ of client.stream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    };

    const err = (await consume().then(
      () => null,
      (e) => e as Record<string, unknown>,
    )) as Record<string, unknown> | null;
    expect(err?.message).toBe("DeepSeek 400: upstream exploded");
    expect(err?.phase).toBe("stream_body_read");
    // No code key at all when the frame carries none (spread omits it).
    expect("code" in (err as object)).toBe(false);
  });

  it("lets frames with a null error field pass through untouched", async () => {
    const { fetch } = sseFetch([
      'data: {"error":null}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      retry: { maxAttempts: 1 },
    });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

function makeStreamThatErrors(error: Error): typeof fetch {
  return vi.fn(async () => {
    let callCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        callCount++;
        if (callCount === 1) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
          );
          return;
        }
        controller.error(error);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("DeepSeekClient.stream() mid-stream error wrapping", () => {
  it("wraps body-reader errors with phase and original code", async () => {
    const err = Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" });
    const fetch = makeStreamThatErrors(err);
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1 },
    });

    const chunks: any[] = [];
    const consume = async () => {
      for await (const chunk of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      message: expect.stringContaining("terminated"),
      phase: "stream_body_read",
      code: "UND_ERR_ABORTED",
    });
    expect(chunks).toHaveLength(1);
  });

  it("falls back to stream_body_read without code when error lacks one", async () => {
    const fetch = makeStreamThatErrors(new Error("network dropped"));
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1 },
    });

    const consume = async () => {
      for await (const _ of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    };

    await expect(consume()).rejects.toMatchObject({
      phase: "stream_body_read",
      code: undefined,
    });
  });
});
