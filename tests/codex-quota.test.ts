import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEEKLY_MINUTES,
  fetchCodexQuota,
  fetchCodexQuotaDetailed,
  normalizeCodexWindow,
} from "../src/codex-quota.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

/** Fake codex app-server: answers each JSON-RPC request from a per-method
 *  map, echoed back on stdout (PassThrough) with the request's own id. */
function fakeCodexServer(byMethod: Record<string, unknown>, opts: { delayMs?: number } = {}) {
  const stdout = new PassThrough();
  const proc = {
    stdout,
    stderr: new PassThrough(),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
    on: vi.fn(),
  };
  spawnMock.mockReturnValue(proc as never);
  const write = proc.stdin.write as ReturnType<typeof vi.fn>;
  write.mockImplementation((chunk: string) => {
    const req = JSON.parse(String(chunk).trim()) as { method?: string; id?: number };
    const value = req.method !== undefined ? byMethod[req.method] : undefined;
    if (value !== undefined) {
      const resp =
        value && typeof value === "object" && "error" in value
          ? { id: req.id, error: (value as { error: unknown }).error }
          : { id: req.id, result: value };
      setTimeout(() => stdout.push(`${JSON.stringify(resp)}\n`), opts.delayMs ?? 0);
    }
    return true;
  });
  return proc;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("normalizeCodexWindow (official format math)", () => {
  it("computes remainingPercent = 100 - usedPercent and ISO resetsAt", () => {
    const w = normalizeCodexWindow({
      windowDurationMins: 10080,
      usedPercent: 27,
      resetsAt: 1755000000,
    });
    expect(w).toEqual({
      windowMinutes: 10080,
      usedPercent: 27,
      remainingPercent: 73,
      resetsAt: new Date(1755000000 * 1000).toISOString(),
    });
  });

  it("clamps remainingPercent at 0 for over-quota windows", () => {
    const w = normalizeCodexWindow({ windowDurationMins: 300, usedPercent: 120 });
    expect(w?.remainingPercent).toBe(0);
  });

  it("returns null when required fields are missing", () => {
    expect(normalizeCodexWindow({ windowDurationMins: 10080 })).toBeNull();
    expect(normalizeCodexWindow({ usedPercent: 10 })).toBeNull();
    expect(normalizeCodexWindow({})).toBeNull();
  });
});

describe("fetchCodexQuotaDetailed (codex app-server RPC)", () => {
  it("returns weekly and 5-hour windows keyed by windowMinutes, plus the plan", async () => {
    fakeCodexServer({
      initialize: {},
      "account/read": { account: { planType: "plus" } },
      "account/rateLimits/read": {
        rateLimits: {
          primary: { windowDurationMins: 10080, usedPercent: 27, resetsAt: 1755000000 },
          secondary: { windowDurationMins: 300, usedPercent: 50, resetsAt: 1755100000 },
        },
      },
    });
    const { quota, reason } = await fetchCodexQuotaDetailed();
    expect(reason).toBeNull();
    expect(quota?.plan).toBe("plus");
    expect(quota?.weekly).toMatchObject({
      windowMinutes: WEEKLY_MINUTES,
      usedPercent: 27,
      remainingPercent: 73,
    });
    expect(quota?.fiveHour).toMatchObject({ windowMinutes: 300, remainingPercent: 50 });
    expect(quota?.fetchedAt).toBeGreaterThan(0);
  });

  it("keeps weekly null when the plan only reports a 5-hour window", async () => {
    fakeCodexServer({
      initialize: {},
      "account/read": { account: { planType: "pro" } },
      "account/rateLimits/read": {
        rateLimits: { primary: { windowDurationMins: 300, usedPercent: 40 } },
      },
    });
    const { quota } = await fetchCodexQuotaDetailed();
    expect(quota?.weekly).toBeNull();
    expect(quota?.fiveHour?.remainingPercent).toBe(60);
    expect(quota?.plan).toBe("pro");
  });

  it("returns null with a reason when the app-server errors", async () => {
    fakeCodexServer({
      initialize: {},
      "account/read": { account: { planType: "plus" } },
      "account/rateLimits/read": { error: { message: "not signed in" } },
    });
    const { quota, reason } = await fetchCodexQuotaDetailed();
    expect(quota).toBeNull();
    expect(reason).toContain("not signed in");
  });

  it("returns null with a reason when the codex binary cannot start", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });
    const { quota, reason } = await fetchCodexQuotaDetailed();
    expect(quota).toBeNull();
    expect(reason).toContain("failed to start codex app-server");
    expect(reason).toContain("ENOENT");
  });

  it("times out and kills a hung app-server", async () => {
    fakeCodexServer({});
    const { quota, reason } = await fetchCodexQuotaDetailed(50);
    expect(quota).toBeNull();
    expect(reason).toContain("timed out");
  });

  it("fetchCodexQuota returns just the quota object", async () => {
    fakeCodexServer({
      initialize: {},
      "account/read": { account: { planType: "plus" } },
      "account/rateLimits/read": {
        rateLimits: { primary: { windowDurationMins: 10080, usedPercent: 0 } },
      },
    });
    const q = await fetchCodexQuota();
    expect(q?.weekly?.remainingPercent).toBe(100);
  });
});
