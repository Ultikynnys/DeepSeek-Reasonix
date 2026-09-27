/** Live output-rate estimate for one streaming session, in tokens per second.
 *
 *  Streaming deltas carry text, not token ids, so tokens are approximated at
 *  the project's usual 4-chars-per-token ratio (see `estimateRequestTokens`).
 *  The rate is averaged over a short sliding window so it reflects the
 *  *current* throughput rather than the whole call: it climbs as output flows
 *  and decays to 0 the moment the provider stops sending (a thinking pause, a
 *  tool-execution gap, or a stalled stream). A provider that hides obfuscated
 *  reasoning simply streams less text — the readout tracks whatever bytes do
 *  reach the client. */

const CHARS_PER_TOKEN = 4;
/** Sliding window over which received characters are averaged. */
const WINDOW_MS = 2500;
/** No delta within this gap ⇒ the stream has paused; report 0 tok/s. */
const STALE_MS = 1200;
/** Floor on the averaging span so a cold-start burst can't divide by ~0. */
const MIN_SPAN_MS = 600;

export class StreamRateTracker {
  private samples: Array<{ t: number; chars: number }> = [];

  /** Record `chars` provider-output characters received at `now`. */
  record(chars: number, now: number = Date.now()): void {
    if (chars <= 0) return;
    this.samples.push({ t: now, chars });
  }

  /** Forget all samples — call when a stream ends so a later turn can't average
   *  against this one's tail. */
  reset(): void {
    this.samples.length = 0;
  }

  /** Current tokens/second, or 0 when paused or empty. */
  tokensPerSecond(now: number = Date.now()): number {
    const cutoff = now - WINDOW_MS;
    let first = 0;
    while (first < this.samples.length && this.samples[first]!.t < cutoff) first++;
    if (first > 0) this.samples.splice(0, first);
    if (this.samples.length === 0) return 0;
    const last = this.samples[this.samples.length - 1]!;
    if (now - last.t > STALE_MS) return 0;
    let chars = 0;
    for (const s of this.samples) chars += s.chars;
    const spanMs = Math.max(MIN_SPAN_MS, Math.min(WINDOW_MS, now - this.samples[0]!.t));
    return chars / CHARS_PER_TOKEN / (spanMs / 1000);
  }
}

/** Render a tok/s figure: integers once it's over ~10, one decimal below so a
 *  slow trickle still reads as progress. */
export function formatTokensPerSecond(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0";
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}
