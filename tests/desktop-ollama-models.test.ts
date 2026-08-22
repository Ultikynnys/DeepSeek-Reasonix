/** Ollama account-plan lookup + subscription-gated model probing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveNativeOllamaOrigin,
  detectOllamaVision,
  fetchOllamaPlan,
  fetchOllamaUsage,
  isSubscriptionGatedResponse,
  probeOllamaModel,
  probeOllamaVision,
  refreshOllamaModels,
  resetOllamaCatalogCacheForTest,
  showPayloadIsVision,
} from "../src/cli/commands/desktop.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("fetchOllamaPlan", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts {origin}/api/me with the Bearer key and returns the Plan", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Plan: "free" }));
    await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBe("free");
    const [, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe("https://ollama.com");
    expect(url.pathname).toBe("/api/me");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer key-1" },
      body: "{}",
    });
  });

  it("returns undefined when the payload has no Plan field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: "x", Name: "y" }));
    await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined when the endpoint is not ollama.com (404 / 405)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
    await expect(fetchOllamaPlan("https://gateway.example/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined on network errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined for a malformed base URL without calling fetch", async () => {
    await expect(fetchOllamaPlan("not a url", "key-1")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeOllamaModel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a 1-token chat and returns ok on 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "x" } }] }));
    await expect(probeOllamaModel("https://ollama.com/v1", "gpt-oss:20b", "key-1")).resolves.toBe(
      "ok",
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://ollama.com/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer key-1" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
  });

  it("returns gated for a 403 subscription response", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          error: { message: "this model requires a subscription, upgrade for access" },
        }),
        403,
      ),
    );
    await expect(probeOllamaModel("https://ollama.com/v1", "minimax-m3", "key-1")).resolves.toBe(
      "gated",
    );
  });

  it("returns gated for the Pro/Max/Team plan 403 variant", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          error: {
            message:
              "this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access: https://ollama.com/upgrade",
          },
        }),
        403,
      ),
    );
    await expect(probeOllamaModel("https://ollama.com/v1", "kimi-k3", "key-1")).resolves.toBe(
      "gated",
    );
  });

  it("returns error for a 403 that is not about subscriptions", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("forbidden", 403));
    await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
  });

  it("retries a rate-limited probe once and honors the retried response", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("rate limited", 429));
    fetchMock.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({ error: { message: "this model requires a subscription" } }),
        403,
      ),
    );
    await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("gated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns error when the 429 retry also fails", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("rate limited", 429));
    fetchMock.mockResolvedValueOnce(textResponse("still rate limited", 429));
    await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns error for 5xx so transient failures never hide a model", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("boom", 503));
    await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
  });

  it("returns error on network failures", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
  });
});

describe("isSubscriptionGatedResponse", () => {
  it("is true only for a 403 carrying subscription language", () => {
    expect(isSubscriptionGatedResponse(403, "this model requires a subscription")).toBe(true);
    expect(
      isSubscriptionGatedResponse(
        403,
        "this model requires both a Pro, Max, or Team plan, upgrade for access",
      ),
    ).toBe(true);
    expect(isSubscriptionGatedResponse(403, "forbidden")).toBe(false);
    expect(isSubscriptionGatedResponse(429, "this model requires a subscription")).toBe(false);
  });
});

describe("deriveNativeOllamaOrigin", () => {
  it("strips a trailing /v1 from a local daemon base", () => {
    expect(deriveNativeOllamaOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });

  it("strips a trailing /v1 from the cloud base", () => {
    expect(deriveNativeOllamaOrigin("https://ollama.com/v1")).toBe("https://ollama.com");
  });

  it("leaves a non-/v1 path untouched", () => {
    expect(deriveNativeOllamaOrigin("https://ollama.com")).toBe("https://ollama.com");
    expect(deriveNativeOllamaOrigin("http://gateway.example/proxy/v1")).toBe(
      "http://gateway.example/proxy",
    );
  });

  it("returns the input on a malformed URL", () => {
    expect(deriveNativeOllamaOrigin("not a url")).toBe("not a url");
  });
});

describe("showPayloadIsVision", () => {
  it("is true when projector_info is present and non-empty", () => {
    expect(showPayloadIsVision({ projector_info: { arch: "clip" } })).toBe(true);
  });

  it("is true when model_info carries a vision.* key", () => {
    expect(showPayloadIsVision({ model_info: { "vision.projector.embedding_length": 1024 } })).toBe(
      true,
    );
  });

  it("is false for a text-only model", () => {
    expect(
      showPayloadIsVision({ model_info: { "general.architecture": "llama" }, projector_info: {} }),
    ).toBe(false);
  });

  it("is false for null / non-object / missing fields", () => {
    expect(showPayloadIsVision(null)).toBe(false);
    expect(showPayloadIsVision(undefined)).toBe(false);
    expect(showPayloadIsVision("x")).toBe(false);
    expect(showPayloadIsVision({})).toBe(false);
  });
});

describe("probeOllamaVision / detectOllamaVision", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probeOllamaVision returns true on a 2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    await expect(probeOllamaVision("http://localhost:11434/v1", "llava", "")).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: expect.stringContaining("data:image/png;base64,") },
    });
  });

  it("probeOllamaVision returns false on a 400 (text-only model)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("image not supported", 400));
    await expect(probeOllamaVision("http://localhost:11434/v1", "llama3.1", "")).resolves.toBe(
      false,
    );
  });

  it("probeOllamaVision returns undefined on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(probeOllamaVision("http://localhost:11434/v1", "m", "")).resolves.toBeUndefined();
  });

  it("detectOllamaVision trusts the native /api/show metadata first", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ projector_info: { arch: "clip" } }));
    await expect(detectOllamaVision("http://localhost:11434/v1", "llava", "")).resolves.toBe(true);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("http://localhost:11434/api/show?model=llava");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no probe fallback
  });

  it("detectOllamaVision falls back to the image probe when /api/show 404s", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] })); // probe → 2xx
    await expect(detectOllamaVision("https://ollama.com/v1", "llava", "key")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("detectOllamaVision follows the probe to false when the model rejects the image", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
    fetchMock.mockResolvedValueOnce(textResponse("bad", 400)); // probe → text-only
    await expect(detectOllamaVision("https://ollama.com/v1", "llama3.1", "key")).resolves.toBe(
      false,
    );
  });
});

describe("fetchOllamaUsage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs {origin}/api/usage with the Bearer key and parses both windows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
        limits: {
          session: { usage: 0.003, models: [{ name: "gpt-oss:20b", request_count: 14 }] },
          weekly: { usage: 0.001, models: [] },
        },
      }),
    );
    await expect(fetchOllamaUsage("https://ollama.com/v1", "key-1")).resolves.toEqual({
      session: 0.003,
      weekly: 0.001,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe("https://ollama.com");
    expect(url.pathname).toBe("/api/usage");
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer key-1" },
    });
  });

  it("returns only the windows the payload carries", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ limits: { session: { usage: 0.5 } } }));
    await expect(fetchOllamaUsage("https://ollama.com/v1", "key-1")).resolves.toEqual({
      session: 0.5,
    });
  });

  it("ignores non-numeric usage values", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ limits: { session: { usage: "0.5" }, weekly: { usage: null } } }),
    );
    await expect(fetchOllamaUsage("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined when neither window parses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ activity: { cost: "0" } }));
    await expect(fetchOllamaUsage("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined on non-ok status", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
    await expect(fetchOllamaUsage("https://gateway.example/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined on network errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(fetchOllamaUsage("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
  });
});

describe("refreshOllamaModels — app-global catalog cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Catalog fetches only — the plan re-check (`POST {origin}/api/me`) is a
   *  legitimate extra request when a key is configured, so assertions count
   *  `GET {base}/models` calls, not every fetch. */
  const modelsFetchCount = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models")).length;
  beforeEach(() => {
    resetOllamaCatalogCacheForTest();
    process.env.OLLAMA_API_KEY = undefined;
    process.env.ollamaApiKey = undefined;
    process.env.OLLAMA_BASE_URL = "https://ollama.test/v1";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    process.env.OLLAMA_BASE_URL = undefined;
    vi.unstubAllGlobals();
    resetOllamaCatalogCacheForTest();
  });

  it("dedupes concurrent refreshes onto one fetch", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [{ id: "qwen3:32b" }, { id: "llama3.1:latest" }] })),
    );
    const first = refreshOllamaModels(true);
    const second = refreshOllamaModels(true);
    // Both calls join the same in-flight fetch — no second request, and both
    // resolve to the same catalog.
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    await expect(first).resolves.toMatchObject({
      models: ["llama3.1:latest", "qwen3:32b"], // sorted
    });
    expect(modelsFetchCount()).toBe(1);
  });

  it("serves a fresh cache on non-force calls without hitting the network", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [{ id: "llama3.1:latest" }] })),
    );
    await refreshOllamaModels(true);
    expect(modelsFetchCount()).toBe(1);

    await expect(refreshOllamaModels(false)).resolves.toMatchObject({
      models: ["llama3.1:latest"],
    });
    expect(modelsFetchCount()).toBe(1); // cache hit within the TTL
  });

  it("force bypasses the cache and refetches", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [{ id: "llama3.1:latest" }] })),
    );
    await refreshOllamaModels(true);
    await refreshOllamaModels(false); // cached
    await refreshOllamaModels(true); // forced
    expect(modelsFetchCount()).toBe(2);
  });

  it("never caches an error snapshot — the next call retries", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const snap = await refreshOllamaModels(true);
    expect(snap.error).toContain("Ollama unreachable");
    expect(modelsFetchCount()).toBe(1);

    // The error is broadcast but not cached, so a plain call refetches
    // instead of serving a stale failure.
    await refreshOllamaModels(false);
    expect(modelsFetchCount()).toBe(2);
  });

  it("carries visionModels probed from the native /api/show", async () => {
    // Keyless local daemon: catalog + one native /api/show per model.
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/models")) {
        return Promise.resolve(
          jsonResponse({ data: [{ id: "llava" }, { id: "llama3.1:latest" }] }),
        );
      }
      // Native /api/show — llava is vision, llama3.1 is text-only.
      if (u.includes("/api/show?model=llava")) {
        return Promise.resolve(jsonResponse({ projector_info: { arch: "clip" } }));
      }
      if (u.includes("/api/show?model=")) {
        return Promise.resolve(jsonResponse({ model_info: { "general.architecture": "llama" } }));
      }
      return Promise.resolve(textResponse("unexpected", 500));
    });
    const snap = await refreshOllamaModels(true);
    expect(snap.visionModels).toEqual(["llava"]);
    expect(snap.models).toEqual(["llama3.1:latest", "llava"]);
  });
});
