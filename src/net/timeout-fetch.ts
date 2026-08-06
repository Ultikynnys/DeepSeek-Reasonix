/** fetch() with an abort-timer — shared by the version checker and the MCP registry fetcher. */

/** Run `fetcher` under an abort timeout. The timer is always cleared, even on throw. */
export async function fetchWithTimeout(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
