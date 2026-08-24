import type { ToolCall } from "../types.js";

/** Mutating calls clear prior read-only entries so a post-edit re-read isn't flagged as repeat. */
export type IsMutating = (call: ToolCall) => boolean;
export type IsStormExempt = (call: ToolCall) => boolean;

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

/** Tracks (name, args) repeats; mutating calls clear read-only entries. Exempt tools are counted separately so a long identical-args repeat still reads as a stuck loop without disturbing non-exempt detection. */
export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  /** Identical exempt-call repeats before that tool trips the storm (defaults to
   *  the window — a window's worth of the same inspection call is a loop). */
  private readonly exemptLimit: number;
  private readonly isMutating: IsMutating | undefined;
  private readonly isStormExempt: IsStormExempt | undefined;
  private readonly recent: RecentEntry[] = [];
  /** Key of the previous exempt call and its consecutive repeat count — a
   *  different call resets the run so sparse re-reads never falsely trip. */
  private exemptRunKey: string | null = null;
  private exemptRunCount = 0;

  constructor(
    windowSize = 6,
    threshold = 3,
    isMutating?: IsMutating,
    isStormExempt?: IsStormExempt,
  ) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.exemptLimit = windowSize;
    this.isMutating = isMutating;
    this.isStormExempt = isStormExempt;
  }

  inspect(call: ToolCall): { suppress: boolean; reason?: string } {
    const name = call.function?.name;
    if (!name) return { suppress: false };
    const exempt = this.isStormExempt?.(call) ?? false;
    const args = call.function?.arguments ?? "";
    const mutating = this.isMutating ? this.isMutating(call) : false;
    const readOnly = !mutating;

    if (mutating) {
      // Drop prior read-only entries — the file/shell state just changed, so a
      // verify-read after this should start with a clean slate. Keep mutator
      // entries: 3 identical edits in a row is still a storm (model in a loop).
      for (let i = this.recent.length - 1; i >= 0; i--) {
        if (this.recent[i]!.readOnly) this.recent.splice(i, 1);
      }
      // Same for the exempt counter — a re-read after a write is a fresh
      // verify, not the continuation of a stuck loop.
      this.exemptRunKey = null;
      this.exemptRunCount = 0;
    }

    if (exempt) {
      // Exempt inspection tools live in their own counter — they don't consume
      // shared-window slots, but a CONSECUTIVE identical-args repeat that fills
      // the whole window still reads as a stuck loop. A different call (or a
      // mutating call above) resets the run, so sparse re-reads never falsely
      // trip.
      const key = `${name}::${args}`;
      const count = key === this.exemptRunKey ? this.exemptRunCount + 1 : 1;
      if (count >= this.exemptLimit) {
        return {
          suppress: true,
          reason: `${name} called with identical args ${count} times — repeat-loop guard tripped`,
        };
      }
      this.exemptRunKey = key;
      this.exemptRunCount = count;
      return { suppress: false };
    }

    const count = this.recent.reduce((n, e) => (e.name === name && e.args === args ? n + 1 : n), 0);
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason: `${name} called with identical args ${count + 1} times — repeat-loop guard tripped`,
      };
    }
    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  reset(): void {
    this.recent.length = 0;
    this.exemptRunKey = null;
    this.exemptRunCount = 0;
  }
}
