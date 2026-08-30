import type { CodexQuotaResult } from "../codex-backend.js";

interface CachedQuota {
  value: CodexQuotaResult;
  expiresAt: number;
}

export class AccountQuotaCoordinator {
  private cached: CachedQuota | null = null;
  private inflight: Promise<CodexQuotaResult> | null = null;

  constructor(
    private readonly fetcher: () => Promise<CodexQuotaResult>,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  fetch(options: { force?: boolean } = {}): Promise<CodexQuotaResult> {
    if (this.inflight) return this.inflight;
    if (!options.force && this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    const request = this.fetcher()
      .then((value) => {
        if (value.quota) this.cached = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        if (this.inflight === request) this.inflight = null;
      });
    this.inflight = request;
    return request;
  }

  invalidate(): void {
    this.cached = null;
  }
}
