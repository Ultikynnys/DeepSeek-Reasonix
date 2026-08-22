import { createHash } from "node:crypto";
import {
  type PrefixDiagnosticHashes,
  prefixDiagnosticHashes,
} from "../telemetry/cache-diagnostics.js";
import type { ChatMessage, ToolSpec } from "../types.js";

export interface ImmutablePrefixOptions {
  system: string;
  toolSpecs?: readonly ToolSpec[];
  fewShots?: readonly ChatMessage[];
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function toolName(spec: ToolSpec): string {
  return spec.function?.name ?? "";
}

/** Name-sorted deterministic copy — the tool list is part of the cache prefix, so
 *  nondeterministic registration order would churn DeepSeek's prompt cache.
 *  Locale-independent codepoint compare — localeCompare would let the host locale reshuffle it. */
export function sortToolSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  return [...specs]
    .map((spec) => structuredClone(spec) as ToolSpec)
    .sort((a, b) => {
      const an = toolName(a);
      const bn = toolName(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
}

export class ImmutablePrefix {
  /** Stable across turns; rebuilt only on /new when REASONIX.md changed on disk. */
  system: string;
  /** Each `addTool` costs one cache-miss turn — DeepSeek's prefix cache is keyed by full tool list. */
  private _toolSpecs: ToolSpec[];
  readonly fewShots: readonly ChatMessage[];
  /** Invalidated by addTool / removeTool / replaceSystem; bypassing any of those leaves cache stale → fingerprint diverges from sent prefix. */
  private _fingerprintCache: string | null = null;
  /** Frozen tool-spec snapshot — avoids structuredClone per iteration. Invalidated by addTool/removeTool. */
  private _frozenToolsCache: ToolSpec[] | null = null;
  /** Diagnostic hash cache keyed by immutable tool snapshots. Invalidated with the prefix caches. */
  private _diagnosticHashesCache = new WeakMap<readonly ToolSpec[], PrefixDiagnosticHashes>();

  constructor(opts: ImmutablePrefixOptions) {
    this.system = opts.system;
    this._toolSpecs = sortToolSpecs(opts.toolSpecs ?? []);
    this.fewShots = Object.freeze([...(opts.fewShots ?? [])]);
  }

  /** Replaces the system prompt; returns true iff the string actually changed. Caller must accept a cache miss on the next turn. */
  replaceSystem(s: string): boolean {
    if (this.system === s) return false;
    this.system = s;
    this.invalidatePrefixCaches();
    return true;
  }

  get toolSpecs(): readonly ToolSpec[] {
    return this._toolSpecs;
  }

  toMessages(): ChatMessage[] {
    return [{ role: "system", content: this.system }, ...this.fewShots.map((m) => ({ ...m }))];
  }

  tools(): ToolSpec[] {
    if (this._frozenToolsCache === null) {
      // Frozen at runtime (mutation would throw in strict mode); typed mutable
      // so existing `ToolSpec[]` call sites compile — no caller mutates the list.
      this._frozenToolsCache = Object.freeze(
        this._toolSpecs.map((t) => structuredClone(t) as ToolSpec),
      ) as ToolSpec[];
    }
    return this._frozenToolsCache;
  }

  addTool(spec: ToolSpec): boolean {
    const name = spec.function?.name;
    if (!name) return false;
    if (this._toolSpecs.some((t) => t.function?.name === name)) return false;
    this._toolSpecs = sortToolSpecs([...this._toolSpecs, spec]);
    this.invalidatePrefixCaches();
    this._frozenToolsCache = null;
    return true;
  }

  /** Mirror of addTool for MCP hot-unbridge. Same cache-miss cost — prefix changes shape. */
  removeTool(name: string): boolean {
    const idx = this._toolSpecs.findIndex((t) => t.function?.name === name);
    if (idx < 0) return false;
    this._toolSpecs.splice(idx, 1);
    this.invalidatePrefixCaches();
    this._frozenToolsCache = null;
    return true;
  }

  get fingerprint(): string {
    if (this._fingerprintCache !== null) return this._fingerprintCache;
    this._fingerprintCache = this.computeFingerprint();
    return this._fingerprintCache;
  }

  /** Per-part prefix hashes for cache diagnostics. Memoized on the passed tool
   *  snapshot (WeakMap) so repeated calls with the same frozen array are free. */
  diagnosticHashes(toolSpecs: readonly ToolSpec[] = this.tools()): PrefixDiagnosticHashes {
    if (Object.isFrozen(toolSpecs)) {
      const cached = this._diagnosticHashesCache.get(toolSpecs);
      if (cached) return cached;
      const hashes = this.computeDiagnosticHashes(toolSpecs);
      this._diagnosticHashesCache.set(toolSpecs, hashes);
      return hashes;
    }
    return this.computeDiagnosticHashes(toolSpecs);
  }

  private invalidatePrefixCaches(): void {
    this._fingerprintCache = null;
    this._diagnosticHashesCache = new WeakMap();
  }

  private computeDiagnosticHashes(toolSpecs: readonly ToolSpec[]): PrefixDiagnosticHashes {
    return prefixDiagnosticHashes({
      system: this.system,
      toolSpecs,
      fewShots: this.fewShots,
    });
  }

  /** Dev/test only — throws on cache drift, which always means a non-`addTool` mutation slipped in. */
  verifyFingerprint(): string {
    const fresh = this.computeFingerprint();
    if (this._fingerprintCache !== null && this._fingerprintCache !== fresh) {
      throw new Error(
        `ImmutablePrefix fingerprint drift: cached=${this._fingerprintCache}, fresh=${fresh}. A mutation path bypassed addTool's cache invalidation — DeepSeek will see prefix churn that the TUI / transcript log don't know about.`,
      );
    }
    this._fingerprintCache = fresh;
    return fresh;
  }

  private computeFingerprint(): string {
    return shortHash({
      system: this.system,
      tools: this._toolSpecs,
      shots: this.fewShots,
    });
  }
}

export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];
  private appendListeners: Array<(msg: ChatMessage) => void> = [];
  private replaceListeners: Array<() => void> = [];
  /** Bumped on log rewrites (compactInPlace) — cache-shape diagnostics use it to
   *  attribute prefix churn to a rewrite rather than a system/tool change. */
  private _rewriteVersion = 0;
  /** Monotonic counter bumped on every mutation. Consumers compare against
   *  their own snapshot to detect staleness without destructive check-and-clear. */
  private _version = 0;

  /** Observe appends (append/extend) — lets ContextManager keep an incremental token total. */
  onAppend(listener: (msg: ChatMessage) => void): void {
    this.appendListeners.push(listener);
  }

  /** Observe full-array replacement (compactInPlace) — cached totals must be invalidated. */
  onReplace(listener: () => void): void {
    this.replaceListeners.push(listener);
  }

  append(message: ChatMessage): void {
    if (!message || typeof message !== "object" || !("role" in message)) {
      throw new Error(`invalid log entry: ${JSON.stringify(message)}`);
    }
    this._entries.push(message);
    this._version++;
    for (const l of this.appendListeners) l(message);
  }

  extend(messages: ChatMessage[]): void {
    for (const m of messages) this.append(m);
  }

  /** The one append-only-breaking path — reserved for `/compact` + recovery. Use `append()` otherwise. */
  compactInPlace(replacement: ChatMessage[]): void {
    this._entries = [...replacement];
    this._rewriteVersion++;
    this._version++;
    for (const l of this.replaceListeners) l();
  }

  get entries(): readonly ChatMessage[] {
    return this._entries;
  }

  toMessages(): ChatMessage[] {
    return this._entries.map((e) => ({ ...e }));
  }

  get length(): number {
    return this._entries.length;
  }

  /** Monotonic counter bumped on every log rewrite (compactInPlace) — cache
   *  diagnostics use it to detect that the prefix changed via a rewrite. */
  get rewriteVersion(): number {
    return this._rewriteVersion;
  }

  /** Monotonic version counter — bumped on every mutation (append/extend/
   *  compactInPlace). Consumers store their own snapshot and compare to detect
   *  staleness (non-destructive). */
  get version(): number {
    return this._version;
  }
}

export class VolatileScratch {
  reasoning: string | null = null;
  planState: Record<string, unknown> | null = null;
  notes: string[] = [];

  reset(): void {
    this.reasoning = null;
    this.planState = null;
    this.notes = [];
  }
}
