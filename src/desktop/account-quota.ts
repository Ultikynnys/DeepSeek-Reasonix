import type { CodexQuotaResult } from "../codex-backend.js";

interface CachedQuota {
  value: CodexQuotaResult;
  expiresAt: number;
  requestId: number;
}

export type QuotaDelivery = "underlying" | "shared" | "cache";

export interface QuotaDeliveryResult {
  value: CodexQuotaResult;
  delivery: QuotaDelivery;
  requestId: number;
}

export interface QuotaFetchObserver {
  started?: (requestId: number) => void;
  succeeded?: (requestId: number, value: CodexQuotaResult) => void;
  failed?: (requestId: number, reason: string) => void;
}

export class AccountQuotaCoordinator {
  private cached: CachedQuota | null = null;
  private inflight: Promise<CodexQuotaResult> | null = null;
  private inflightRequestId = 0;
  private nextRequestId = 1;

  constructor(
    private readonly fetcher: () => Promise<CodexQuotaResult>,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
    private readonly observer: QuotaFetchObserver = {},
  ) {}

  fetch(options: { force?: boolean } = {}): Promise<QuotaDeliveryResult> {
    if (this.inflight) {
      const requestId = this.inflightRequestId;
      return this.inflight.then((value) => ({ value, delivery: "shared", requestId }));
    }
    if (!options.force && this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve({
        value: this.cached.value,
        delivery: "cache",
        requestId: this.cached.requestId,
      });
    }
    const requestId = this.nextRequestId++;
    this.inflightRequestId = requestId;
    this.observer.started?.(requestId);
    const request = this.fetcher()
      .then((value) => {
        if (value.quota) {
          this.cached = { value, expiresAt: this.now() + this.ttlMs, requestId };
          this.observer.succeeded?.(requestId, value);
        } else {
          this.observer.failed?.(requestId, value.reason ?? "no quota data");
        }
        return value;
      })
      .catch((error) => {
        this.observer.failed?.(requestId, error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        if (this.inflight === request) this.inflight = null;
      });
    this.inflight = request;
    return request.then((value) => ({ value, delivery: "underlying", requestId }));
  }

  invalidate(): void {
    this.cached = null;
  }
}
