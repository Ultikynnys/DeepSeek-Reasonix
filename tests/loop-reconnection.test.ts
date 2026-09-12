import { describe, expect, it, vi } from "vitest";
import {
  isNetworkConnectionError,
  probeConnectivity,
  waitForReconnection,
} from "../src/loop/errors.js";

describe("isNetworkConnectionError", () => {
  it("identifies fetch failed as network connection error", () => {
    expect(isNetworkConnectionError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkConnectionError(new Error("fetch failed"))).toBe(true);
  });

  it("identifies stream body read failures as network connection error", () => {
    expect(
      isNetworkConnectionError(new Error("Ollama stream body read failed: connection reset")),
    ).toBe(true);
    expect(isNetworkConnectionError(new Error("SSE body read failed: socket hang up"))).toBe(true);
    expect(
      isNetworkConnectionError(
        new Error("Ollama stream terminated before the `done` completion frame"),
      ),
    ).toBe(true);
  });

  it("identifies network error codes as network connection error", () => {
    const errReset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isNetworkConnectionError(errReset)).toBe(true);

    const errDns = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(isNetworkConnectionError(errDns)).toBe(true);

    const errTimeout = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isNetworkConnectionError(errTimeout)).toBe(true);
  });

  it("identifies nested causes in fetch errors", () => {
    const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    const err = new TypeError("fetch failed", { cause });
    expect(isNetworkConnectionError(err)).toBe(true);
  });

  it("does not classify 4xx or abort errors as network connection errors", () => {
    expect(isNetworkConnectionError(new Error("DeepSeek 400: invalid request"))).toBe(false);
    expect(isNetworkConnectionError(new Error("Ollama 404: model not found"))).toBe(false);
    expect(isNetworkConnectionError(new Error("DeepSeek 401: unauthorized"))).toBe(false);
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    expect(isNetworkConnectionError(abortErr)).toBe(false);
  });
});

describe("waitForReconnection", () => {
  it("returns true immediately if probe succeeds", async () => {
    const probeFn = vi.fn().mockResolvedValue(true);
    const reconnected = await waitForReconnection({
      targetUrl: "https://api.test/v1",
      initialDelayMs: 0,
      probeFn,
    });
    expect(reconnected).toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it("retries until probe succeeds", async () => {
    const probeFn = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const reconnected = await waitForReconnection({
      targetUrl: "https://api.test/v1",
      initialDelayMs: 10,
      probeIntervalMs: 10,
      maxWaitMs: 1000,
      probeFn,
    });
    expect(reconnected).toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(3);
  });

  it("returns false if aborted by signal", async () => {
    const ac = new AbortController();
    const probeFn = vi.fn().mockImplementation(async () => {
      ac.abort();
      return false;
    });

    const reconnected = await waitForReconnection({
      targetUrl: "https://api.test/v1",
      signal: ac.signal,
      initialDelayMs: 0,
      probeIntervalMs: 10,
      maxWaitMs: 1000,
      probeFn,
    });
    expect(reconnected).toBe(false);
  });

  it("returns false if maxWaitMs is exceeded", async () => {
    const probeFn = vi.fn().mockResolvedValue(false);
    const reconnected = await waitForReconnection({
      targetUrl: "https://api.test/v1",
      initialDelayMs: 10,
      probeIntervalMs: 10,
      maxWaitMs: 50,
      probeFn,
    });
    expect(reconnected).toBe(false);
    expect(probeFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CacheFirstLoop — mid-thinking reconnection", () => {
  it("waits for reconnection and resumes when connection drops mid-stream", async () => {
    let callCount = 0;
    const fakeClient = {
      baseUrl: "https://api.test/v1",
      model: "deepseek-chat",
      stream: async function* () {
        callCount++;
        if (callCount === 1) {
          // Emitting reasoning delta (thinking), then connection drops
          yield { reasoningDelta: "thinking about the problem..." };
          const err = new Error("stream body read failed: connection reset");
          Object.assign(err, { phase: "stream_body_read" });
          throw err;
        }
        // Second call after reconnection succeeds
        yield { reasoningDelta: "resumed thinking..." };
        yield { contentDelta: "Here is the completed answer." };
        yield { finishReason: "stop" };
      },
    } as any;

    // Probe returns true so reconnection succeeds
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

    const { CacheFirstLoop } = await import("../src/loop.js");
    const { ImmutablePrefix } = await import("../src/memory/runtime.js");

    const loop = new CacheFirstLoop({
      client: fakeClient,
      prefix: new ImmutablePrefix({ system: "test prompt" }),
      model: "deepseek-chat",
      stream: true,
    });

    const events: any[] = [];
    for await (const ev of loop.step("user question")) {
      events.push(ev);
    }

    vi.unstubAllGlobals();

    // Verify warnings and final resolution
    const warnings = events.filter((e) => e.role === "warning");
    expect(warnings.some((w) => w.content.includes("Connection lost"))).toBe(true);
    expect(warnings.some((w) => w.content.includes("Connection re-established"))).toBe(true);

    // Verify that the answer was received and the turn completed
    const deltas = events.filter((e) => e.role === "assistant_delta");
    expect(deltas.some((d) => d.content === "Here is the completed answer.")).toBe(true);
    expect(callCount).toBe(2);
  });
});
