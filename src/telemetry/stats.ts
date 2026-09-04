import type { Usage } from "../client.js";
import { loadPricingOverride, providerForModel } from "../config.js";
import type { CacheDiagnosticEntry } from "./cache-diagnostics.js";

/** USD per 1M tokens, off-peak base rate (peak hours bill at 2x — see
 *  desktop/src/peak-hours.ts). Display currency conversion happens at the UI boundary. */
export const DEEPSEEK_PRICING: Record<
  string,
  { inputCacheHit: number; inputCacheMiss: number; output: number }
> = {
  // Official DeepSeek API pricing (api-docs.deepseek.com/quick_start/pricing).
  "deepseek-v4-flash": { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
  "deepseek-v4-pro": { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
  // The vision-preview line bills at the same rate as v4-flash.
  "deepseek-v4-flash-vision-exp": { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
  // Compat aliases — priced as v4-flash per the deprecation notice.
  "deepseek-chat": { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
  "deepseek-reasoner": { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
  // GPT-5.6 family (Sol/Terra/Luna) — official pricing (2026-07 GA). Cache
  // reads bill at 10% of input (90% discount). Override via `pricingOverride`.
  "gpt-5.6": { inputCacheHit: 0.5, inputCacheMiss: 5, output: 30 },
  "gpt-5.6-sol": { inputCacheHit: 0.5, inputCacheMiss: 5, output: 30 },
  "gpt-5.6-terra": { inputCacheHit: 0.2, inputCacheMiss: 2, output: 12 },
  "gpt-5.6-luna": { inputCacheHit: 0.02, inputCacheMiss: 0.2, output: 1.2 },
};

export type ModelPricing = (typeof DEEPSEEK_PRICING)[string];

function pricingFor(model: string, path?: string): ModelPricing | undefined {
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

/** Known per-model max context length (tokens), prompt-side only. This is the model's
 *  capability: resolveContextTokens clamps any `contextTokens` setting to it, so the
 *  effective cap never exceeds the model's max window. */
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
export const MIN_CONTEXT_TOKENS = 128_000;
/** Upper bound of the user-configurable `contextTokens` setting — the API's 1M-token ceiling. */
export const MAX_CONTEXT_TOKENS = 1_000_000;

/** Fallback when the caller's model id isn't in the table — safe lower bound. */
export const DEFAULT_CONTEXT_TOKENS = 131_072;

/** The effective context cap for a model: the configured `contextTokens` override when set,
 *  clamped to the model's known max context length, else the model table, else the safe
 *  fallback — every ctxMax consumer resolves through here so they all agree. */
export function resolveContextTokens(model: string, configured?: number): number {
  // Ollama windows are set by the model/server (`num_ctx`) and can be far
  // below the DeepSeek 300K floor — never clamp an explicit Ollama value up.
  const isOllama = typeof model === "string" && model.startsWith("ollama/");
  const modelDefault = DEEPSEEK_CONTEXT_TOKENS[model];
  if (typeof configured === "number" && Number.isFinite(configured)) {
    const floor = isOllama ? 1_024 : MIN_CONTEXT_TOKENS;
    const v = Math.max(floor, Math.floor(configured));
    // Hard invariant: the effective cap never exceeds the model's known max
    // context length (the table is the model's capability). The user may set
    // any value in settings, but the model max clamps it here — so the meter,
    // the compaction thresholds and the turn-start budget check all agree
    // with what the model actually accepts.
    if (modelDefault !== undefined) return Math.min(v, modelDefault);
    return Math.min(v, MAX_CONTEXT_TOKENS);
  }
  return modelDefault ?? DEFAULT_CONTEXT_TOKENS;
}

/** Maximum turns retained in memory before old entries are rolled into carryover.
 *  Each TurnStats holds usage + cost + model — at N=200 this caps memory at ~50KB. */
const MAX_TURNS = 200;

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
  /** Native billing unit this turn ran under. Quota-billed turns carry
   *  `cost === 0` — the provider's real unit is plan-window %, never dollars. */
  billingKind: BillingKind;
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

/** How a provider bills its usage — "usd" = token-priced currency (real dollars),
 *  "quota" = plan-window % (ChatGPT plan, cloud Ollama, Antigravity),
 *  "none" = no cost metric (local Ollama). */
export type BillingKind = "usd" | "quota" | "none";

/** Per-provider cumulative session usage in the provider's NATIVE unit. Never
 *  converted between providers: a quota-billed provider never contributes a
 *  dollar figure, and a token-priced provider never contributes a percentage. */
export interface SessionProviderCost {
  kind: BillingKind;
  /** Cumulative USD — only present when kind === "usd". */
  totalCostUsd?: number;
  /** Cumulative plan-window percentage points consumed — only when kind === "quota". */
  quotaUsedPct?: number;
}

/** Which unit a model's provider bills in. The default for callers that don't
 *  resolve billing themselves (the desktop passes a richer resolver that treats
 *  keyless local Ollama as "none"). */
export function billingKindForModel(model: string): BillingKind {
  switch (providerForModel(model)) {
    case "openai":
    case "ollama":
    case "gemini":
      return "quota";
    default:
      return "usd";
  }
}

export interface SessionSummary {
  turns: number;
  totalCostUsd: number;
  totalInputCostUsd: number;
  /** Output-side (completion) cost aggregated across the session. */
  totalOutputCostUsd: number;
  /** Per-provider cumulative costs in each provider's native unit — the source
   *  for `SessionMeta.costByProvider`. Never converted between providers. */
  costByProvider: Record<string, SessionProviderCost>;
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
  /** $ spent on internal context compaction (fold summarizer + triage calls),
   *  kept separate from the agent loop's own per-turn cost. */
  compactionCostUsd: number;
  /** Number of compaction passes (fold summaries + triage) in this process. */
  compactionCount: number;
  /** Prompt (input) tokens consumed by compaction calls. */
  compactionPromptTokens: number;
  /** Completion (output) tokens consumed by compaction calls. */
  compactionCompletionTokens: number;
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
  /** $ spent on internal compaction — isolated from loop cost + cache accounting
   *  because compaction is inherently cache-cold engineering work. */
  private _compactionCost = 0;
  private _compactionPromptTokens = 0;
  private _compactionCompletionTokens = 0;
  private _compactionCount = 0;

  /** Per-provider cumulative session usage, each in the provider's native unit
   *  (USD for token-priced APIs, plan-window % for quota APIs), keyed by provider
   *  id. USD entries mirror legacy costs; quota entries carry only quotaUsedPct. */
  private _providerCosts = new Map<string, SessionProviderCost>();

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
    /** Per-provider native-unit costs from meta — authoritative over the legacy
     *  flat `totalCostUsd` when both exist (the flat figure is the USD-kind sum). */
    costByProvider?: Record<string, SessionProviderCost>;
  }): void {
    let usdCarryover = 0;
    if (opts.costByProvider) {
      for (const [provider, cost] of Object.entries(opts.costByProvider)) {
        if (!cost) continue;
        this._providerCosts.set(provider, {
          kind: cost.kind,
          ...(typeof cost.totalCostUsd === "number" ? { totalCostUsd: cost.totalCostUsd } : {}),
          ...(typeof cost.quotaUsedPct === "number" ? { quotaUsedPct: cost.quotaUsedPct } : {}),
        });
        if (cost.kind === "usd" && typeof cost.totalCostUsd === "number") {
          usdCarryover += cost.totalCostUsd;
        }
      }
    }
    if (typeof opts.totalCostUsd === "number" && opts.totalCostUsd > 0) {
      // Per-provider records win when present (they disambiguate the provider);
      // the legacy flat figure covers pre-decoupling sessions.
      this._carryoverCost = usdCarryover > 0 ? usdCarryover : opts.totalCostUsd;
    } else {
      this._carryoverCost = usdCarryover;
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
    this._compactionCost = 0;
    this._compactionPromptTokens = 0;
    this._compactionCompletionTokens = 0;
    this._compactionCount = 0;
    this._providerCosts.clear();
    this._cacheDiagnostics = [];
  }

  record(
    turn: number,
    model: string,
    usage: Usage,
    cacheDiagnostics?: CacheDiagnostics,
    /** Native billing unit for this call. Quota-billed turns record 0 USD — the
     *  real unit is plan-window %, which the desktop accumulates separately. */
    billingKind: BillingKind = billingKindForModel(model),
  ): TurnStats {
    const cost = billingKind === "usd" ? costUsd(model, usage) : 0;
    const stats: TurnStats = {
      turn,
      model,
      usage,
      cost,
      billingKind,
      cacheHitRatio: usage.cacheHitRatio,
      cacheDiagnostics,
    };
    this.turns.push(stats);
    this.accrueProviderCost(model, billingKind, { costUsd: cost });
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
  recordExternal(
    model: string,
    usage: Usage,
    billing: { kind: BillingKind; quotaUsedPct?: number } = { kind: billingKindForModel(model) },
  ): void {
    if (billing.kind === "usd") {
      const cost = costUsd(model, usage);
      this._carryoverCost += cost;
      this.accrueProviderCost(model, "usd", { costUsd: cost });
    } else if (billing.kind === "quota" && typeof billing.quotaUsedPct === "number") {
      // Native unit: plan-window % consumed, never converted to dollars.
      this.accrueProviderCost(model, "quota", { quotaUsedPct: billing.quotaUsedPct });
    }
    this._carryoverCacheHit += usage.promptCacheHitTokens;
    this._carryoverCacheMiss += usage.promptCacheMissTokens;
    this._carryoverCompletion += usage.completionTokens;
  }

  /** Record an internal compaction call (fold summarizer/triage) into a dedicated
   *  accumulator. No turn entry, so per-turn cost and the cache-hit ratio stay
   *  clean; still reflected in totalCost so session spend stays honest. */
  recordCompaction(
    model: string,
    usage: Usage,
    billingKind: BillingKind = billingKindForModel(model),
  ): void {
    const cost = billingKind === "usd" ? costUsd(model, usage) : 0;
    this._compactionCost += cost;
    this.accrueProviderCost(model, billingKind, { costUsd: cost });
    this._compactionPromptTokens += usage.promptTokens;
    this._compactionCompletionTokens += usage.completionTokens;
    this._compactionCount += 1;
  }

  /** Accrue into the per-provider native-unit bucket. Quota providers never get
   *  a dollar figure; USD providers never get a percentage. Zero-value records
   *  are skipped so an empty quota turn can't clobber a desktop-accumulated delta. */
  private accrueProviderCost(
    model: string,
    kind: BillingKind,
    opts: { costUsd?: number; quotaUsedPct?: number },
  ): void {
    const hasUsd = kind === "usd" && typeof opts.costUsd === "number" && opts.costUsd > 0;
    const hasQuota =
      kind === "quota" && typeof opts.quotaUsedPct === "number" && opts.quotaUsedPct > 0;
    if (!hasUsd && !hasQuota) return;
    const provider = providerForModel(model);
    const cur = this._providerCosts.get(provider);
    if (!cur) {
      this._providerCosts.set(provider, {
        kind,
        ...(hasUsd ? { totalCostUsd: opts.costUsd } : {}),
        ...(hasQuota ? { quotaUsedPct: opts.quotaUsedPct } : {}),
      });
      return;
    }
    if (hasUsd) {
      this._providerCosts.set(provider, {
        ...cur,
        totalCostUsd: (cur.totalCostUsd ?? 0) + (opts.costUsd ?? 0),
      });
    } else if (hasQuota) {
      this._providerCosts.set(provider, {
        ...cur,
        quotaUsedPct: (cur.quotaUsedPct ?? 0) + (opts.quotaUsedPct ?? 0),
      });
    }
  }

  /** Per-provider cumulative native-unit costs — the source of truth for
   *  `SessionMeta.costByProvider`. */
  get providerCosts(): Record<string, SessionProviderCost> {
    const out: Record<string, SessionProviderCost> = {};
    for (const [provider, cost] of this._providerCosts) {
      out[provider] = { ...cost };
    }
    return out;
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
    return (
      this._carryoverCost + this.turns.reduce((sum, t) => sum + t.cost, 0) + this._compactionCost
    );
  }

  get totalClaudeEquivalent(): number {
    // Quota-billed turns have no dollar meaning — the Claude-equivalent
    // reference only applies to token-priced providers.
    return this.turns.reduce(
      (sum, t) => sum + (t.billingKind === "usd" ? claudeEquivalentCost(t.usage) : 0),
      0,
    );
  }

  get savingsVsClaude(): number {
    const c = this.totalClaudeEquivalent;
    return c > 0 ? 1 - this.totalCost / c : 0;
  }

  get totalInputCost(): number {
    return this.turns.reduce(
      (sum, t) => sum + (t.billingKind === "usd" ? inputCostUsd(t.model, t.usage) : 0),
      0,
    );
  }

  get totalOutputCost(): number {
    return this.turns.reduce(
      (sum, t) => sum + (t.billingKind === "usd" ? outputCostUsd(t.model, t.usage) : 0),
      0,
    );
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
      costByProvider: this.providerCosts,
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
      compactionCostUsd: round(this._compactionCost, 6),
      compactionCount: this._compactionCount,
      compactionPromptTokens: this._compactionPromptTokens,
      compactionCompletionTokens: this._compactionCompletionTokens,
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
