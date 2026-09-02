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

const LONG_ANCHOR_CHARS = 48;
const LONG_MIN_REPEATS = 3;
const MAX_LONG_CANDIDATES = 128;

/** Default adaptive threshold biased towards detecting repeating words and short periods early. */
function defaultRequiredChars(period: number, minRepeatsOverride?: number): number {
  if (minRepeatsOverride !== undefined) {
    return period * minRepeatsOverride;
  }
  if (period === 1) {
    // Single characters (horizontal rules '---', '===', '0000') — divider lines up to ~120 chars are safe.
    return 160;
  }
  if (period === 2) {
    // 2-char tokens (e.g. '/*', '=-', '..') — allow up to ~48 repeats / 96 chars.
    return 96;
  }
  if (period === 3) {
    // 3-char tokens (e.g. '../' in deep relative paths) — allow up to ~27 repeats / 80 chars.
    return 80;
  }
  if (period <= 8) {
    // Short words (4..8 chars like 'test', 'error', 'name', 'true') — 8 repeats, min 64 chars.
    return Math.max(64, period * 8);
  }
  if (period <= 32) {
    // Word / identifier length (9..32 chars like 'read_file', 'undefined', 'search_content').
    // Bias towards detecting repeating words early: ~5-6 repeats (min 64 chars).
    return Math.max(64, period * 5);
  }
  if (period <= 128) {
    // Short phrases / code lines (33..128 chars) — 4 repeats (min 128 chars).
    return Math.max(128, period * 4);
  }
  if (period <= 512) {
    // Paragraphs / multi-line reasoning blocks (129..512 chars) — 3 repeats (min 256 chars).
    return Math.max(256, period * 3);
  }
  // Large blocks (513..1024 chars) — 2-3 repeats (min 1024 chars).
  return Math.max(1024, period * 2);
}

/** Finds the smallest fundamental repeating period of a string unit (e.g. "---" → 1, "abab" → 2). */
function getFundamentalPeriod(str: string): number {
  const n = str.length;
  for (let d = 1; d <= Math.floor(n / 2); d++) {
    if (n % d === 0) {
      let isDivisor = true;
      for (let i = d; i < n; i++) {
        if (str[i] !== str[i - d]) {
          isDivisor = false;
          break;
        }
      }
      if (isDivisor) return d;
    }
  }
  return n;
}

/** Detects exact-periodic stream suffixes without retaining the full response. */
export class StreamRepetitionDetector {
  private readonly minRepeatedChars?: number;
  private readonly minRepeats?: number;
  private readonly maxPeriod: number;
  private readonly maxBufferChars: number;
  private buffer = "";
  /** Raw stream offset of each normalized character retained in buffer. */
  private rawOffsets: number[] = [];
  private totalChars = 0;

  constructor(opts: StreamRepetitionDetectorOptions = {}) {
    this.minRepeatedChars = opts.minRepeatedChars;
    this.minRepeats = opts.minRepeats;
    this.maxPeriod = opts.maxPeriod ?? 1024;
    const baseMin = opts.minRepeatedChars ?? 1024;
    const maxPeriodRepeats = (opts.minRepeats ?? 6) * this.maxPeriod;
    this.maxBufferChars = Math.max(opts.maxBufferChars ?? 32_768, baseMin + maxPeriodRepeats);
  }

  private requiredChars(period: number): number {
    if (this.minRepeatedChars !== undefined) {
      return Math.max(this.minRepeatedChars, period * (this.minRepeats ?? 6));
    }
    return defaultRequiredChars(period, this.minRepeats);
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

    const maxPeriod = Math.min(this.maxPeriod, Math.floor(this.buffer.length / 2));
    for (let period = 1; period <= maxPeriod; period++) {
      const required = this.requiredChars(period);
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

      const unit = this.buffer.slice(checkStart, checkStart + period);
      const fundamentalPeriod = getFundamentalPeriod(unit);
      if (fundamentalPeriod < period) {
        const fundamentalRequired = this.requiredChars(fundamentalPeriod);
        if (this.buffer.length < fundamentalRequired) {
          continue;
        }
      }

      let runStart = checkStart;
      const actualPeriod = fundamentalPeriod;
      while (
        runStart > 0 &&
        this.buffer[runStart - 1] === this.buffer[runStart - 1 + actualPeriod]
      ) {
        runStart--;
      }
      const rawRunStart = this.rawOffsets[runStart];
      if (rawRunStart === undefined) continue;
      return {
        period: actualPeriod,
        repeatedChars: this.totalChars - rawRunStart,
        safeLength: rawRunStart,
      };
    }
    const longBlock = this.detectLongBlock();
    if (longBlock) return longBlock;

    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = this.buffer.slice(-this.maxBufferChars);
      this.rawOffsets = this.rawOffsets.slice(-this.maxBufferChars);
    }
    return null;
  }

  private detectLongBlock(): RepetitionDetection | null {
    const minChars = this.minRepeatedChars ?? 1024;
    if (this.buffer.length < minChars || this.buffer.length < LONG_ANCHOR_CHARS * 3) {
      return null;
    }
    const anchorStart = this.buffer.length - LONG_ANCHOR_CHARS;
    const anchor = this.buffer.slice(anchorStart);
    let searchFrom = anchorStart - 1;
    let candidates = 0;
    while (searchFrom >= 0 && candidates < MAX_LONG_CANDIDATES) {
      const match = this.buffer.lastIndexOf(anchor, searchFrom);
      if (match < 0) break;
      candidates++;
      const period = anchorStart - match;
      const repeatedLength = period * LONG_MIN_REPEATS;
      const runStart = this.buffer.length - repeatedLength;
      if (
        period > this.maxPeriod &&
        repeatedLength >= minChars &&
        runStart >= 0 &&
        this.buffer.slice(runStart, runStart + period) ===
          this.buffer.slice(runStart + period, runStart + period * 2) &&
        this.buffer.slice(runStart, runStart + period) === this.buffer.slice(runStart + period * 2)
      ) {
        let extendedStart = runStart;
        while (
          extendedStart > 0 &&
          this.buffer[extendedStart - 1] === this.buffer[extendedStart - 1 + period]
        ) {
          extendedStart--;
        }
        const rawRunStart = this.rawOffsets[extendedStart];
        if (rawRunStart !== undefined) {
          return {
            period,
            repeatedChars: this.totalChars - rawRunStart,
            safeLength: rawRunStart,
          };
        }
      }
      searchFrom = match - 1;
    }
    return null;
  }
}
