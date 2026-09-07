import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

/** 200 chat-completions response; captures the request headers per call. */
function headerCapturingFetch(): {
  fetch: typeof fetch;
  headers: () => Array<Record<string, string>>;
} {
  const seen: Array<Record<string, string>> = [];
  const fn = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, headers: () => seen };
}

describe("OpenCode session headers (opencode.ai/docs/go)", () => {
  it("sends x-opencode-session and a reasonix User-Agent on opencode requests", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      sessionId: "desktop-17123456789012-3",
      fetch,
    });

    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "hi" }] });
    await client
      .stream({
        model: "glm-5-free",
        messages: [{ role: "user", content: "hi again" }],
      })
      .next();

    expect(headers().length).toBe(2);
    for (const h of headers()) {
      expect(h["x-opencode-session"]).toBe("desktop-17123456789012-3");
      expect(h["User-Agent"]).toMatch(/^reasonix\//);
    }
  });

  it("generates one stable session id per client when none is configured", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      fetch,
    });

    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "a" }] });
    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "b" }] });

    const [first, second] = headers();
    expect(first?.["x-opencode-session"]).toBeTruthy();
    expect(first?.["x-opencode-session"]).toBe(second?.["x-opencode-session"]);
    expect(first?.["x-opencode-session"]).not.toBe("desktop-17123456789012-3");
  });

  it("does not send the session header for non-opencode providers", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
    });

    await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(headers()[0]?.["x-opencode-session"]).toBeUndefined();
    expect(headers()[0]?.["User-Agent"]).toBeUndefined();
  });
});
