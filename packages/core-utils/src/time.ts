/** Shared time constants — every `days * 24 * 60 * 60 * 1000` site used to
 *  re-derive the millisecond day inline (session pruning, usage compaction,
 *  rolling windows). */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve after `ms`, or reject early if `signal` aborts. Rejects with the
 *  signal's reason when it's an Error, else a generic "aborted" Error. Shared
 *  by the retry and compaction-retry loops, which used to reimplement the same
 *  timer + abort-listener dance. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason && typeof reason === "object" && "message" in reason) {
    return new Error(String(reason.message));
  }
  return new Error(reason === undefined ? "aborted" : String(reason));
}

/** Resolve the Error a signal aborts with — its reason when it's an Error, else a generic "aborted" Error. */
export { abortReason };
