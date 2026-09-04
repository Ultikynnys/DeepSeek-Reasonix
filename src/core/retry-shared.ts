/** Shared retryable-HTTP-status knowledge for the client and compaction retry loops. */

/** HTTP statuses that are safe to retry after a transient provider/network
 *  failure. 425 (Too Early) is included: a server that is still settling
 *  after a restart is legitimately retryable. */
export const RETRYABLE_HTTP_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;

/** True when an HTTP status is a transient, retryable failure. */
export function isRetryableHttpStatus(status: number): boolean {
  return (RETRYABLE_HTTP_STATUSES as readonly number[]).includes(status);
}
