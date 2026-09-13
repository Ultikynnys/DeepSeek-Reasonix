import { abortReason, messageOf, sleep } from "@reasonix/core-utils";
import { isRetryableProviderFailure } from "../core/retry-shared.js";

/** Compaction always gets three retries after its initial model call. */
export const COMPACTION_RETRY_COUNT = 3;
/** Maximum attempts for a compaction model call, including the first call. */
export const COMPACTION_MAX_ATTEMPTS = COMPACTION_RETRY_COUNT + 1;
/** Backoff between compaction attempts so a short provider outage can clear. */
export const COMPACTION_RETRY_DELAY_MS = 30_000;

/** Total bounded wall-clock budget for every attempt and every intervening retry delay. */
export function compactionRetryBudgetMs(
  attemptTimeoutMs: number,
  maxAttempts = COMPACTION_MAX_ATTEMPTS,
  retryDelayMs = COMPACTION_RETRY_DELAY_MS,
): number {
  const attempts = Math.max(1, maxAttempts);
  return attemptTimeoutMs * attempts + retryDelayMs * (attempts - 1);
}

export function validateCompactionSummary(content: string, minChars: number): string {
  if (!content) throw new Error("summarizer returned empty content");
  if (content.length < minChars) {
    throw new Error(`summarizer returned a degenerate summary (${content.length} chars)`);
  }
  return content;
}

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

/** Provider statuses and network/body failures that are safe to replay. */
export function isRetryableCompactionError(message: string): boolean {
  const trimmed = message.trim();
  if (
    trimmed === "fold-aborted" ||
    trimmed === "forced-summary-aborted" ||
    trimmed === "file-triage-timeout" ||
    trimmed === "aborted" ||
    /\bAbortError\b|aborted by user|operation was aborted/i.test(trimmed)
  ) {
    return false;
  }

  // Each compaction attempt has its own bounded deadline. A timeout, empty response,
  // or degenerate response can be transient and is safe to replay up to the fixed cap.
  if (
    trimmed === "fold-timeout" ||
    trimmed === "forced-summary-timeout" ||
    trimmed === "summarizer returned empty content" ||
    /^summarizer returned a degenerate summary \(\d+ chars\)$/.test(trimmed)
  ) {
    return true;
  }

  // Any provider brand: a retryable status under "OpenCode 500: ..." counts the
  // same as "DeepSeek 500: ...", and upstream-relayed failure phrases
  // ("Upstream request failed: [server_error] ...") are transient by nature.
  if (isRetryableProviderFailure(trimmed)) return true;

  // Only replay recognizable transport/body failures. A local programming or
  // accounting error must not trigger a second billable model request.
  return /fetch failed|failed to fetch|network|connection|socket|body|terminated|reset|closed|premature|unexpected end|ECONN|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(
    trimmed,
  );
}
