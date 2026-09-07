/** Shared "run a task under a wall-clock deadline" primitive. */

import { abortReason } from "@reasonix/core-utils";

// Run `task` under a wall-clock deadline. The deadline aborts its own
// AbortController (combined via AbortSignal.any) and rejects with
// `new Error(timeoutMessage)`; the timer always clears and the controller
// aborts on settle so no request work survives completion. A `parentSignal`
// abort rejects the deadline promise immediately — even when the task itself
// ignores the combined signal (e.g. it awaits an unrelated promise) — so a
// hung task is cut off by either the caller's abort or the deadline,
// whichever comes first.
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
  let onParentAbort: (() => void) | undefined;
  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      deadlineCtrl.abort(new Error(timeoutMessage));
      reject(new Error(timeoutMessage));
    }, deadlineMs);
  });
  const parentAbortPromise =
    parentSignal !== undefined
      ? new Promise<never>((_, reject) => {
          if (parentSignal.aborted) {
            reject(abortReason(parentSignal));
            return;
          }
          onParentAbort = () => reject(abortReason(parentSignal));
          parentSignal.addEventListener("abort", onParentAbort, { once: true });
        })
      : null;
  try {
    const result = task(signal);
    return await Promise.race(
      parentAbortPromise
        ? [result, deadlinePromise, parentAbortPromise]
        : [result, deadlinePromise],
    );
  } catch (err) {
    // Whichever promise wins, preserve the terminal timeout identity instead of
    // misclassifying the abort as a transient provider drop.
    if (timedOut) throw new Error(timeoutMessage);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onParentAbort && parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    deadlineCtrl.abort();
  }
}
