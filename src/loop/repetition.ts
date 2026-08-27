export interface RepetitionDetection {
  /** Length of the smallest repeating unit in normalized, non-whitespace characters. */
  period: number;
  /** Full periodic suffix length, including repeats received before detection. */
  repeatedChars: number;
  /** Character offset where the periodic suffix begins in the complete stream. */
  safeLength: number;
}

export interface StreamRepetitionDetectorOptions {
  minRepeatedChars?: number;
  minRepeats?: number;
  maxPeriod?: number;
  maxBufferChars?: number;
}

/** Detects long exact-periodic stream suffixes without retaining the full response. */
export class StreamRepetitionDetector {
  private readonly minRepeatedChars: number;
  private readonly minRepeats: number;
  private readonly maxPeriod: number;
  private readonly maxBufferChars: number;
  private buffer = "";
  /** Raw stream offset of each normalized character retained in buffer. */
  private rawOffsets: number[] = [];
  private totalChars = 0;

  constructor(opts: StreamRepetitionDetectorOptions = {}) {
    this.minRepeatedChars = opts.minRepeatedChars ?? 1024;
    this.minRepeats = opts.minRepeats ?? 6;
    this.maxPeriod = opts.maxPeriod ?? 1024;
    this.maxBufferChars = Math.max(
      opts.maxBufferChars ?? 8192,
      this.minRepeatedChars + this.maxPeriod * this.minRepeats,
    );
  }

  append(delta: string): RepetitionDetection | null {
    if (delta.length === 0) return null;
    const deltaStart = this.totalChars;
    this.totalChars += delta.length;
    for (let i = 0; i < delta.length; i++) {
      const char = delta[i]!;
      if (/\s/u.test(char)) continue;
      this.buffer += char;
      this.rawOffsets.push(deltaStart + i);
    }

    const maxPeriod = Math.min(this.maxPeriod, Math.floor(this.buffer.length / this.minRepeats));
    for (let period = 1; period <= maxPeriod; period++) {
      const required = Math.max(this.minRepeatedChars, period * this.minRepeats);
      if (this.buffer.length < required) continue;

      const checkStart = this.buffer.length - required;
      let periodic = true;
      for (let i = checkStart + period; i < this.buffer.length; i++) {
        if (this.buffer[i] !== this.buffer[i - period]) {
          periodic = false;
          break;
        }
      }
      if (!periodic) continue;

      let runStart = checkStart;
      while (runStart > 0 && this.buffer[runStart - 1] === this.buffer[runStart - 1 + period]) {
        runStart--;
      }
      const rawRunStart = this.rawOffsets[runStart];
      if (rawRunStart === undefined) continue;
      return {
        period,
        repeatedChars: this.totalChars - rawRunStart,
        safeLength: rawRunStart,
      };
    }
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = this.buffer.slice(-this.maxBufferChars);
      this.rawOffsets = this.rawOffsets.slice(-this.maxBufferChars);
    }
    return null;
  }
}
