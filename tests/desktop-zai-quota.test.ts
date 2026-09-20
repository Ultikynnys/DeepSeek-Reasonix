/** Z.AI GLM Coding Plan usage parsing — `GET {origin}/api/monitor/usage/quota/limit`. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZaiQuota } from "../src/cli/commands/desktop.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchZaiQuota", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs {origin}/api/monitor/usage/quota/limit with the Bearer key and maps unit 3/6 to 5h/weekly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        success: true,
        data: {
          level: "max",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              usage: 800_000_000,
              currentValue: 127_694_464,
              remaining: 672_305_536,
              percentage: 15,
              nextResetTime: 1_770_648_402_389,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 20,
              nextResetTime: 1_787_641_095_989,
            },
            { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 45 },
          ],
        },
      }),
    );
    await expect(fetchZaiQuota("https://api.z.ai/api/coding/paas/v4", "key-1")).resolves.toEqual({
      plan: "max",
      fiveHour: { usagePct: 15, remainingPct: 85, resetsAt: 1_770_648_402_389 },
      weekly: { usagePct: 20, remainingPct: 80, resetsAt: 1_787_641_095_989 },
    });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("https://api.z.ai");
    expect(url.pathname).toBe("/api/monitor/usage/quota/limit");
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer key-1" },
    });
  });

  it("derives the monitor host from a custom Z.AI base URL's origin", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 1 }] } }),
    );
    await fetchZaiQuota("https://open.bigmodel.cn/api/paas/v4", "key-1");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe("https://open.bigmodel.cn");
  });

  it("falls back to currentValue/usage when `percentage` is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          level: "pro",
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12_000, currentValue: 3_000 },
            { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 0 },
          ],
        },
      }),
    );
    await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toEqual({
      plan: "pro",
      fiveHour: { usagePct: 25, remainingPct: 75, resetsAt: null },
      weekly: { usagePct: 0, remainingPct: 100, resetsAt: null },
    });
  });

  it("returns undefined when the payload carries no token/credit rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0 }] },
      }),
    );
    await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined when `limits` is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { level: "lite" } }));
    await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined on non-ok status (e.g. a Developer key)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 401 }, 401));
    await expect(fetchZaiQuota("https://api.z.ai/api/paas/v4", "key-1")).resolves.toBeUndefined();
  });

  it("returns undefined on network errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
  });
});
