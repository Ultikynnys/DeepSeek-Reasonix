import type { Usage } from "../client.js";
import { loadPricingOverride } from "../config.js";
import type { CacheDiagnosticEntry } from "./cache-diagnostics.js";

/** USD per 1M tokens; display currency conversion happens at the UI boundary. */
export const DEEPSEEK_PRICING: Record<
  string,
  { inputCacheHit: number; inputCacheMiss: number; output: number }
> = {
  "deepseek-v4-flash": { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  "deepseek-v4-pro": { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
  // Compat aliases — priced as v4-flash per the deprecation notice.
  "deepseek-chat": { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  "deepseek-reasoner": { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  // GPT-5.6 family (Sol/Terra/Luna) — official pricing (2026-07 GA). Cache
  // reads bill at 10% of input (90% discount). Override via `pricingOverride`.
  "gpt-5.6": { inputCacheHit: 0.5, inputCacheMiss: 5, output: 30 },
  "gpt-5.6-sol": { inputCacheHit: 0.5, inputCacheMiss: 5, output: 30 },
  "gpt-5.6-terra": { inputCacheHit: 0.2, inputCacheMiss: 2, output: 12 },
  "gpt-5.6-luna": { inputCacheHit: 0.02, inputCacheMiss: 0.2, output: 1.2 },
};

export type ModelPricing = (typeof DEEPSEEK_PRICING)[string];

export function pricingFor(model: string, path?: string): ModelPricing | undefined {
  const defaults = DEEPSEEK_PRICING[model];
  const override = loadPricingOverride(path)[model];
  if (!override) return defaults;
  const pricing = { ...defaults, ...override };
  if (
    pricing.inputCacheHit === undefined ||
    pricing.inputCacheMiss === undefined ||
    pricing.output === undefined
  ) {
    return undefined;
  }
  return pricing as ModelPricing;
}

/** Reference Claude Sonnet 4.6 pricing (USD per 1M tokens). */
export const CLAUDE_SONNET_PRICING = { input: 3.0, output: 15.0 };

/** Prompt-side window only; completion caps live server-side. Deliberately below the API's
 *  1M-token ceiling: quality degrades past ~300K, and compaction thresholds in context-manager.ts
 *  are fractions of this cap (fold at 0.75 × 300K = 225K). Users may raise it via the `contextTokens` setting (see resolveContextTokens) — the API ceiling is 1M tokens. */
export const DEEPSEEK_CONTEXT_TOKENS: Record<string, number> = {
  "deepseek-v4-flash": 300_000,
  "deepseek-v4-pro": 300_000,
  "deepseek-v4-flash-vision-exp": 300_000,
  "deepseek-chat": 300_000,
  "deepseek-reasoner": 300_000,
  // GPT-5.6 advertises a 1.05M window; same 300K quality cap as DeepSeek
  // (compaction thresholds are fractions of this cap).
  "gpt-5.6": 300_000,
  "gpt-5.6-sol": 300_000,
  "gpt-5.6-terra": 300_000,
  "gpt-5.6-luna": 300_000,
};

/** Lower bound of the user-configurable `contextTokens` setting. */
export const MIN_CONTEXT_TOKENS = 300_000;
/** Upper bound of the user-configurable `contextTokens` setting — the API's 1M-token ceiling. */
export const MAX_CONTEXT_TOKENS = 1_000_000;

/** Fallback when the caller's model id isn't in the table — safe lower bound. */
export const DEFAULT_CONTEXT_TOKENS = 131_072;

/** The effective context cap for a model: the configured `contextTokens` override when set
 *  (clamped to [300K, 1M]), else the model table, else the safe fallback — every ctxMax consumer
 *  resolves through here so the meter, the budget checks and the compaction thresholds agree. */
export function resolveContextTokens(model: string, configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.floor(configured)));
  }
  return DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
}

/** Maximum turns retained in memory before old entries are rolled into carryover.
 *  Each TurnStats holds usage + cost + model — at N=200 this caps memory at ~50KB. */
export const MAX_TURNS = 200;

export function costUsd(model: string, usage: Usage, path?: string): number {
  const p = pricingFor(model, path);
  if (!p) return 0;
  return (
    (usage.promptCacheHitTokens * p.inputCacheHit +
      usage.promptCacheMissTokens * p.inputCacheMiss +
      usage.completionTokens * p.output) /
    1_000_000
  );
}

/** Input-side cost only (prompt, cache hit + miss). Used for the panel breakdown. */
export function inputCostUsd(model: string, usage: Usage, path?: string): number {
  const p = pricingFor(model, path);
  if (!p) return 0;
  return (
    (usage.promptCacheHitTokens * p.inputCacheHit +
      usage.promptCacheMissTokens * p.inputCacheMiss) /
    1_000_000
  );
}

/** Output-side cost only (completion tokens). Used for the panel breakdown. */
export function outputCostUsd(model: string, usage: Usage, path?: string): number {
  const p = pricingFor(model, path);
  if (!p) return 0;
  return (usage.completionTokens * p.output) / 1_000_000;
}

export function cacheSavingsUsd(model: string, hitTokens: number, path?: string): number {
  if (hitTokens <= 0) return 0;
  const p = pricingFor(model, path);
  if (!p) return 0;
  return (hitTokens * (p.inputCacheMiss - p.inputCacheHit)) / 1_000_000;
}

export function claudeEquivalentCost(usage: Usage): number {
  return (
    (usage.promptTokens * CLAUDE_SONNET_PRICING.input +
      usage.completionTokens * CLAUDE_SONNET_PRICING.output) /
    1_000_000
  );
}

export interface TurnStats {
  turn: number;
  model: string;
  usage: Usage;
  cost: number;
  cacheHitRatio: number;
  /** Raw prefix-shape snapshot for this turn — lets UIs attribute a miss to
   *  system/tool/few-shot churn or a log rewrite. */
  cacheDiagnostics?: CacheDiagnostics;
}

export type CacheChurnReason = "system" | "tools" | "few_shots" | "log_rewrite";

export interface CacheDiagnostics {
  prefixHash: string;
  prefixChanged: boolean;
  prefixChangeReasons: CacheChurnReason[];
  systemHash: string;
  toolsHash: string;
  fewShotsHash: string;
  logRewriteVersion: number;
  toolSchemaTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitTokens: number;
}

export interface SessionSummary {
  turns: number;
  totalCostUsd: number;
  totalInputCostUsd: number;
  /** Output-side (completion) cost aggregated across the session. */
  totalOutputCostUsd: number;
  /** @deprecated Claude reference; kept for benchmarks + replay compat, no longer surfaced in the TUI. */
  claudeEquivalentUsd: number;
  /** @deprecated. Same as claudeEquivalentUsd — synthetic ratio, not a real measurement. */
  savingsVsClaudePct: number;
  cacheHitRatio: number;
  /** Floor estimate for next call — actual cost = this + user delta + new tool outputs. */
  lastPromptTokens: number;
  lastTurnCostUsd: number;
  totalCacheHitTokens: number;
  totalCacheMissTokens: number;
  lastCacheMissTokens: number;
  lastToolSchemaTokens: number;
  lastPrefixChanged: boolean;
  lastPrefixChangeReasons: CacheChurnReason[];
}

export class SessionStats {
  readonly turns: TurnStats[] = [];
  /** Cost from prior runs of a resumed session, restored from session meta. */
  private _carryoverCost = 0;
  /** Turn count from prior runs of a resumed session. */
  private _carryoverTurns = 0;
  private _carryoverCacheHit = 0;
  private _carryoverCacheMiss = 0;
  private _carryoverCompletion = 0;
  /** Last turn's promptTokens before exit — surfaced via summary() until the next live turn lands. */
  private _carryoverLastPromptTokens = 0;
  /** Per-turn cache diagnostics stored as each turn completes, so the live
   *  cache-miss report can replay accurate prefix hashes per historical turn
   *  rather than computing them all from the current prefix. */
  private _cacheDiagnostics: CacheDiagnosticEntry[] = [];

  /** Seed totals from a resumed session's persisted meta — only call once at construction. */
  seedCarryover(opts: {
    totalCostUsd?: number;
    turnCount?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    totalCompletionTokens?: number;
    lastPromptTokens?: number;
  }): void {
    if (typeof opts.totalCostUsd === "number" && opts.totalCostUsd > 0) {
      this._carryoverCost = opts.totalCostUsd;
    }
    if (typeof opts.turnCount === "number" && opts.turnCount > 0) {
      this._carryoverTurns = opts.turnCount;
    }
    if (typeof opts.cacheHitTokens === "number" && opts.cacheHitTokens > 0) {
      this._carryoverCacheHit = opts.cacheHitTokens;
    }
    if (typeof opts.cacheMissTokens === "number" && opts.cacheMissTokens > 0) {
      this._carryoverCacheMiss = opts.cacheMissTokens;
    }
    if (typeof opts.totalCompletionTokens === "number" && opts.totalCompletionTokens > 0) {
      this._carryoverCompletion = opts.totalCompletionTokens;
    }
    if (typeof opts.lastPromptTokens === "number" && opts.lastPromptTokens > 0) {
      this._carryoverLastPromptTokens = opts.lastPromptTokens;
    }
  }

  /** Cumulative cache hit tokens across carryover + current turns. */
  get cumulativeCacheHitTokens(): number {
    let hit = this._carryoverCacheHit;
    for (const t of this.turns) hit += t.usage.promptCacheHitTokens;
    return hit;
  }

  /** Cumulative cache miss tokens across carryover + current turns. */
  get cumulativeCacheMissTokens(): number {
    let miss = this._carryoverCacheMiss;
    for (const t of this.turns) miss += t.usage.promptCacheMissTokens;
    return miss;
  }

  /** Cumulative completion (output) tokens across carryover + current turns. */
  get cumulativeCompletionTokens(): number {
    let comp = this._carryoverCompletion;
    for (const t of this.turns) comp += t.usage.completionTokens;
    return comp;
  }

  reset(): void {
    this.turns.length = 0;
    this._carryoverCost = 0;
    this._carryoverTurns = 0;
    this._carryoverCacheHit = 0;
    this._carryoverCacheMiss = 0;
    this._carryoverCompletion = 0;
    this._carryoverLastPromptTokens = 0;
    this._cacheDiagnostics = [];
  }

  record(
    turn: number,
    model: string,
    usage: Usage,
    cacheDiagnostics?: CacheDiagnostics,
  ): TurnStats {
    const cost = costUsd(model, usage);
    const stats: TurnStats = {
      turn,
      model,
      usage,
      cost,
      cacheHitRatio: usage.cacheHitRatio,
      cacheDiagnostics,
    };
    this.turns.push(stats);
    this.trimOldTurns();
    return stats;
  }

  /** Store a cache diagnostic entry per turn so the live cache-miss report
   *  replays the prefix hashes that were actually in effect at turn time. */
  addCacheDiagnostic(entry: CacheDiagnosticEntry): void {
    this._cacheDiagnostics.push(entry);
  }

  /** Per-turn cache diagnostics stored in-memory for the current process. */
  get cacheDiagnostics(): readonly CacheDiagnosticEntry[] {
    return this._cacheDiagnostics;
  }

  /** Fold external usage (e.g. subagent child-loop) into session totals without
   *  creating a turn entry — the parent's stats panel and session meta then see
   *  the full spend, not just the parent loop's API calls. (#2008) */
  recordExternal(model: string, usage: Usage): void {
    this._carryoverCost += costUsd(model, usage);
    this._carryoverCacheHit += usage.promptCacheHitTokens;
    this._carryoverCacheMiss += usage.promptCacheMissTokens;
    this._carryoverCompletion += usage.completionTokens;
  }

  /** Drop oldest turns beyond MAX_TURNS, folding their costs into carryover so
   *  session totals remain accurate even after trimming. */
  private trimOldTurns(): void {
    if (this.turns.length <= MAX_TURNS) return;
    const excess = this.turns.length - MAX_TURNS;
    const dropped = this.turns.splice(0, excess);
    for (const t of dropped) {
      this._carryoverCost += t.cost;
      this._carryoverCacheHit += t.usage.promptCacheHitTokens;
      this._carryoverCacheMiss += t.usage.promptCacheMissTokens;
      this._carryoverCompletion += t.usage.completionTokens;
    }
    this._carryoverTurns += excess;
  }

  get totalCost(): number {
    return this._carryoverCost + this.turns.reduce((sum, t) => sum + t.cost, 0);
  }

  get totalClaudeEquivalent(): number {
    return this.turns.reduce((sum, t) => sum + claudeEquivalentCost(t.usage), 0);
  }

  get savingsVsClaude(): number {
    const c = this.totalClaudeEquivalent;
    return c > 0 ? 1 - this.totalCost / c : 0;
  }

  get totalInputCost(): number {
    return this.turns.reduce((sum, t) => sum + inputCostUsd(t.model, t.usage), 0);
  }

  get totalOutputCost(): number {
    return this.turns.reduce((sum, t) => sum + outputCostUsd(t.model, t.usage), 0);
  }

  get aggregateCacheHitRatio(): number {
    let hit = this._carryoverCacheHit;
    let miss = this._carryoverCacheMiss;
    for (const t of this.turns) {
      hit += t.usage.promptCacheHitTokens;
      miss += t.usage.promptCacheMissTokens;
    }
    const denom = hit + miss;
    return denom > 0 ? hit / denom : 0;
  }

  summary(): SessionSummary {
    const last = this.turns[this.turns.length - 1];
    return {
      turns: this.turns.length + this._carryoverTurns,
      totalCostUsd: round(this.totalCost, 6),
      totalInputCostUsd: round(this.totalInputCost, 6),
      totalOutputCostUsd: round(this.totalOutputCost, 6),
      claudeEquivalentUsd: round(this.totalClaudeEquivalent, 6),
      savingsVsClaudePct: round(this.savingsVsClaude * 100, 2),
      cacheHitRatio: round(this.aggregateCacheHitRatio, 4),
      lastPromptTokens: last?.usage.promptTokens ?? this._carryoverLastPromptTokens,
      lastTurnCostUsd: round(last?.cost ?? 0, 6),
      totalCacheHitTokens: this.cumulativeCacheHitTokens,
      totalCacheMissTokens: this.cumulativeCacheMissTokens,
      lastCacheMissTokens: last?.usage.promptCacheMissTokens ?? 0,
      lastToolSchemaTokens: last?.cacheDiagnostics?.toolSchemaTokens ?? 0,
      lastPrefixChanged: last?.cacheDiagnostics?.prefixChanged ?? false,
      lastPrefixChangeReasons: last?.cacheDiagnostics?.prefixChangeReasons ?? [],
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
