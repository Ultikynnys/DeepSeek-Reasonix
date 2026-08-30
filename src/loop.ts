import { messageOf } from "@reasonix/core-utils";
import { type DeepSeekClient, Usage } from "./client.js";
import { type EditMode, type ReasoningEffort, providerForModel } from "./config.js";
import type { PauseGate } from "./core/pause-gate.js";
import { pauseGate as defaultPauseGate } from "./core/pause-gate.js";
import { type ResolvedHook, runHooks } from "./hooks.js";
import { DEFAULT_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_TOKENS } from "./mcp/registry.js";

import { ContextManager, type FoldResult, TURN_START_FOLD_THRESHOLD } from "./context-manager.js";
import { InflightSet } from "./core/inflight.js";
import { t } from "./i18n/index.js";
import { dispatchToolCallsChunked } from "./loop/dispatch.js";
import {
  errorMeta,
  formatLoopError,
  is4xxError,
  is5xxError,
  isDeepSeekHost,
  probeDeepSeekReachable,
} from "./loop/errors.js";
import {
  type ForceSummaryContext,
  type ForceSummaryReason,
  forceSummaryAfterIterLimit,
} from "./loop/force-summary.js";
import {
  fixToolCallPairing,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  stampMissingReasoningForThinkingMode,
} from "./loop/healing.js";
import { hookWarnings, safeParseToolArgs } from "./loop/hook-events.js";
import { buildAssistantMessage, buildSyntheticAssistantMessage } from "./loop/messages.js";
import { stripDroppableReasoningContent } from "./loop/reasoning-retention.js";
import {
  looksLikeCompleteJson,
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResults,
  shrinkOversizedToolResultsByTokens,
} from "./loop/shrink.js";
import { streamModelResponse } from "./loop/streaming.js";
import {
  isThinkingModeModel,
  stripHallucinatedToolMarkup,
  thinkingModeForModel,
} from "./loop/thinking.js";
import type { LoopEvent } from "./loop/types.js";
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory/runtime.js";
import {
  appendSessionMessage,
  archiveSession,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
} from "./memory/session.js";
import { ToolCallRepair } from "./repair/index.js";
import {
  type PrefixDiagnosticHashes,
  appendCacheDiagnostic,
  buildCacheDiagnostic,
  latestCacheDiagnostic,
} from "./telemetry/cache-diagnostics.js";
import {
  type BillingKind,
  type CacheDiagnostics,
  SessionStats,
  type TurnStats,
  billingKindForModel,
} from "./telemetry/stats.js";
import { countTokensBounded } from "./tokenizer.js";
import { ToolRegistry, isReadOnlyTool } from "./tools.js";
import { ReadTracker } from "./tools/read-tracker.js";
import { USER_CANCEL_NOTE } from "./tools/shell.js";
import type { ChatMessage, ToolCall, ToolSpec, TurnImage, UserContentPart } from "./types.js";

export const MID_TURN_STEER_WRAPPER =
  "[Mid-turn steer queued by the user. Do not treat this as a new task; use it only as additional guidance for the current task after completing the current step.]";

function formatSteerUserMessage(content: string): string {
  return [MID_TURN_STEER_WRAPPER, content].join("\n");
}

function parseNeedsProEscalation(content: string): boolean {
  return /^\s*<<<NEEDS_PRO(?::\s*[^>\n]{1,150})?>>>/.test(content);
}

/** Coerce caller-supplied images (plain data URLs or richer descriptors) into
 *  TurnImage descriptors. */
function toTurnImages(images?: ReadonlyArray<string | TurnImage>): TurnImage[] {
  if (!images) return [];
  return images.map((d) => (typeof d === "string" ? { url: d } : d));
}

/** User content for the log/request: plain text when no images are attached
 *  (prefix-cache stable); content parts when they are — image URLs for the
 *  vision API plus source file paths so the agent can open/modify them. */
function buildUserContent(
  text: string,
  images?: ReadonlyArray<TurnImage>,
): string | UserContentPart[] {
  if (!images || images.length === 0) return text;
  const parts: UserContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  const paths = images.filter((d) => d.path).map((d) => d.path as string);
  if (paths.length > 0) {
    parts.push({
      type: "text",
      text: `Attached image file(s) — you can open and modify these with your file tools:\n${paths.map((p) => `- ${p}`).join("\n")}`,
    });
  }
  for (const d of images) {
    parts.push({ type: "image_url", image_url: { url: d.url, detail: "low" } });
  }
  return parts;
}

/** Collapse a content-parts tool result to a display string for string-typed
 *  consumers (hooks, LoopEvent.content). Image parts are noted, not dumped. */
function contentPartsToString(parts: UserContentPart[]): string {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const imageCount = parts.filter((p) => p.type === "image_url").length;
  const imageNote = imageCount > 0 ? `\n[${imageCount} image(s) attached]` : "";
  return `${text}${imageNote}`.trim();
}

export {
  fixToolCallPairing,
  formatLoopError,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  isThinkingModeModel,
  looksLikeCompleteJson,
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResults,
  shrinkOversizedToolResultsByTokens,
  stampMissingReasoningForThinkingMode,
  stripHallucinatedToolMarkup,
  thinkingModeForModel,
};
export type { EventRole, LoopEvent } from "./loop/types.js";

export interface CacheFirstLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  tools?: ToolRegistry;
  model?: string;
  stream?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Per-turn output token cap passed as `max_tokens`. Undefined = no cap (server default). */
  maxOutputTokens?: number;
  /** Maximum tool-call iterations per turn. Overrides config/env. Default 50. */
  maxIterPerTurn?: number;
  /** Live edit-mode getter — yolo never pauses on the iteration cap. Thunk
   *  (not a snapshot) so a mid-session Shift+Tab flip takes effect, same
   *  pattern as shell.ts's `allowAll`. */
  getEditMode?: () => EditMode;
  /** Soft USD cap — warns at 80%, refuses next turn at 100%. Opt-in (default no cap). */
  budgetUsd?: number;
  /** Resolves the native billing unit for a model id ("usd" | "quota" | "none").
   *  Defaults to a provider-based guess; the desktop passes a resolver that knows
   *  keyless local Ollama is "none". Quota turns record 0 USD — never converted. */
  billingKindFor?: (model: string) => BillingKind;
  /** User-configured context-window cap (tokens), forwarded to the ContextManager.
   *  Undefined = per-model default. Hot-applied via configure(). */
  ctxMaxOverride?: number;
  session?: string;
  /** PreToolUse + PostToolUse only — UserPromptSubmit / Stop live at the App boundary. */
  hooks?: ResolvedHook[];
  /** `cwd` reported to hooks; `reasonix code` sets this to the sandbox root, not shell home. */
  hookCwd?: string;
  /** PauseGate bridge — defaults to singleton, injectable for tests. */
  confirmationGate?: PauseGate;
  /** Re-runs the prompt builder (applyMemoryStack / codeSystemPrompt) on /new so REASONIX.md edits take effect without a restart. Accepting a cache miss is the price. */
  rebuildSystem?: () => string;
  /** Host hook fired at the start of every compaction so live background
   *  shells can be force-cancelled before history is replaced. */
  onPreCompaction?: () => void | Promise<void>;
}

export interface ReconfigurableOptions {
  model?: string;
  stream?: boolean;
  /** V4 thinking mode only; deepseek-chat ignores. */
  reasoningEffort?: ReasoningEffort;
  /** Per-turn output token cap. Pass null to clear. */
  maxOutputTokens?: number | null;
  /** Context-window cap override (tokens); undefined = per-model default. `null` = clear a set override. */
  ctxMaxOverride?: number | null;
}

export interface LoopAbortOptions {
  /** Explicit user interrupts can discard the unfinished turn so the next prompt starts clean. */
  discardCurrentTurn?: boolean;
}

interface CacheShapeSnapshot {
  systemHash: string;
  toolsHash: string;
  fewShotsHash: string;
  prefixHash: string;
  logRewriteVersion: number;
  toolSchemaTokens: number;
}

function shrinkMessageForRetention(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
  return (
    shrinkOversizedToolCallArgsByTokens([message], DEFAULT_MAX_RESULT_TOKENS).messages[0] ?? message
  );
}

export class CacheFirstLoop {
  readonly client: DeepSeekClient;
  readonly prefix: ImmutablePrefix;
  readonly tools: ToolRegistry;
  readonly log = new AppendOnlyLog();
  readonly scratch = new VolatileScratch();
  readonly stats = new SessionStats();
  readonly repair: ToolCallRepair;
  /** Hard iteration cap per turn — prevents runaway tool-call loops from
   *  burning unlimited API budget. The model gets one final force-summary
   *  call when the cap fires. Override via REASONIX_MAX_ITER env var. */
  static readonly DEFAULT_MAX_ITER_PER_TURN = 50;
  /** Ollama length-truncation continuations allowed per turn — a model stuck
   *  regenerating a partial answer must not loop forever. */
  static readonly MAX_OLLAMA_CONTINUATIONS = 3;
  /** Consecutive identical-reasoning iterations before the reasoning-loop guard
   *  collapses the turn to a forced summary. */
  static readonly REASONING_LOOP_LIMIT = 3;
  /** Files the model has read this session; gates edit_file / multi_edit so SEARCH text matches on-disk bytes. Cleared on fold / mechanical truncate (the model's byte-level view of the elided history is gone). In-memory only — naturally empty on resume. */
  readonly readTracker = new ReadTracker();

