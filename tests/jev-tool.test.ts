import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  DEFAULT_JEV_MODEL,
  TYPESAFE_MODELS_URL,
  TYPESAFE_SYSTEM_ONE_URL,
  evaluateWithJev,
  registerJevTool,
  validateTypesafeApiKey,
} from "../src/tools/jev.js";

const VALID_RESULT = {
  model: DEFAULT_JEV_MODEL,
  answers: {
    urgent: { type: "noul", noul: 0.92 },
  },
  usage: { input_tokens: 12, output_tokens: 2 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateTypesafeApiKey", () => {
  it("validates credentials against the authenticated model list", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "jev-latest", description: "Jev", release_date: "2026-01-01" }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateTypesafeApiKey("typesafe-secret")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(TYPESAFE_MODELS_URL, {
      headers: { Authorization: "Bearer typesafe-secret" },
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects invalid credentials without reflecting the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const error = await validateTypesafeApiKey("never-print-this").catch(
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toMatch(/authentication failed/);
    expect(error.message).not.toContain("never-print-this");
  });

  it("requires the account to expose a Jev model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [{ name: "other", description: "Other", release_date: "2026-01-01" }],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(validateTypesafeApiKey("valid-but-no-jev")).rejects.toThrow(/does not provide/);
  });
});

describe("evaluateWithJev", () => {
  it("sends a documented System One request with bearer auth", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(VALID_RESULT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await evaluateWithJev(
      { message: "Help now" },
      { urgent: { type: "noul", instructions: "Does this convey urgency?" } },
      { apiKey: "ts-secret" },
    );

    expect(result).toEqual(VALID_RESULT);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TYPESAFE_SYSTEM_ONE_URL);
    expect(init.headers).toEqual({
      Authorization: "Bearer ts-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      state: { message: "Help now" },
      model: DEFAULT_JEV_MODEL,
      questions: { urgent: { type: "noul", instructions: "Does this convey urgency?" } },
    });
  });

  it("requires a configured key without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      evaluateWithJev(
        "state",
        { yes: { type: "noul", instructions: "Is it true?" } },
        { configPath: "missing-config.json" },
      ),
    ).rejects.toThrow(/Settings → Models → TypeSafe \/ Jev/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports documented upstream failures explicitly without leaking the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ detail: "quota exhausted" }), { status: 429 }),
      ),
    );
    const error = await evaluateWithJev(
      "state",
      { yes: { type: "noul", instructions: "Is it true?" } },
      { apiKey: "never-print-this" },
    ).catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/rate limit exceeded: quota exhausted/);
    expect(error.message).not.toContain("never-print-this");
  });

  it("rejects malformed typed questions before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      evaluateWithJev(
        "state",
        { route: { type: "choice", instructions: "Route this", criteria: { only: null } } },
        { apiKey: "key" },
      ),
    ).rejects.toThrow(/at least two/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("registerJevTool", () => {
  it("registers a read-only parallel-safe tool and dispatches through ToolRegistry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(VALID_RESULT), { status: 200 })),
    );
    const originalKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-key";
    try {
      const registry = registerJevTool(new ToolRegistry(), { configPath: "missing-config.json" });
      expect(registry.get("jev_evaluate")?.readOnly).toBe(true);
      expect(registry.isParallelSafe("jev_evaluate")).toBe(true);

      const result = await registry.dispatch("jev_evaluate", {
        state: "Help now",
        questions: { urgent: { type: "noul", instructions: "Does this convey urgency?" } },
      });
      expect(result).toContain('"noul":0.92');
    } finally {
      // biome-ignore lint/performance/noDelete: restore exact env state
      if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = originalKey;
    }
  });
});
