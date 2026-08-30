import { describe, expect, it, vi } from "vitest";
import type { CodexQuotaResult } from "../src/codex-backend.js";
import { AccountQuotaCoordinator } from "../src/desktop/account-quota.js";

const result: CodexQuotaResult = {
  quota: { plan: "pro", fiveHour: null, weekly: null },
  reason: null,
};

describe("AccountQuotaCoordinator", () => {
  it("coalesces concurrent requests with delivery provenance and caches success", async () => {
    let resolve!: (value: CodexQuotaResult) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<CodexQuotaResult>((done) => {
          resolve = done;
        }),
    );
    const started = vi.fn();
    const succeeded = vi.fn();
    const coordinator = new AccountQuotaCoordinator(fetcher, 15_000, Date.now, {
      started,
      succeeded,
    });
    const first = coordinator.fetch();
    const second = coordinator.fetch();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(result);
    await expect(first).resolves.toMatchObject({
      value: result,
      delivery: "underlying",
      requestId: 1,
    });
    await expect(second).resolves.toMatchObject({
      value: result,
      delivery: "shared",
      requestId: 1,
    });
    await expect(coordinator.fetch()).resolves.toMatchObject({ delivery: "cache", requestId: 1 });
    expect(started).toHaveBeenCalledOnce();
    expect(succeeded).toHaveBeenCalledOnce();
  });

  it("reports one underlying failure and leaves it retryable", async () => {
    const failure: CodexQuotaResult = { quota: null, reason: "offline" };
    const fetcher = vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(result);
    const failed = vi.fn();
    const coordinator = new AccountQuotaCoordinator(fetcher, 15_000, Date.now, { failed });
    const [first, second] = await Promise.all([coordinator.fetch(), coordinator.fetch()]);
    expect(first.delivery).toBe("underlying");
    expect(second.delivery).toBe("shared");
    expect(failed).toHaveBeenCalledOnce();
    await expect(coordinator.fetch()).resolves.toMatchObject({ value: result });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires cached snapshots and coalesces forced requests", async () => {
    let now = 0;
    const fetcher = vi.fn().mockResolvedValue(result);
    const coordinator = new AccountQuotaCoordinator(fetcher, 100, () => now);
    await coordinator.fetch();
    now = 99;
    await coordinator.fetch();
    now = 101;
    await coordinator.fetch();
    await Promise.all([coordinator.fetch({ force: true }), coordinator.fetch({ force: true })]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
