import { describe, expect, it, vi } from "vitest";
import type { CodexQuotaResult } from "../src/codex-backend.js";
import { AccountQuotaCoordinator } from "../src/desktop/account-quota.js";

const result: CodexQuotaResult = {
  quota: { plan: "pro", fiveHour: null, weekly: null },
  reason: null,
};

describe("AccountQuotaCoordinator", () => {
  it("coalesces concurrent requests and caches successful results", async () => {
    let resolve!: (value: CodexQuotaResult) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<CodexQuotaResult>((done) => {
          resolve = done;
        }),
    );
    const coordinator = new AccountQuotaCoordinator(fetcher);
    const first = coordinator.fetch();
    const second = coordinator.fetch();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(result);
    await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
    await coordinator.fetch();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures and coalesces forced requests", async () => {
    const failure: CodexQuotaResult = { quota: null, reason: "offline" };
    const fetcher = vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(result);
    const coordinator = new AccountQuotaCoordinator(fetcher);
    await expect(coordinator.fetch()).resolves.toEqual(failure);
    await expect(coordinator.fetch()).resolves.toEqual(result);
    const forced = await Promise.all([
      coordinator.fetch({ force: true }),
      coordinator.fetch({ force: true }),
    ]);
    expect(forced).toEqual([result, result]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("expires cached snapshots", async () => {
    let now = 0;
    const fetcher = vi.fn().mockResolvedValue(result);
    const coordinator = new AccountQuotaCoordinator(fetcher, 100, () => now);
    await coordinator.fetch();
    now = 99;
    await coordinator.fetch();
    now = 101;
    await coordinator.fetch();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
