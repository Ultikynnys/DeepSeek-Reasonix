/** Memoize an async loader so the first call kicks off work and every later call returns the same promise. */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) pending = load();
    return pending;
  };
}

/** Coalesce concurrent calls into one in-flight promise; the slot clears on
 *  settle so a later call starts fresh (unlike `lazy`, which caches forever). */
export function singleFlight<T>(): (run: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (run) => {
    if (!inFlight) {
      inFlight = (async () => {
        try {
          return await run();
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}
