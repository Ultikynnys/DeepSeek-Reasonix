import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEEKLY_MINUTES,
  clearCodexQuotaCache,
  fetchCodexQuota,
  fetchCodexQuotaDetailed,
  normalizeCodexWindow,
} from "../src/codex-quota.js";

// Use a plain function for exec (not vi.fn) so vi.resetAllMocks() in
// afterEach doesn't clear the implementation — otherwise the Promise in
// fetchCodexQuotaDetailed never settles and the test times out.
vi.mock("node:child_process", () => {
  function execMock(_cmd: string, ...args: unknown[]) {
    const opts = args[0];
    const cb = args[1];
    const callback = typeof opts === "function" ? opts : typeof cb === "function" ? cb : null;
    if (callback) (callback as (err: Error) => void)(new Error("npm not available in test"));
    return {} as any;
  }
  return { spawn: vi.fn(), exec: execMock };
});

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

beforeEach(() => {
  // The failure cache is module-level — a remembered ENOENT from a previous
  // test would make later tests skip spawning and return the cached reason.
  clearCodexQuotaCache();
});

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
    // Auto-install is triggered first; when that also fails the reason reflects the install failure.
    expect(reason).toContain("failed to install codex CLI");
  });

  it("times out and kills a hung app-server", async () => {
    fakeCodexServer({});
    const { quota, reason } = await fetchCodexQuotaDetailed(50);
    expect(quota).toBeNull();
    expect(reason).toContain("timed out");
  });

  it("remembers a spawn failure and skips re-spawning during the cooldown", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });
    const first = await fetchCodexQuotaDetailed();
    // Auto-install is triggered and fails in test; the failure is then cached.
    expect(first.reason).toContain("failed to install codex CLI");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Second fetch within the cooldown must not re-spawn the missing binary —
    // this is the 40-line console spam fixed by the failure cache.
    const second = await fetchCodexQuotaDetailed();
    expect(second.reason).toContain("failed to install codex CLI");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the failure cooldown for an explicit user retry", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });
    await fetchCodexQuotaDetailed();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await fetchCodexQuotaDetailed(15_000, { force: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("clears the remembered failure after a successful fetch", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });
    await fetchCodexQuotaDetailed();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Success resets the cache — force past the cooldown, then a plain
    // fetch must spawn again instead of serving the remembered failure.
    fakeCodexServer({
      initialize: {},
      "account/read": { account: { planType: "plus" } },
      "account/rateLimits/read": {
        rateLimits: { primary: { windowDurationMins: 10080, usedPercent: 5 } },
      },
    });
    const ok = await fetchCodexQuotaDetailed(15_000, { force: true });
    expect(ok.quota?.weekly?.usedPercent).toBe(5);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await fetchCodexQuotaDetailed();
    expect(spawnMock).toHaveBeenCalledTimes(3);
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
