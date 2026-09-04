import { abortReason, messageOf, sleep } from "@reasonix/core-utils";
import { isRetryableHttpStatus } from "../core/retry-shared.js";

/** Maximum attempts for a compaction model call, including the first call. */
export const COMPACTION_MAX_ATTEMPTS = 2;
/** Backoff between compaction attempts so a short provider outage can clear. */
export const COMPACTION_RETRY_DELAY_MS = 30_000;

export interface CompactionRetryOptions<T> {
  /** One provider call. A fresh signal is supplied for every attempt. */
  attempt: (signal: AbortSignal) => Promise<T>;
  /** Caller-owned signal; an aborted caller is never retried. */
  signal?: AbortSignal;
  /** Total wall-clock budget shared by all attempts and the backoff. */
  maxElapsedMs?: number;
  /** Error identity used when the total wall-clock budget expires. */
  timeoutMessage?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Retry compaction model calls after transient provider or response-body failures. */
export async function withCompactionRetry<T>(opts: CompactionRetryOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? COMPACTION_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? COMPACTION_RETRY_DELAY_MS);
  const maxElapsedMs = opts.maxElapsedMs ?? Number.POSITIVE_INFINITY;
  const timeoutMessage = opts.timeoutMessage ?? "compaction retry budget exceeded";
  const startedAt = Date.now();
  const budgetController = new AbortController();
  let budgetExpired = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetError: Error | undefined;
  let lastError: unknown;
  const budgetPromise = Number.isFinite(maxElapsedMs)
    ? new Promise<never>((_, reject) => {
        budgetError = new Error(timeoutMessage);
        budgetTimer = setTimeout(
          () => {
            budgetExpired = true;
            budgetController.abort(budgetError);
            reject(budgetError);
          },
          Math.max(1, maxElapsedMs),
        );
      })
    : null;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      if (budgetExpired) throw budgetError ?? new Error(timeoutMessage);

      const attemptController = new AbortController();
      const signals = [attemptController.signal, budgetController.signal];
      if (opts.signal) signals.push(opts.signal);
      const attemptSignal = AbortSignal.any(signals);
      try {
        const result = opts.attempt(attemptSignal);
        return await (budgetPromise ? Promise.race([result, budgetPromise]) : result);
      } catch (err) {
        lastError = err;
        // Stop any request work that an attempt may have left behind after a
        // Promise.race deadline, then decide whether a replay is safe.
        attemptController.abort();
        const retryable = isRetryableCompactionError(messageOf(err));
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = maxElapsedMs - elapsedMs;
        if (
          attempt === maxAttempts - 1 ||
          budgetExpired ||
          opts.signal?.aborted ||
          !retryable ||
          remainingMs <= retryDelayMs
        ) {
          throw err;
        }
        await sleep(
          retryDelayMs,
          AbortSignal.any([budgetController.signal, ...(opts.signal ? [opts.signal] : [])]),
        );
      }
    }

    throw lastError ?? new Error("compaction retry loop exited unexpectedly");
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
  }
}

// Run `task` under a wall-clock deadline. The deadline aborts its own
// AbortController (combined via AbortSignal.any) and rejects with
// `new Error(timeoutMessage)`; the timer always clears and the controller
// aborts on settle so no request work survives completion.
export async function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  timeoutMessage: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const deadlineCtrl = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, deadlineCtrl.signal])
    : deadlineCtrl.signal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      deadlineCtrl.abort(new Error(timeoutMessage));
      reject(new Error(timeoutMessage));
    }, deadlineMs);
  });
  try {
    const result = task(signal);
    return await Promise.race([result, deadlinePromise]);
  } catch (err) {
    // Whichever promise wins, preserve the terminal timeout identity instead of
    // misclassifying the abort as a transient provider drop.
    if (timedOut) throw new Error(timeoutMessage);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    deadlineCtrl.abort();
  }
}

/** Provider statuses and network/body failures that are safe to replay. */
export function isRetryableCompactionError(message: string): boolean {
  const trimmed = message.trim();
  if (
    trimmed === "fold-timeout" ||
    trimmed === "fold-aborted" ||
    trimmed === "forced-summary-timeout" ||
    trimmed === "forced-summary-aborted" ||
    trimmed === "file-triage-timeout" ||
    trimmed === "aborted" ||
    /\bAbortError\b|aborted by user|operation was aborted/i.test(trimmed)
  ) {
    return false;
  }

  const status = /^(?:DeepSeek|Upstream) (\d{3}):/.exec(trimmed)?.[1];
  if (status !== undefined) {
    return isRetryableHttpStatus(Number(status));
  }

  // Only replay recognizable transport/body failures. A local programming or
  // accounting error must not trigger a second billable model request.
  return /fetch failed|failed to fetch|network|connection|socket|body|terminated|reset|closed|premature|unexpected end|ECONN|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(
    trimmed,
  );
}