  // Mutable via configure() — slash commands in the TUI / library callers tweak
  // these mid-session so users don't have to restart.
  model: string;
  stream: boolean;
  reasoningEffort: ReasoningEffort;
  /** Per-turn output token cap (max_tokens). Undefined = no cap. */
  maxOutputTokens: number | undefined;
  /** Maximum tool-call iterations per turn. Config > env > default (50). */
  maxIterPerTurn: number;
  budgetUsd: number | null;
  /** One-shot 80% warning latch — cleared by setBudget so a bump re-arms at the new boundary. */
  private _budgetWarned = false;
  /** Context-window cap override (tokens) — mutable via configure(); undefined = per-model default. */
  ctxMaxOverride: number | undefined;
  sessionName: string | null;

  hooks: ResolvedHook[];
  hookCwd: string;

  /** PauseGate bridge — defaults to singleton, injectable for tests. */
  readonly confirmationGate: PauseGate;

  /** Number of messages that were pre-loaded from the session file. */
  readonly resumedMessageCount: number;

  private readonly _rebuildSystem: (() => string) | null;

  /** Native billing unit resolver — see CacheFirstLoopOptions.billingKindFor. */
  private readonly _billingKindFor: (model: string) => BillingKind;

  private _turn = 0;
  private _streamPreference: boolean;
  /** Threaded through HTTP + every tool dispatch so Esc cancels in-flight work, not after. */
  private _turnAbort: AbortController = new AbortController();
  /** True once the first step() iteration has begun. Distinguishes a carry-worthy
   *  pre-first-step abort (subagent attach race) from a stale post-completion abort
   *  that belonged to an already-finished turn and must be dropped. */
  private _stepStarted = false;
  private _discardAbortRequested = false;
  /** Per-tool-call aborts keyed by inflight id — a TUI Stop click cancels exactly the card's own tool. Cleaned in runOneToolCall's finally. */
  private readonly _toolCancelControllers = new Map<string, AbortController>();
  /** Most-recently-started controller — Ctrl+K / desktop Stop target "the running tool" without a callId. */
  private _lastToolCancelController: AbortController | null = null;
  /** Authoritative running-id set — UI cards consult this instead of trusting end-event delivery. Insert at dispatch entry, delete in finally. */
  private readonly _inflight = new InflightSet();
  /** Dispatched call ids whose results have not been appended. A force-closed
   *  turn (desktop Send now / queue force) abandons these mid-dispatch; they
   *  stay behind so the next step can stub them as cancellations. */
  private readonly _abandonedCalls = new Set<string>();

  /** Typeahead steer messages set by the UI; step() consumes one at each iter boundary. */
  private readonly _steerQueue: string[] = [];

  /** Set true when a steer was consumed this turn; cleared on next step() entry. */
  private _steerConsumed = false;

  /** Turn images — data URLs for the vision API plus source file paths. URLs
   *  reach see_image's ctx; paths are surfaced in the user message so the
   *  agent can open/modify the source files. */
  private _turnImages: readonly TurnImage[] = [];

  /** UI calls this to inject a mid-turn steer message without aborting the current turn.
   *  New text resets steerConsumed because a fresh steer is queued. */
  steer(text: string | null): void {
    if (text === null) {
      this._steerQueue.length = 0;
      return;
    }
    this._steerQueue.push(text);
    this._steerConsumed = false;
  }

  /** True when a steer was consumed this turn (UI gate to avoid double-submit). */
  get steerConsumed(): boolean {
    return this._steerConsumed;
  }

  private _turnSelfCorrected = false;
  /** Grace-window size granted when the iter cap fires on a productive turn. Set once per turn, at first fire. */
  private _iterGrace = 0;
  /** True once the cap fired and the grace window latched this turn. The hard stop moves to maxIterPerTurn + _iterGrace. */
  private _iterGraceApplied = false;
  /** True once a yolo turn bypassed the cap — the cap block is skipped for the rest of the turn. */
  private _iterCapBypassed = false;
  /** Live edit-mode getter — hosts that don't pass it keep the default pause. */
  private readonly _getEditMode: (() => EditMode) | undefined;
  private _foldedThisTurn = false;
  /** Latched once per turn — the empty-completion guard retries exactly once. */
  private _emptyResponseRetried = false;
  /** Latched once per turn — replay one provider failure before any output reached the UI. */
  private _providerErrorRetried = false;
  /** Count of ollama length-truncation continuations this turn — caps the resume loop. */
  private _ollamaContinuations = 0;
  /** Normalized reasoning text from the previous iteration — detects a model
   *  re-thinking the identical thought (a reasoning-only loop) when tool args
   *  drift so the storm breaker can't fire. */
  private _lastReasoningSig: string | null = null;
  /** Consecutive iterations with the same reasoning sig and no content. */
  private _reasoningLoopCount = 0;
  private context!: ContextManager;
  /** Prefix-shape snapshot of the last sent request — next turn's churn is attributed against it. */
  private _lastCacheShape: CacheShapeSnapshot | null = null;
  /** Stable ids for compaction card events — pairs compaction_start with compaction_end. */
  private _compactionSeq = 0;
  /** True while a compaction is in flight — blocks new tool dispatch. */
  private _compacting = false;
  /** Host hook that force-cancels background jobs before compaction. */
  private readonly _onPreCompaction: (() => void | Promise<void>) | null;

  /** Subscribe API so UI hooks can derive `running` from finally-guaranteed insertions. */
  get inflight(): InflightSet {
    return this._inflight;
  }

  get currentTurn(): number {
    return this._turn;
  }

  /** True while a compaction fold is in flight — blocks new tool dispatch.
   *  Exposed so the host can gate /compact against a cancelled turn's
   *  still-running background fold, avoiding overlapping log rewrites. */
  get isCompacting(): boolean {
    return this._compacting;
  }

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    this.model = opts.model ?? "deepseek-v4-flash";
    this.reasoningEffort = opts.reasoningEffort ?? "high";
    this.maxOutputTokens = opts.maxOutputTokens;
    this.maxIterPerTurn = opts.maxIterPerTurn ?? CacheFirstLoop.DEFAULT_MAX_ITER_PER_TURN;
    this._getEditMode = opts.getEditMode;
    this.budgetUsd =
      typeof opts.budgetUsd === "number" && opts.budgetUsd > 0 ? opts.budgetUsd : null;
    this.ctxMaxOverride = opts.ctxMaxOverride;

    this.hooks = opts.hooks ?? [];
    this.hookCwd = opts.hookCwd ?? process.cwd();
    this.confirmationGate = opts.confirmationGate ?? defaultPauseGate;
    this._rebuildSystem = opts.rebuildSystem ?? null;
    this._billingKindFor = opts.billingKindFor ?? billingKindForModel;
    this._onPreCompaction = opts.onPreCompaction ?? null;

    this._streamPreference = opts.stream ?? true;
    this.stream = this._streamPreference;

    const allowedNames = new Set([...this.prefix.toolSpecs.map((s) => s.function.name)]);
    // Storm breaker clears its window on mutating calls so read → edit → verify isn't a storm.
    const registry = this.tools;
    const isStormExempt = (call: ToolCall): boolean => {
      const name = call.function?.name;
      if (!name) return false;
      return registry.get(name)?.stormExempt === true;
    };
    this.repair = new ToolCallRepair({
      allowedToolNames: allowedNames,
      isMutating: (call) => this.isMutating(call),
      isStormExempt,
      stormThreshold: parsePositiveIntEnv(process.env.REASONIX_STORM_THRESHOLD),
      stormWindow: parsePositiveIntEnv(process.env.REASONIX_STORM_WINDOW),
    });

    // Heal-on-load: oversized tool results would 400 the next call before the user types.
    this.sessionName = opts.session ?? null;
    if (this.sessionName) {
      const prior = loadSessionMessages(this.sessionName);
      const shrunk = healLoadedMessagesByTokens(prior, DEFAULT_MAX_RESULT_TOKENS);
      // Thinking-mode sessions still need tool-call reasoning_content, while stale
      // plain-turn reasoning can be dropped before it bloats long-session requests.
      const stamped = stampMissingReasoningForThinkingMode(shrunk.messages, this.model);
      const pruned = stripDroppableReasoningContent(stamped.messages);
      const messages = pruned.messages;
      const healedCount = shrunk.healedCount + stamped.stampedCount;
      const tokensSaved = shrunk.tokensSaved;
      for (const msg of messages) this.log.append(msg);
      this.resumedMessageCount = messages.length;
      this._turn = messages.reduce((n, m) => (m.role === "assistant" ? n + 1 : n), 0);
      // Carry forward cumulative cost / turn count so the TUI's session
      // total continues across resumes; otherwise each restart resets to $0.
      if (messages.length > 0) {
        const meta = loadSessionMeta(this.sessionName);
        this.stats.seedCarryover({
          totalCostUsd: meta.totalCostUsd,
          turnCount: meta.turnCount,
          cacheHitTokens: meta.cacheHitTokens,
          cacheMissTokens: meta.cacheMissTokens,
          totalCompletionTokens: meta.totalCompletionTokens,
          lastPromptTokens: meta.lastPromptTokens,
          costByProvider: meta.costByProvider,
        });
      }
      if (healedCount > 0 || pruned.prunedCount > 0) {
        // Persist healed log so the same break isn't re-noticed every restart.
        this.persistLog(messages);
        if (healedCount > 0) {
          process.stderr.write(
            `▸ session "${this.sessionName}": healed ${healedCount} entr${healedCount === 1 ? "y" : "ies"}${tokensSaved > 0 ? ` (shrunk ${tokensSaved.toLocaleString()} tokens of oversized tool output/arguments)` : " (dropped dangling tool_calls tail)"}. Rewrote session file.\n`,
          );
        }
      }
    } else {
      this.resumedMessageCount = 0;
    }

