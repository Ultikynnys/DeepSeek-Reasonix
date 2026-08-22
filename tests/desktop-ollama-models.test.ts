/** Ollama account-plan lookup + subscription-gated model probing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOllamaPlan,
  fetchOllamaUsage,
  isSubscriptionGatedResponse,
  probeOllamaModel,
  refreshOllamaModels,
  resetOllamaCatalogCacheForTest,
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
});
