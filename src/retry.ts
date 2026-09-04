/** Client retries initial requests only; loop-level guards handle safe stream/compaction replays. */

import { messageOf, sleep } from "@reasonix/core-utils";
import { RETRYABLE_HTTP_STATUSES } from "./core/retry-shared.js";

export interface RetryOptions {
  /** Maximum total attempts (including the first). Default 4. */
  maxAttempts?: number;
  /** Initial backoff in ms. Doubles each retry, with jitter. Default 500. */
  initialBackoffMs?: number;
  /** Upper bound on any single backoff delay. Default 10000 (10s). */
  maxBackoffMs?: number;
  /** HTTP statuses to treat as retryable. Default [408, 429, 500, 502, 503, 504]. */
  retryableStatuses?: readonly number[];
  /** Abort signal; we do NOT retry once aborted. */
  signal?: AbortSignal;
  /** Telemetry hook — called before each wait. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  reason: string;
  waitMs: number;
}

const DEFAULT_RETRYABLE_STATUSES = RETRYABLE_HTTP_STATUSES;

export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const initial = opts.initialBackoffMs ?? 500;
  const cap = opts.maxBackoffMs ?? 10_000;
  const retryable = new Set(opts.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES);

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");

    try {
      const resp = await fetchFn(url, init);

      // Success or non-retryable failure: return as-is.
      if (resp.ok || !retryable.has(resp.status)) return resp;

      // Retryable but out of attempts: return the last response so the caller
      // can surface the status to the user.
      if (attempt === maxAttempts - 1) return resp;

      // Drain the body so the connection can be reused on the next attempt.
      await resp.text().catch(() => undefined);

      const waitMs = computeWait(attempt, initial, cap, resp.headers.get("Retry-After"));
      opts.onRetry?.({ attempt: attempt + 1, reason: `http ${resp.status}`, waitMs });
      await sleep(waitMs, opts.signal);
    } catch (err) {
      lastError = err;
      // Respect explicit aborts — do not retry.
      if (isAbortError(err) || opts.signal?.aborted) throw err;
      if (attempt === maxAttempts - 1) throw err;

      const waitMs = computeWait(attempt, initial, cap, null);
      opts.onRetry?.({
        attempt: attempt + 1,
        reason: `network: ${messageOf(err)}`,
        waitMs,
      });
      await sleep(waitMs, opts.signal);
    }
  }

  throw lastError ?? new Error("fetchWithRetry: loop exited unexpectedly");
}

function computeWait(
  attempt: number,
  initial: number,
  cap: number,
  retryAfter: string | null,
): number {
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, cap);
    }
  }
  const exp = initial * 2 ** attempt;
  // Jitter range [75%, 125%] to spread retries out when many clients hit 429 together.
  const jitter = exp * (0.75 + Math.random() * 0.5);
  return Math.min(Math.max(jitter, 0), cap);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}