    this.context = new ContextManager({
      client: this.client,
      log: this.log,
      stats: this.stats,
      sessionName: this.sessionName,
      ctxMaxOverride: this.ctxMaxOverride,
      getCurrentTurn: () => this._turn,
      getSystemPrompt: () => this.prefix.system,
      getToolSpecs: () => this.prefix.toolSpecs,
      getFewShots: () => this.prefix.fewShots,
      onLogRewrite: () => this.readTracker.reset(),
    });
  }

  /** Replace older turns with one summary message; keep tail within keepRecentTokens budget. */
  async compactHistory(opts?: {
    keepRecentTokens?: number;
    protectActiveExchange?: boolean;
  }): Promise<FoldResult> {
    return this.context.fold(this.model, opts);
  }

  /** User-triggered /compact — same compaction card lifecycle as auto folds,
   *  consumed through the SAME LoopEvent stream as tool / reasoning / shell
   *  actions so every compaction form shares one pipeline. */
  async *compactHistoryWithEvents(opts?: {
    keepRecentTokens?: number;
  }): AsyncGenerator<LoopEvent, FoldResult, void> {
    return yield* this.compactionEvents(
      `compaction-${++this._compactionSeq}`,
      "user",
      "fold",
      undefined,
      () => this.foldRun({ keepRecentTokens: opts?.keepRecentTokens }),
    );
  }

  /** Real-time token count of the current log — forwarded to Desktop for meter refresh. */
  getCurrentLogTokens(): number {
    return this.context.getLogTokens();
  }

  appendAndPersist(message: ChatMessage): void {
    const retained = shrinkMessageForRetention(message);
    this.log.append(retained);
    if (this.sessionName) {
      try {
        appendSessionMessage(this.sessionName, retained);
      } catch (err) {
        // Disk full or permission denied shouldn't kill the chat — but the
        // failure must be LOUD, never a silent drop of the on-disk transcript.
        process.stderr.write(`reasonix: session append failed — ${messageOf(err)}\n`);
      }
    }
  }

  /** Swap the just-appended assistant entry — used by self-correction to restore the original tool_calls without dropping reasoning_content. */
  private replaceTailAssistantMessage(message: ChatMessage): void {
    const retained = shrinkMessageForRetention(message);
    const entries = this.log.entries;
    const tail = entries[entries.length - 1];
    if (!tail || tail.role !== "assistant") return;
    const kept = entries.slice(0, -1);
    kept.push(retained);
    this.log.compactInPlace(kept);
    this.persistLog(kept);
  }

  private archiveCurrentSession(action: "reset" | "switch"): string | null {
    if (!this.sessionName) return null;
    try {
      const archived = archiveSession(this.sessionName);
      if (archived === null) this.persistLog([]);
      return archived;
    } catch (err) {
      /* disk issue shouldn't block the in-memory reset — but LOG */
      process.stderr.write(`reasonix: session ${action} persist failed — ${messageOf(err)}\n`);
      return null;
    }
  }

  private resetTransientState(): void {
    this.scratch.reset();
    this._inflight.clear();
    this._abandonedCalls.clear();
    // Drain leftover steer text — otherwise the first step() after /new
    // injects it as a user message and the next turn leaks prior intent.
    this._steerQueue.length = 0;
    this._steerConsumed = false;
    this._userTurnCount = 0;
  }

  private rebuildSystemPrompt(): boolean {
    if (!this._rebuildSystem) return false;
    try {
      return this.prefix.replaceSystem(this._rebuildSystem());
    } catch (err) {
      /* builder threw — keep prior system rather than crash a reset, but LOG */
      process.stderr.write(`reasonix: system prompt rebuild failed — ${messageOf(err)}\n`);
      return false;
    }
  }

  /** "New chat" — drops in-memory messages, archives the on-disk transcript so it survives in Sessions, keeps sessionName so the prefix cache stays warm. Re-runs the system-prompt builder if one was wired (issue #778: REASONIX.md edits otherwise need a restart). */
  clearLog(): { dropped: number; archived: string | null; systemRebuilt: boolean } {
    const dropped = this.log.length;
    this.log.compactInPlace([]);
    const archived = this.archiveCurrentSession("reset");
    this.resetTransientState();
    this.stats.reset();
    this._turn = 0;
    this._budgetWarned = false;
    this._lastCacheShape = null;
    const systemRebuilt = this.rebuildSystemPrompt();
    return { dropped, archived, systemRebuilt };
  }

  /** `/cwd` follow-through — archives the previous session, drops in-memory state, repoints sessionName, and rebuilds the system prompt against whatever the rebuilder closure now resolves (the caller is expected to have already updated the root the closure reads). */
  switchWorkspace(opts: { sessionName: string }): { dropped: number; archived: string | null } {
    const dropped = this.log.length;
    const archived = this.archiveCurrentSession("switch");
    this.log.compactInPlace([]);
    this.resetTransientState();
    this.sessionName = opts.sessionName;
    this._lastCacheShape = null;
    this.rebuildSystemPrompt();
    return { dropped, archived };
  }

  configure(opts: ReconfigurableOptions): void {
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.stream !== undefined) {
      this._streamPreference = opts.stream;
      this.stream = opts.stream;
    }
    if (opts.reasoningEffort !== undefined) this.reasoningEffort = opts.reasoningEffort;
    if (opts.maxOutputTokens !== undefined) {
      this.maxOutputTokens = opts.maxOutputTokens ?? undefined;
    }
    if (opts.ctxMaxOverride !== undefined) {
      const v = opts.ctxMaxOverride ?? undefined;
      this.ctxMaxOverride = v;
      this.context.ctxMaxOverride = v;
    }
  }

  /** `null` disables the cap; any change re-arms the 80% warning. */
  setBudget(usd: number | null): void {
    this.budgetUsd = typeof usd === "number" && usd > 0 ? usd : null;
    this._budgetWarned = false;
  }

  /** UI surface — model id of the call about to run (or running) right now. */
  get currentCallModel(): string {
    return this.model;
  }

  /** A call counts as mutating when its definition reports `readOnly !== true` and any dynamic `readOnlyCheck` doesn't override that for these args. */
  private isMutating(call: ToolCall): boolean {
    const name = call.function?.name;
    if (!name) return false;
    const def = this.tools.get(name);
    if (!def) return false;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments ?? "{}") ?? {};
    } catch (err) {
      // Malformed args → fall through to the static flag below; the
      // dynamic check would've thrown anyway. But LOG the corrupt payload.
      process.stderr.write(`reasonix: malformed tool call arguments — ${messageOf(err)}\n`);
    }
    return !isReadOnlyTool(def, args);
  }

  private async runOneToolCall(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{
    preWarnings: LoopEvent[];
    postWarnings: LoopEvent[];
    result: string | UserContentPart[];
  }> {
    const name = call.function?.name ?? "";
    const args = call.function?.arguments ?? "{}";
    const parsedArgs = safeParseToolArgs(args);
    // Compaction dispatch lock: while a fold / force-summary / /compact is
    // running, refuse to start any new tool so nothing begins mid-compaction
    // and gets orphaned by the log replacement.
    if (this._compacting) {
      return {
        preWarnings: [],
        postWarnings: [],
        result: JSON.stringify({
          error: "compaction in progress — tool call deferred until it completes",
        }),
      };
    }
    const inflightId = this.inflightIdFor(call);
    this._inflight.add(inflightId);
    let cancelController: AbortController | null = null;
    try {
      const preReport = await runHooks({
        hooks: this.hooks,
        payload: {
          event: "PreToolUse",
          cwd: this.hookCwd,
          toolName: name,
          toolArgs: parsedArgs,
        },
      });
      const preWarnings = [...hookWarnings(preReport.outcomes, this._turn)];

      if (preReport.blocked) {
        const blocking = preReport.outcomes[preReport.outcomes.length - 1];
        const reason = (
          blocking?.stderr ||
          blocking?.stdout ||
          "blocked by PreToolUse hook"
        ).trim();
        return {
          preWarnings,
          postWarnings: [],
          result: `[hook block] ${blocking?.hook.command ?? "<unknown>"}\n${reason}`,
        };
      }

      // Rotate the per-tool-call cancel controller so a stale cancel from a
      // prior tool can't kill the current one. Keyed by the inflight id so a
      // TUI Stop click cancels exactly this card's tool even when several run
      // in parallel. Shell tools merge this with the turn signal; Ctrl+K /
      // desktop Stop fires only the most recent one.
      cancelController = new AbortController();
      this._toolCancelControllers.set(inflightId, cancelController);
      this._lastToolCancelController = cancelController;
      const result = await this.tools.dispatch(name, args, {
        signal,
        turn: this._turn,
        callId: inflightId,
        cancelSignal: cancelController.signal,
        maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
        confirmationGate: this.confirmationGate,
        readTracker: this.readTracker,
        rootDir: this.hookCwd,
        images: this._turnImages.map((d) => d.url),
      });

      const postReport = await runHooks({
        hooks: this.hooks,
        payload: {
          event: "PostToolUse",
          cwd: this.hookCwd,
          toolName: name,
          toolArgs: parsedArgs,
          toolResult: Array.isArray(result) ? contentPartsToString(result) : result,
        },
      });
      const postWarnings = [...hookWarnings(postReport.outcomes, this._turn)];

      return { preWarnings, postWarnings, result };
    } finally {
      this._inflight.delete(inflightId);
      if (cancelController !== null) {
        this._toolCancelControllers.delete(inflightId);
        if (this._lastToolCancelController === cancelController) {
          this._lastToolCancelController = null;
        }
      }
    }
  }

  /** Stable per-call id used as the inflight key AND threaded into tool_start / tool events so the UI matches them up. */
  private inflightIdFor(call: ToolCall): string {
    if (call.id) return call.id;
    const fallback = (call as { _inflightFallback?: string })._inflightFallback;
    if (fallback) return fallback;
    const generated = `inflight-${++this._inflightCounter}`;
    (call as { _inflightFallback?: string })._inflightFallback = generated;
    return generated;
  }
  private _inflightCounter = 0;

  // Cached result from the last healActiveLogBeforeSend() pass.
  // Invalidated when the log version changes (append/compactInPlace).
  private _healedCache: ChatMessage[] | null = null;
  private _healedVersion = -1;

  /** Running count of user turns processed so far. */
  private _userTurnCount = 0;

  private buildMessages(): ChatMessage[] {
    const healedMessages = this.healActiveLogBeforeSend();
    return [...this.prefix.toMessages(), ...healedMessages];
  }

  private cacheShapeForRequest(
    prefixEvidence: PrefixDiagnosticHashes,
    toolSpecs: readonly ToolSpec[],
  ): CacheShapeSnapshot {
    return {
      systemHash: prefixEvidence.systemHash,
      toolsHash: prefixEvidence.toolSpecsHash,
      fewShotsHash: prefixEvidence.fewShotsHash,
      prefixHash: prefixEvidence.prefixHash,
      logRewriteVersion: this.log.rewriteVersion,
      toolSchemaTokens: countTokensBounded(JSON.stringify(toolSpecs)),
    };
  }

  private cacheDiagnosticsForUsage(
    shape: CacheShapeSnapshot,
    usage: TurnStats["usage"] | null,
  ): CacheDiagnostics {
    const prev = this._lastCacheShape;
    const prefixChangeReasons: CacheDiagnostics["prefixChangeReasons"] = [];
    if (prev) {
      if (prev.systemHash !== shape.systemHash) prefixChangeReasons.push("system");
      if (prev.toolsHash !== shape.toolsHash) prefixChangeReasons.push("tools");
      if (prev.fewShotsHash !== shape.fewShotsHash) prefixChangeReasons.push("few_shots");
      if (prev.logRewriteVersion !== shape.logRewriteVersion) {
        prefixChangeReasons.push("log_rewrite");
      }
    }
    return {
      prefixHash: shape.prefixHash,
      prefixChanged: prefixChangeReasons.length > 0,
      prefixChangeReasons,
      systemHash: shape.systemHash,
      toolsHash: shape.toolsHash,
      fewShotsHash: shape.fewShotsHash,
      logRewriteVersion: shape.logRewriteVersion,
      toolSchemaTokens: shape.toolSchemaTokens,
      promptCacheMissTokens: usage?.promptCacheMissTokens ?? 0,
      promptCacheHitTokens: usage?.promptCacheHitTokens ?? 0,
    };
  }

  private healActiveLogBeforeSend(): ChatMessage[] {
    // Skip the expensive 3-pass healing pipeline when the log hasn't
    // changed since the last call — the common case between iterations
    // where no new messages were appended.
    if (this._healedCache && this._healedVersion === this.log.version) {
      return this._healedCache;
    }
    const current = this.log.toMessages();
    const healed = healLoadedMessages(current, DEFAULT_MAX_RESULT_CHARS);
    const argsShrunk = shrinkOversizedToolCallArgsByTokens(
      healed.messages,
      DEFAULT_MAX_RESULT_TOKENS,
    );
    const pruned = stripDroppableReasoningContent(argsShrunk.messages);
    if (healed.healedCount === 0 && argsShrunk.healedCount === 0 && pruned.prunedCount === 0) {
      this._healedCache = current;
      this._healedVersion = this.log.version;
      return current;
    }
    this.log.compactInPlace(pruned.messages);
    this._healedCache = pruned.messages;
    this._healedVersion = this.log.version;
    this.persistLog(pruned.messages);
    return pruned.messages;
  }

  abort(opts: LoopAbortOptions = {}): void {
    if (opts.discardCurrentTurn) this._discardAbortRequested = true;
    this._turnAbort.abort();
  }

  /** Cancel the running tool call without aborting the turn. Ctrl+K / desktop
   *  Stop kills the subprocess; the tool returns `cancelledByUser:true` and
   *  the conversation continues. Targets the most recent tool; no-op if none. */
  cancelCurrentTool(_reason: string): void {
    this._lastToolCancelController?.abort();
  }

  /** Cancel exactly one running tool call (the TUI Stop button on a shell card). */
  cancelToolCall(callId: string, _reason: string): void {
    this._toolCancelControllers.get(callId)?.abort();
  }

  /** Force-cancel in-flight tools + subagents and background shells so a
   *  fold never orphans live work. */
  private async cancelActiveTasks(): Promise<void> {
    for (const ctrl of this._toolCancelControllers.values()) ctrl.abort();
    this._lastToolCancelController?.abort();
    try {
      await this._onPreCompaction?.();
    } catch (err) {
      // Background cancellation must never block compaction, but must be LOUD.
      process.stderr.write(`reasonix: pre-compaction cancel failed — ${messageOf(err)}\n`);
    }
  }

  private resetAbortState(): void {
    this._turnAbort = new AbortController();
    this._discardAbortRequested = false;
  }

  /** Persist the on-disk transcript after an in-memory mutation; a disk failure
   *  must never block the loop, but it must never be silent either. */
  private persistLog(messages: ChatMessage[]): boolean {
    if (!this.sessionName) return true;
    try {
      rewriteSession(this.sessionName, messages);
      return true;
    } catch (err) {
      process.stderr.write(`reasonix: session persist failed — ${messageOf(err)}\n`);
      return false;
    }
  }

  /** Stub tool results for calls a force-closed turn abandoned mid-dispatch,
   *  so healing doesn't silently drop them and the model reads "cancelled"
   *  instead of guessing the tool failed. Idempotent; returns stub count. */
  private settleAbandonedToolCalls(): number {
    if (this._abandonedCalls.size === 0) return 0;
    const entries = this.log.entries;
    let target = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i]!;
      if (
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((c) => c.id !== undefined && this._abandonedCalls.has(c.id))
      ) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      this._abandonedCalls.clear();
      return 0;
    }
    const settled = new Set<string>();
    for (let j = target + 1; j < entries.length; j++) {
      const m = entries[j]!;
      if (m.role === "tool" && m.tool_call_id) settled.add(m.tool_call_id);
    }
    const missing = entries[target]!.tool_calls!.filter(
      (c) => c.id !== undefined && this._abandonedCalls.has(c.id) && !settled.has(c.id),
    );
    this._abandonedCalls.clear();
    if (missing.length === 0) return 0;
    const content = JSON.stringify({
      cancelledByUser: true,
      error: `Tool call cancelled because the conversation stopped. ${USER_CANCEL_NOTE}`,
    });
    for (const call of missing) {
      this.appendAndPersist({
        role: "tool",
        tool_call_id: call.id ?? "",
        name: call.function?.name ?? "",
        content,
      });
    }
    return missing.length;
  }

  private discardLogFrom(index: number): void {
    const preserved = this.log.entries.slice(0, index).map((m) => ({ ...m }));
    this.log.compactInPlace(preserved);
    this.persistLog(preserved);
  }

  /** Drop the last user message + everything after; caller re-sends. Persists to session file. */
  retryLastUser(): string | null {
    const entries = this.log.entries;
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;
    const raw = entries[lastUserIdx]!.content;
    const userText = typeof raw === "string" ? raw : "";
    const preserved = entries.slice(0, lastUserIdx).map((m) => ({ ...m }));
    this.log.compactInPlace(preserved);
    this.persistLog(preserved);
    return userText;
  }

  async *step(
    userInput: string,
    images?: ReadonlyArray<string | TurnImage>,
  ): AsyncGenerator<LoopEvent> {
    // Per-turn abort-state guarantee: whenever this generator completes —
    // normally, via an abort path, or because the consumer broke the
    // for-await (generator.return() delegates through `yield*`, so this
    // finally runs in every case) — a turn that ended with its own
    // controller still aborted must reset it. Leaks come from aborts
    // landing in the turn's tail: suspended at a final assistant_final /
    // done yield, swallowed by the force-summary helper's catch, or a
    // desktop Stop that breaks the for-await right after the model's
    // answer. Without the reset, the next step() carries the stale
    // abort forward (carryAbort) and instantly kills the user's next
    // message — the "have to send it a second time" bug.
    try {
      yield* this.stepTurn(userInput, images);
    } finally {
      this._turnImages = [];
      if (this._turnAbort.signal.aborted) this.resetAbortState();
      // A turn force-closed mid-dispatch (desktop Send now / queue force)
      // abandons in-flight tool calls: their results never reach the log.
      // Stub them so the pairing holds and the next prompt tells the truth.
      this.settleAbandonedToolCalls();
    }
  }

  private async *stepTurn(
    userInput: string,
    images?: ReadonlyArray<string | TurnImage>,
  ): AsyncGenerator<LoopEvent> {
    // Reset per-turn flags.
    this._steerConsumed = false;
    this._turnImages = toTurnImages(images);

    // Budget gate runs FIRST, before any per-turn state mutation, so a
    // refusal leaves the loop unchanged and the user can correct the
    // cap and re-issue. Default `null` short-circuits the whole check
    // so the no-budget path is one comparison, no behavior delta.
    if (this.budgetUsd !== null) {
      const spent = this.stats.totalCost;
      if (spent >= this.budgetUsd) {
        const message = t("loop.budgetExhausted", {
          spent: spent.toFixed(4),
          cap: this.budgetUsd.toFixed(2),
        });
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: message,
          errorDetail: {
            name: "BudgetExhausted",
            message,
            retryable: false,
            recoverable: false,
          },
        };
        this._steerQueue.length = 0;
        return;
      }
      if (!this._budgetWarned && spent >= this.budgetUsd * 0.8) {
        this._budgetWarned = true;
        yield {
          turn: this._turn,
          role: "warning",
          content: t("loop.budget80Pct", {
            spent: spent.toFixed(4),
            cap: this.budgetUsd.toFixed(2),
          }),
        };
      }
    }
    this._turn++;
    const baseModelForTurn = this.model;
    let restoreModelAfterTurn = false;
    const restoreModelIfNeeded = () => {
      if (restoreModelAfterTurn && this.model === "deepseek-v4-pro") {
        this.model = baseModelForTurn;
      }
    };

    this._userTurnCount++;
    this.scratch.reset();
    // A fresh user turn is a new intent — don't let StormBreaker's
    // old sliding window of (name, args) signatures keep blocking
    // calls that are now legitimately on-task. The window repopulates
    // naturally as this turn's tool calls flow through.
    this.repair.resetStorm();
    this._turnSelfCorrected = false;
    // Grace state is per-turn too: a paused turn's "continue" starts a fresh
    // turn with the base cap restored (and a fresh grace grant if it stays
    // productive). Keeping the latch would silently raise every later turn's
    // cap for the whole session and skip the grace warning on continue.
    this._iterGrace = 0;
    this._iterGraceApplied = false;
    this._iterCapBypassed = false;
    this._foldedThisTurn = false;
    this._emptyResponseRetried = false;
    this._providerErrorRetried = false;
    this._ollamaContinuations = 0;
    this._lastReasoningSig = null;
    this._reasoningLoopCount = 0;
    // Fresh controller for this turn: the prior step's signal has
    // already fired (or stayed clean); either way we don't want its
    // state to bleed into the new turn.
    //
    // Edge case — `loop.abort()` may have been called BEFORE step()
    // ran (race: caller fires abort during async setup, but step()
    // hadn't been awaited yet). Naively reassigning _turnAbort would
    // silently drop that abort. Forward the prior aborted state into
    // the fresh controller so the iter-0 check still bails out. This
    // is load-bearing for subagents: the parent's onParentAbort
    // listener calls childLoop.abort(), which can fire before
    // childLoop.step() has reached the `for await` line below.
    //
    // Carry ONLY when the abort predates the loop's first step. Once a
    // step has started, an aborted controller here is stale: step()'s
    // wrapper finally resets any abort that fired during a turn, so the
    // only way to see one is an abort() that landed after the previous
    // generator completed (Esc during the TUI's Stop-hook teardown,
    // desktop Stop at the tail). That abort belonged to the dead turn —
    // carrying it would cancel the user's fresh message and force a
    // re-send.
    const carryAbort = this._turnAbort.signal.aborted && !this._stepStarted;
    this._stepStarted = true;
    this._turnAbort = new AbortController();
    if (carryAbort) this._turnAbort.abort();
    const signal = this._turnAbort.signal;
    // If the PREVIOUS turn was force-closed (queue force / Send now) while a
    // tool call was in flight, its result never reached the log. Stub it now,
    // before buildMessages(), so this turn's first request tells the model
    // the call was cancelled instead of healing silently dropping the
    // dangling tool_calls and leaving the model to guess the tool failed.
    this.settleAbandonedToolCalls();
    // Persist the user message before the first API round-trip so a
    // mid-stream abort or a session switch doesn't drop the prompt and
    // leave a new session orphaned without a .jsonl on disk (issue #943
    // — sidebar globs .jsonl files, so an unpersisted new session vanishes
    // when the user navigates away before the model responds). A failed
    // first round-trip still leaves the message in the log; the user can
    // /retry without re-typing.
    const turnStartLogIndex = this.log.length;
    this.appendAndPersist({ role: "user", content: buildUserContent(userInput, this._turnImages) });
    const toolSpecs = this.prefix.tools();
    const rateLimitState = { shown: false };

    // Turn-start fold: covers cases the post-response check can't see — terminal
    // prior turn (no tool_calls → no decideAfterUsage), session restore from
    // disk, huge user paste. TURN_START_FOLD_THRESHOLD shares the post-response
    // HISTORY_FOLD_THRESHOLD (75%), so every request ships below the fold line
    // regardless of turn shape. The fold is non-interruptible (see
    // summarizeForFold): an Esc pressed during it is deferred — the iter-0
    // abort check below honors it after the compaction completes.
    {
      const turnStart = this.context.estimateTurnStart(
        this.buildMessages(),
        this.prefix.toolSpecs,
        this.model,
      );
      if (turnStart.ratio > TURN_START_FOLD_THRESHOLD) {
        // Compaction card lifecycle — same queue as tool cards, emitted through
        // the ONE compactionEvents helper every compaction form shares.
        const result = yield* this.compactionEvents(
          `compaction-${++this._compactionSeq}`,
          "auto-context-pressure",
          "fold",
          undefined,
          () => this.foldRun({ requireTailBoundary: true }),
        );
        if (result.folded) this._foldedThisTurn = true;
      }
    }

    for (let iter = 0; ; iter++) {
      if (signal.aborted) {
        // Reset in finally — the consumer (desktop runTurn) breaks the
        // for-await on its own aborter between our yields, which calls
        // generator.return() and skips post-yield straight-line code.
        // Without finally the reset is lost and carryAbort locks every
        // future step() at iter 0.
        try {
          const discardTurn = this._discardAbortRequested;
          const stoppedMsg = discardTurn
            ? "[aborted by user (Esc) — interrupted turn discarded. Ask again when ready.]"
            : "[aborted by user (Esc) — no summary produced. Ask again or /retry when ready; prior tool output is still in the log.]";
          if (discardTurn) {
            const beforeDiscard = this.log.length;
            this.discardLogFrom(turnStartLogIndex);
            // The truncated log REPLACES the conversation — record it so the
            // kernel view stays replayable (same swap as session.compacted).
            yield {
              turn: this._turn,
              role: "session_retracted",
              content: "",
              sessionRetractedKind: "abort-discard",
              beforeMessages: beforeDiscard,
              afterMessages: this.log.length,
              replacementMessages: this.log.entries,
            };
          } else {
            this.appendAndPersist(buildSyntheticAssistantMessage(stoppedMsg, this.model));
          }
          yield {
            turn: this._turn,
            role: "assistant_final",
            content: stoppedMsg,
            forcedSummary: true,
          };
          restoreModelIfNeeded();
          yield { turn: this._turn, role: "done", content: stoppedMsg };
        } finally {
          this.resetAbortState();
        }
        this._steerQueue.length = 0;
        return;
      }
      // Hard iteration cap — prevents runaway tool-call loops from
      // consuming unlimited API budget. What happens at the cap depends
      // on the turn's health (#2037):
      //  - STUCK turn (storm-breaker latched `_turnSelfCorrected`): one final
      //    force-summary call, then stop — collapses the garbage loop so the
      //    next turn starts from a recap instead of re-sending it.
      //  - PRODUCTIVE turn (distinct calls, results flowing): the cap grants a
      //    grace window (~50% more, min 5) instead of a hard stop — killing a
      //    healthy long task mid-flow just forces the user to re-prompt from a
      //    compressed recap. If the grace window also exhausts, the turn pauses
      //    NON-destructively: the log stays intact, so the next "continue"
      //    resumes with full state.
      //  - YOLO mode (`getEditMode() === "yolo"`): the cap never pauses a
      //    productive turn — nobody is watching to say "continue". Noted once,
      //    then the turn runs without the cap. The STUCK path above still
      //    applies: a garbage loop must collapse even with auto-shell.
      const hardCap = this.maxIterPerTurn + (this._iterGraceApplied ? this._iterGrace : 0);
      if (iter >= hardCap && !this._iterCapBypassed) {
        if (this._turnSelfCorrected) {
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.iterLimitReached", { max: this.maxIterPerTurn }),
          };
          yield* forceSummaryAfterIterLimit(this.summaryContext(), { reason: "stuck" });
          restoreModelIfNeeded();
          this._steerQueue.length = 0;
          return;
        }
        if (this._getEditMode?.() === "yolo") {
          this._iterCapBypassed = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.iterLimitYolo", { max: this.maxIterPerTurn }),
          };
          continue;
        }
        if (!this._iterGraceApplied) {
          this._iterGrace = Math.max(5, Math.round(this.maxIterPerTurn / 2));
          this._iterGraceApplied = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.iterLimitGrace", {
              max: this.maxIterPerTurn,
              grace: this.maxIterPerTurn + this._iterGrace,
            }),
          };
          continue;
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.iterLimitPaused", {
            grace: this.maxIterPerTurn + this._iterGrace,
          }),
        };
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }
      // Bridge the silence between the PREVIOUS iter's tool result and
      // THIS iter's first streaming byte. R1 can spend 20-90s reasoning
      // about tool output before the first delta lands, and prior to
      // this hint the UI had nothing to render. Only emit on iter > 0
      // because iter 0's "thinking" phase is already covered by the
      // streaming row / StreamingAssistant's placeholder.
      //
      // Wording is explicit about the two things happening: the tool
      // result IS being uploaded (it's now part of the next prompt) and
      // the model IS thinking. Users were reading "thinking about the
      // tool result" as the model-only phase, but the wait also covers
      // the upload round-trip.
      if (iter > 0) {
        yield {
          turn: this._turn,
          role: "status",
          content: t("loop.toolUploadStatus"),
        };
      }
      let messages = this.buildMessages();

      if (this._steerQueue.length > 0) {
        const steer = this._steerQueue.shift()!;
        this._steerConsumed = this._steerQueue.length === 0;
        this.appendAndPersist({
          role: "user",
          content: formatSteerUserMessage(steer),
        });
        messages = this.buildMessages();
        yield {
          turn: this._turn,
          role: "steer",
          content: steer,
        };
      }

      const requestBudget = this.context.requestBudget(messages, toolSpecs, this.model);
      if (!requestBudget.fits) {
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.forcingSummary", {
            before: requestBudget.estimateTokens.toLocaleString(),
            ctxMax: requestBudget.ctxMax.toLocaleString(),
            pct: Math.round(requestBudget.ratio * 100),
          }),
        };
        yield* this.forcedSummaryEvents(`compaction-${++this._compactionSeq}`, "context-guard");
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }

      let assistantContent = "";
      let reasoningContent = "";
      let toolCalls: ToolCall[] = [];
      let usage: TurnStats["usage"] | null = null;
      let finishReason: string | undefined;
      let image: { dataUrl: string; mimeType: string } | undefined;
      let repetitionStall:
        | { channel: "content" | "reasoning"; period: number; repeatedChars: number }
        | undefined;
      const callModel = this.model;

      // Snapshot prefix evidence from the same turn-start tool list sent to the
      // API so MCP hot-adds during the turn don't rewrite history.
      const prefixEvidence = this.prefix.diagnosticHashes(toolSpecs);

      try {
        if (this.stream) {
          const result = yield* streamModelResponse({
            client: this.client,
            model: callModel,
            messages,
            toolSpecs,
            signal,
            reasoningEffort: this.reasoningEffort,
            maxTokens: this.maxOutputTokens,
            turn: this._turn,
          });
          assistantContent = result.assistantContent;
          reasoningContent = result.reasoningContent;
          toolCalls = result.toolCalls;
          usage = result.usage;
          finishReason = result.finishReason;
          image = result.image;
          repetitionStall = result.repetitionStall;
        } else {
          const resp = await this.client.chat({
            model: callModel,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            signal,
            thinking: thinkingModeForModel(callModel),
            reasoningEffort: this.reasoningEffort,
            maxTokens: this.maxOutputTokens,
          });
          assistantContent = resp.content;
          reasoningContent = resp.reasoningContent ?? "";
          toolCalls = resp.toolCalls;
          usage = resp.usage;
          image = resp.image;
        }
      } catch (err) {
        // An aborted signal here is almost always our own doing —
        // either Esc, or App.tsx calling `loop.abort()` to switch to a
        // queued synthetic input (ShellConfirm "always allow", PlanConfirm
        // approve, etc.). The DeepSeek client's fetch path translates
        // the abort into a generic `AbortError("This operation was
        // aborted")`, which used to bubble up here and render as a
        // scary red "error" row even though nothing actually broke.
        // Treat it as a clean early-exit instead: the next turn (queued
        // synthetic OR user re-prompt) starts immediately and gets to
        // produce its own answer.
        if (signal.aborted) {
          // Reset in finally — same rationale as the iter-start handler:
          // if the consumer breaks the for-await before draining `done`,
          // generator.return() would skip a bare post-yield reset and
          // leave carryAbort locked on the next step().
          if (this._discardAbortRequested) {
            const beforeDiscard = this.log.length;
            this.discardLogFrom(turnStartLogIndex);
            yield {
              turn: this._turn,
              role: "session_retracted",
              content: "",
              sessionRetractedKind: "abort-discard",
              beforeMessages: beforeDiscard,
              afterMessages: this.log.length,
              replacementMessages: this.log.entries,
            };
          }
          try {
            restoreModelIfNeeded();
            yield { turn: this._turn, role: "done", content: "" };
          } finally {
            this.resetAbortState();
          }
          this._steerQueue.length = 0;
          return;
        }
        const upstreamHost = this.client.baseUrl;
        const dsHost = isDeepSeekHost(upstreamHost);
        const probe =
          is5xxError(err) && dsHost ? await probeDeepSeekReachable(this.client) : undefined;
        const cause = err instanceof Error ? err : new Error(String(err));
        const { code, phase, partialDelivered, timedOut } = errorMeta(cause);
        const providerErrorRetryable =
          !this._providerErrorRetried &&
          !partialDelivered &&
          !signal.aborted &&
          cause.name !== "AbortError" &&
          // A genuine HTTP 4xx is a malformed request (e.g. Gemini's
          // deterministic INVALID_ARGUMENT 400), not a transient failure —
          // replaying the identical payload is pointless and hides the real
          // error. The OpenAI `response.failed` synthetic 400 (phase
          // "stream_body_read") is retryable by design and stays eligible.
          (!is4xxError(cause) || phase === "stream_body_read");
        if (providerErrorRetryable) {
          this._providerErrorRetried = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.providerErrorRetry"),
          };
          continue;
        }
        const streamBodyError = this.stream && phase === "stream_body_read";
        const retryable =
          !is4xxError(cause) &&
          cause.name !== "AbortError" &&
          !timedOut &&
          (code !== "UND_ERR_ABORTED" || streamBodyError) &&
          !(streamBodyError && (partialDelivered || this._providerErrorRetried));
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: formatLoopError(err as Error, probe, { upstreamHost }),
          errorDetail: {
            name: cause.name,
            message: cause.message,
            phase,
            code,
            retryable,
            recoverable: false,
          },
        };
        this._steerQueue.length = 0;
        restoreModelIfNeeded();
        return;
      }

      if (repetitionStall) {
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.repetitionStall", {
            channel: repetitionStall.channel,
            period: repetitionStall.period,
            repeatedChars: repetitionStall.repeatedChars,
          }),
        };
        if (
          assistantContent.length === 0 &&
          reasoningContent.length === 0 &&
          toolCalls.length === 0
        ) {
          assistantContent = t("loop.repetitionStallNoPrefix");
        }
      }

      // Ollama reports `done_reason: "length"` when generation is cut off at
      // num_predict (the output-token cap). The partial answer is already
      // rendered; append it to the log and re-request so the model continues
      // from where it stopped, instead of ending the turn on a truncated
      // answer. Bounded per turn so a model stuck regenerating can't loop.
      // Only continue when there is real content to resume from AND no tool
      // call was cut mid-stream — a truncated tool_call has no result to feed
      // back, and appending it as a phantom would confuse the next request.
      const ollamaTruncated =
        this.stream && finishReason === "length" && providerForModel(callModel) === "ollama";
      const partialHasContent = assistantContent.length > 0 || reasoningContent.length > 0;
      if (ollamaTruncated && partialHasContent && toolCalls.length === 0) {
        if (this._ollamaContinuations >= CacheFirstLoop.MAX_OLLAMA_CONTINUATIONS) {
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.ollamaTruncatedGiveUp", {
              max: CacheFirstLoop.MAX_OLLAMA_CONTINUATIONS,
            }),
          };
          // fall through and end the turn with the partial content
        } else {
          this._ollamaContinuations++;
          this.appendAndPersist(
            buildAssistantMessage(assistantContent, toolCalls, callModel, reasoningContent),
          );
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.ollamaTruncatedRetry"),
          };
          continue;
        }
      }

      if (parseNeedsProEscalation(assistantContent) && callModel !== "deepseek-v4-pro") {
        restoreModelAfterTurn = true;
        this.model = "deepseek-v4-pro";
        continue;
      }

      // Attribute under the actual model used (escalated → pro, else
      // callModel) so cost/usage logs reflect reality.
      const cacheShape = this.cacheShapeForRequest(prefixEvidence, toolSpecs);
      const cacheDiagnostics = this.cacheDiagnosticsForUsage(cacheShape, usage);
      this._lastCacheShape = cacheShape;
      const turnStats = this.stats.record(
        this._turn,
        callModel,
        usage ?? new Usage(),
        cacheDiagnostics,
        this._billingKindFor(callModel),
      );

      // Carry cumulative stats across app restarts.
      let cacheDiagnostic = buildCacheDiagnostic({
        turn: this._turn,
        model: callModel,
        usage: turnStats.usage,
        estimatedCostUsd: turnStats.cost,
        prefix: prefixEvidence,
        previous: latestCacheDiagnostic(this.stats.cacheDiagnostics),
      });
      if (this.sessionName) {
        try {
          // Rebuild against the persisted chain so a resumed session's first
          // turn infers misses from the pre-restart evidence, not just this boot.
          const meta = loadSessionMeta(this.sessionName);
          cacheDiagnostic = buildCacheDiagnostic({
            turn: this._turn,
            model: callModel,
            usage: turnStats.usage,
            estimatedCostUsd: turnStats.cost,
            prefix: prefixEvidence,
            previous: latestCacheDiagnostic(meta.cacheDiagnostics),
          });
          const last =
            this.stats.turns.length > 0 ? this.stats.turns[this.stats.turns.length - 1] : null;
          patchSessionMeta(this.sessionName, {
            totalCostUsd: this.stats.totalCost,
            // Deep-merge per-provider costs: the loop owns USD-kind providers
            // (from its stats), while the desktop accumulates plan-window quota
            // deltas directly into meta — one must never overwrite the other.
            costByProvider: { ...meta.costByProvider, ...this.stats.providerCosts },
            cacheHitTokens: this.stats.cumulativeCacheHitTokens,
            cacheMissTokens: this.stats.cumulativeCacheMissTokens,
            totalCompletionTokens: this.stats.cumulativeCompletionTokens,
            lastPromptTokens: last?.usage.promptTokens,
            cacheDiagnostics: appendCacheDiagnostic(meta.cacheDiagnostics, cacheDiagnostic),
          });
        } catch (err) {
          // Best-effort; don't crash the turn loop on a write failure — but
          // never silent: a lost cost/usage update is real data loss.
          process.stderr.write(`reasonix: session meta patch failed — ${messageOf(err)}\n`);
        }
      }

      // Store the per-turn cache diagnostic so the live cache-miss report
      // replays the prefix hashes that were actually in effect at turn time.
      this.stats.addCacheDiagnostic(cacheDiagnostic);

      this.scratch.reasoning = reasoningContent || null;

      // Reasoning-loop guard: if the model is stuck re-emitting the same
      // thought iteration after iteration without producing an actual answer,
      // collapse the turn to a forced summary. This catches the "thinks in
      // circles" case that the storm breaker misses — e.g. re-reading a file
      // while the tool ARGS drift, so no identical-args repeat ever trips the
      // storm. Producing real assistant text resets the counter.
      const reasoningSig = normalizeReasoning(reasoningContent);
      const producedText = assistantContent.length > 0;
      // Count consecutive iterations of the same reasoning (the first occurrence
      // is count 1). Fire when the identical thought repeats REASONING_LOOP_LIMIT
      // times. Producing real assistant text or a different thought resets.
      if (reasoningSig !== "" && reasoningSig === this._lastReasoningSig && !producedText) {
        this._reasoningLoopCount++;
      } else {
        this._reasoningLoopCount = reasoningSig === "" ? 0 : 1;
      }
      this._lastReasoningSig = reasoningSig || null;
      if (this._reasoningLoopCount >= CacheFirstLoop.REASONING_LOOP_LIMIT) {
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.reasoningLoop"),
        };
        yield* this.forcedSummaryEvents(`compaction-${++this._compactionSeq}`, "stuck");
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }

      // Empty-completion guard: content, reasoning AND tool calls all empty is
      // never a legitimate model answer — the API glitched (empty stream,
      // truncated queue slot, provider hiccup). Ending the turn silently here
      // is the "chat went dead" bug: the message sits in the log, the turn is
      // done, and nothing was ever rendered. Retry ONCE (the empty response is
      // NOT appended to the log — there is nothing to show the model), then
      // give up loudly instead of a second silent exit.
      if (
        assistantContent.length === 0 &&
        reasoningContent.length === 0 &&
        toolCalls.length === 0
      ) {
        if (!this._emptyResponseRetried) {
          this._emptyResponseRetried = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.emptyResponseRetry"),
          };
          continue;
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.emptyResponseGiveUp"),
        };
        this._steerQueue.length = 0;
        restoreModelIfNeeded();
        return;
      }

      const { calls: repairedCalls, report } = this.repair.process(
        toolCalls,
        reasoningContent || null,
        assistantContent || null,
      );

      this.appendAndPersist(
        buildAssistantMessage(assistantContent, repairedCalls, callModel, reasoningContent, image),
      );

      yield {
        turn: this._turn,
        role: "assistant_final",
        content: assistantContent,
        ...(repetitionStall ? { reasoningContent, replaceStreamedOutput: true } : {}),
        image,
        stats: turnStats,
        cacheDiagnostic,
        repair: report,
      };

      const allSuppressed =
        report.stormsBroken > 0 && repairedCalls.length === 0 && toolCalls.length > 0;

      // First all-suppressed storm: rewrite tail with the original tool_calls
      // (so the next prompt shows what was attempted), stub tool responses to
      // keep the API contract, and continue the iter — model gets one shot to
      // self-correct before the loud-warning path takes over.
      if (allSuppressed && !this._turnSelfCorrected) {
        this._turnSelfCorrected = true;
        this.replaceTailAssistantMessage(
          buildAssistantMessage(assistantContent, toolCalls, callModel, reasoningContent),
        );
        for (const call of toolCalls) {
          this.appendAndPersist({
            role: "tool",
            tool_call_id: call.id ?? "",
            name: call.function?.name ?? "",
            content:
              "[repeat-loop guard] this call was suppressed because it was identical to a previous call in this turn. Earlier results for it are above — try a meaningfully different approach, or stop and answer if you have enough.",
          });
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "low",
          content: t("loop.repeatToolCallWarning"),
        };
        continue;
      }

      if (report.stormsBroken > 0) {
        const noteTail = report.notes.length ? ` — ${report.notes[report.notes.length - 1]}` : "";
        const phrase = allSuppressed
          ? t("loop.stormStuck")
          : t("loop.stormSuppressed", { count: report.stormsBroken });
        yield {
          turn: this._turn,
          role: "warning",
          severity: allSuppressed ? "high" : "low",
          content: `${phrase}${noteTail}`,
        };
      }

      // Context-management decision after each turn's response.
      // ContextManager owns the policy; loop renders the events.
      // Must run BEFORE the repairedCalls.length === 0 early-return so
      // text-only responses also benefit from auto-fold / force-summary.
      const decision = this.context.decideAfterUsage(usage, callModel, this._foldedThisTurn);
      // Compaction runs in the same queue as the tool calls: the fold emits a
      // compaction card (compaction_start → compaction_end) like a tool card,
      // and pending tool calls dispatch BEFORE the fold so an in-flight read
      // isn't blocked behind the multi-minute summary window (the "read called,
      // then force compaction — neither finishes" stall). ContextManager clamps
      // the fold boundary to the last user exchange (protectActiveExchange) so
      // the completed tool results survive into the tail.
      const foldPlan = decision.kind === "fold" ? decision : null;
      const compactionId = foldPlan ? `compaction-${++this._compactionSeq}` : null;
      if (decision.kind === "exit-with-summary") {
        const before = decision.promptTokens;
        const ctxMax = decision.ctxMax;
        yield {
          turn: this._turn,
          role: "warning",
          content: t("loop.forcingSummary", {
            before: before.toLocaleString(),
            ctxMax: ctxMax.toLocaleString(),
            pct: Math.round((before / ctxMax) * 100),
          }),
        };
        // The context guard is a COMPACTION action, not just a warning: it trims
        // the trailing in-flight tool call and summarizes in place — same card
        // lifecycle as a fold, so the UI renders one compaction shape and the
        // event log records the trim + summary as one action.
        yield* this.forcedSummaryEvents(`compaction-${++this._compactionSeq}`, "context-guard");
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }

      if (repairedCalls.length === 0) {
        if (foldPlan && compactionId) {
          yield* this.foldWithEvents(
            compactionId,
            foldPlan.tailBudget ?? 0,
            foldPlan.aggressive ?? false,
          );
          // Esc/Stop during compaction: the fold is deliberately non-interruptible
          // (see summarizeForFold), so a stop request that landed mid-summary is
          // consumed here when the turn is finishing — there's nothing left to
          // stop. Without the reset, the aborted controller would carry into the
          // next step() (carryAbort) and instantly abort the user's next message.
          if (signal.aborted) this.resetAbortState();
        }
        if (this._steerQueue.length > 0) {
          continue;
        }
        if (allSuppressed) {
          // Same compaction card lifecycle as the context-guard path — the
          // stuck-state force-summary is also a compaction action.
          yield* this.forcedSummaryEvents(`compaction-${++this._compactionSeq}`, "stuck");
          restoreModelIfNeeded();
          this._steerQueue.length = 0;
          return;
        }
        restoreModelIfNeeded();
        yield { turn: this._turn, role: "done", content: assistantContent };
        this._steerQueue.length = 0;
        return;
      }

      yield* dispatchToolCallsChunked(repairedCalls, {
        turn: this._turn,
        signal,
        model: this.model,
        isParallelSafe: (name) => this.tools.isParallelSafe(name),
        inflightIdFor: (call) => this.inflightIdFor(call),
        inflightAdd: (id) => this._inflight.add(id),
        runOne: (call, sig) => this.runOneToolCall(call, sig),
        appendAndPersist: (m) => this.appendAndPersist(m),
        abandonedCalls: this._abandonedCalls,
        rateLimitState,
      });
      // The current iter's tool calls have settled — fold now, so the compaction
      // card follows the tool cards in the queue instead of blocking them behind
      // the multi-minute summary window.
      if (foldPlan && compactionId) {
        yield* this.foldWithEvents(
          compactionId,
          foldPlan.tailBudget ?? 0,
          foldPlan.aggressive ?? false,
        );
      }
    }
    // Unreachable — the for-loop above is unbounded. The model exits the
    // loop via return statements when it produces no more tool calls,
    // when the context guard fires, when an abort fires, or when a fatal
    // error escapes the inner try blocks.
  }

  // Compaction card lifecycle — emitted by every fold path so UIs render the
  // fold as a card in the same queue as tool calls (running spinner → folded
  // result / failure reason) instead of a status row that never clears.
  // protectActiveExchange is always on: this helper only runs post-response,
  // where the current iter's tool results must survive into the tail.
  private async *foldWithEvents(
    compactionId: string,
    tailBudget: number,
    aggressive: boolean,
  ): AsyncGenerator<LoopEvent, FoldResult, void> {
    const result = yield* this.compactionEvents(
      compactionId,
      "auto-context-pressure",
      "fold",
      aggressive,
      () => this.foldRun({ keepRecentTokens: tailBudget, protectActiveExchange: true }),
    );
    // A failed fold must not suppress another fold decision in this turn. The
    // result latch is set only after the compaction actually replaced history.
    if (result.folded) this._foldedThisTurn = true;
    return result;
  }

  /** THE one compaction card lifecycle — every compaction form (fold, user
   *  /compact, forced summary) yields the same compaction_start → compaction_end
   *  pair; a successful fold snapshots the post-fold log for session.compacted. */
  private async *compactionEvents(
    compactionId: string,
    reason: "user" | "auto-context-pressure",
    kind: "fold" | "force-summary",
    aggressive: boolean | undefined,
    run: () => Promise<FoldResult> | AsyncGenerator<LoopEvent, FoldResult, void>,
  ): AsyncGenerator<LoopEvent, FoldResult, void> {
    const beforeMessages = this.log.length;
    // Cancel live work FIRST and hold the dispatch lock for the whole summary:
    // no background shell, subagent, or tool may be running — or started — while
    // history is being summarized and replaced. The lock clears on early break.
    this._compacting = true;
    try {
      await this.cancelActiveTasks();
      yield {
        turn: this._turn,
        role: "compaction_start",
        content: "",
        compactionId,
        compactionReason: reason,
        compactionKind: kind,
        ...(aggressive ? { aggressive: true } : {}),
      };

      let result: FoldResult;
      try {
        const runner = run();
        // Plain promise (fold paths) or generator (the forced summary forwards
        // its own status/assistant_final/done events through the card).
        result = runner instanceof Promise ? await runner : yield* runner;
      } catch (err) {
        // Compaction is an auxiliary action: a tokenizer, persistence, or model
        // failure must settle its card and return control to the turn loop. The
        // failed run is never reported as folded, so the live log remains the
        // source of truth and a later turn can retry it.
        result = {
          folded: false,
          beforeMessages,
          afterMessages: this.log.length,
          summaryChars: 0,
          error: `compaction failed — ${messageOf(err)}`,
        };
      }

      yield {
        turn: this._turn,
        role: "compaction_end",
        content: "",
        compactionId,
        compactionReason: reason,
        compactionKind: kind,
        folded: result.folded,
        beforeMessages: result.beforeMessages,
        afterMessages: result.afterMessages,
        summaryChars: result.summaryChars,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.error ? { foldError: result.error } : {}),
        ...(result.warn ? { foldWarn: result.warn } : {}),
        ...(result.prunedFiles ? { prunedFiles: result.prunedFiles } : {}),
        ...(result.prunedTokens ? { prunedTokens: result.prunedTokens } : {}),
        ...(result.droppedFiles?.length ? { droppedFiles: result.droppedFiles } : {}),
        // Post-fold log snapshot — the fold swapped the array in place, so the
        // live entries ARE the replacement (merge-at-commit preserved any
        // mid-summary appends).
        ...(result.folded ? { replacementMessages: this.log.entries } : {}),
      };
      return result;
    } finally {
      this._compacting = false;
    }
  }

  /** Force-summary card lifecycle — trims the trailing in-flight tool call and
   *  FULL-folds the log (history replaced by the synthesized summary). */
  private async *forcedSummaryEvents(
    compactionId: string,
    reason: ForceSummaryReason,
  ): AsyncGenerator<LoopEvent, FoldResult, void> {
    return yield* this.compactionEvents(
      compactionId,
      "auto-context-pressure",
      "force-summary",
      undefined,
      () => this.forceSummaryRun(reason),
    );
  }

  /** Runs the fold itself — promise-returning; the forced-summary path passes
   *  a generator instead to forward its own events through the card. */
  private foldRun(opts: {
    keepRecentTokens?: number;
    protectActiveExchange?: boolean;
    requireTailBoundary?: boolean;
  }): Promise<FoldResult> {
    return this.context.fold(this.model, opts);
  }

  /** Runs the forced summary — trims the trailing in-flight assistant-with-
   *  tool_calls, forwards events through the card, returns the FoldResult. */
  private async *forceSummaryRun(
    reason: ForceSummaryReason,
  ): AsyncGenerator<LoopEvent, FoldResult, void> {
    const beforeMessages = this.log.length;
    let summary = "";
    let failure: string | undefined;
    try {
      this.context.trimTrailingToolCalls();
      summary = yield* forceSummaryAfterIterLimit(this.summaryContext(), { reason });
    } catch (err) {
      // The helper normally converts provider failures into error + done
      // events. Keep the outer compaction contract safe even if trimming,
      // stats, or another unexpected boundary throws before that helper can.
      failure = `forced summary failed — ${messageOf(err)}`;
      yield {
        turn: this._turn,
        role: "error",
        content: "",
        error: failure,
        errorDetail: {
          name: "ForceSummaryFailed",
          message: failure,
          retryable: false,
          recoverable: false,
        },
      };
      yield { turn: this._turn, role: "done", content: "" };
    }
    return {
      folded: summary.length > 0,
      beforeMessages,
      afterMessages: this.log.length,
      summaryChars: summary.length,
      ...(summary.length > 0 ? { summary } : {}),
      ...(summary.length === 0 ? { error: failure ?? "forced summary failed" } : {}),
    };
  }

  private summaryContext(): ForceSummaryContext {
    return {
      client: this.client,
      buildMessages: () => this.buildMessages(),
      replaceLog: (m) => {
        this.log.compactInPlace([m]);
        this.persistLog([m]);
      },
      recordStats: (model, usage) => this.stats.record(this._turn, model, usage),
      turn: this._turn,
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      getSystemPrompt: () => this.prefix.system,
      canSend: (messages) =>
        this.context.requestBudget(messages, this.prefix.toolSpecs, this.model).fits,
    };
  }

  async run(
    userInput: string,
    onEvent?: (ev: LoopEvent) => void,
    images?: ReadonlyArray<string | TurnImage>,
  ): Promise<string> {
    let final = "";
    for await (const ev of this.step(userInput, images)) {
      onEvent?.(ev);
      if (ev.role === "assistant_final") final = ev.content;
      if (ev.role === "done") break;
    }
    return final;
  }
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Collapse reasoning to a stable signature for repeat detection — trims,
 *  normalizes internal whitespace, and drops punctuation/trailing filler so
 *  re-worded but semantically identical thoughts still match. */
function normalizeReasoning(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .toLowerCase();
}
