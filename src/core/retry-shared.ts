/** Shared retryable-HTTP-status knowledge for the client and compaction retry loops. */

/** HTTP statuses that are safe to retry after a transient provider/network
 *  failure. 425 (Too Early) is included: a server that is still settling
 *  after a restart is legitimately retryable. */
export const RETRYABLE_HTTP_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;

/** True when an HTTP status is a transient, retryable failure. */
export function isRetryableHttpStatus(status: number): boolean {
  return (RETRYABLE_HTTP_STATUSES as readonly number[]).includes(status);
}

/** Provider brands persisted in thrown HTTP errors ("<Brand> <status>: <body>").
 *  Canonical list — src/loop/errors.ts builds its error classifiers from this,
 *  so a brand added here is retry-classified everywhere at once. */
export const PROVIDER_ERROR_BRANDS = "DeepSeek|OpenAI|Ollama|Antigravity|Z\\.AI|OpenCode|Upstream";

/** Status line "<Brand> <status>: ..." shared by every provider's thrown errors. */
const PROVIDER_STATUS_LINE = new RegExp(`^(?:${PROVIDER_ERROR_BRANDS}) (\\d{3}):`);

// Upstream-relayed failure phrases marking a transient provider-side fault
// (OpenCode Zen relaying its upstreams), with or without a status code.
const RETRYABLE_FAILURE_PHRASES =
  /\[server_error\]|upstream request failed|failed to generate a response/i;

// Retry-safe replay candidates: a retryable HTTP status under any provider
// brand, or an upstream-relayed failure phrase. 4xx request rejections and
// unrecognized errors return false — a replay must never paper over a
// deterministic error.
export function isRetryableProviderFailure(message: string): boolean {
  const status = PROVIDER_STATUS_LINE.exec(message.trim())?.[1];
  if (status !== undefined) return isRetryableHttpStatus(Number(status));
  return RETRYABLE_FAILURE_PHRASES.test(message);
}

/** True when `err` is an aborted operation — by `name` or an "aborted" message. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (/aborted/i.test(err.message)) return true;
  }
  return false;
}
