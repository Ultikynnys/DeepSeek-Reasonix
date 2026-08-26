/** Isolated child loop. Inherits parent registry minus spawn_subagent + submit_plan; no hooks; non-streaming. */

import { type DeepSeekClient, Usage } from "../client.js";
import { CacheFirstLoop } from "../loop.js";
import { applyProjectMemory } from "../memory/project.js";
import { ImmutablePrefix } from "../memory/runtime.js";
import { timestampSuffix } from "../memory/session.js";
import {
  NEGATIVE_CLAIM_RULE,
  TUI_FORMATTING_RULES,
  escalationContract,
} from "../prompt-fragments.js";
import { ToolRegistry } from "../tools.js";
import { mergeSignals } from "./jobs.js";
import { SUBAGENT_TYPE_NAMES, getSubagentType } from "./subagent-types.js";

/** Side-channel — subagents run inside a tool-dispatch frame, can't go through parent's `LoopEvent` stream. */
export interface SubagentEvent {
  kind: "start" | "progress" | "end" | "inner" | "phase" | "stream-progress";
  /** Stable per-spawn id; lets the UI key parallel runs apart instead of overwriting one shared row. */
  runId: string;
  /** Parent loop tool-call identity that owns this spawn. */
  parentCallId?: string;
  parentTurn?: number;
  task: string;
  skillName?: string;
  model?: string;
  iter?: number;
  elapsedMs?: number;
  summary?: string;
  error?: string;
  turns?: number;
  costUsd?: number;
  /** How this run bills: "usd" = token-priced API cost (costUsd is meaningful),
   *  "quota" = provider plan window % consumed (see quotaUsedPct), "none" = not measurable. */
  billingKind?: "usd" | "quota" | "none";
  /** Percent points of the provider plan window consumed by this run, when
   *  billingKind === "quota" and a valid before/after delta was measurable. */
  quotaUsedPct?: number;
  usage?: Usage;
  /** When kind === "inner": the raw child loop event. Parent UI translates to a child summary. */
  inner?: import("../loop.js").LoopEvent;
  /** When kind === "phase": coarse status verb for the activity row. */
  phase?: "exploring" | "summarising";
  /** Latest prompt size reported by the child model call. Updates after every child turn. */
  contextTokens?: number;
  /** When kind === "stream-progress": monotonic char counters across the whole spawn, throttled. Lets the UI prove bytes are flowing during the long gaps between tool calls. `toolReadChars` is the sum of tool-result string lengths — the bytes pulled INTO the subagent from its reads/searches. */
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  maxToolIters?: number;
  maxElapsedMs?: number;
  budgetExhausted?: "tool-iters" | "elapsed";
}

let runIdCounter = 0;
function nextRunId(): string {
  runIdCounter++;
  return `sub-${runIdCounter.toString(36)}`;
}

export interface SubagentSink {
  current: ((ev: SubagentEvent) => void) | null;
}

/** Process-wide late-bound channel. `buildCodeToolset` runs before the TUI mounts, so its `subagentRunner` closure can't capture a UI ref directly — it reads `.current` at dispatch time. The TUI's `useSubagent` writes `.current` on mount. Both sides reference the same singleton object so prop-drilling through `chatCommand` is unnecessary. Tests / library callers that want isolation pass their own `subagentSink` to `buildCodeToolset` (overrides the singleton for that toolset). */
export const SHARED_SUBAGENT_SINK: SubagentSink = { current: null };

export interface SpawnSubagentOptions {
  client: DeepSeekClient;
  parentRegistry: ToolRegistry;
  system: string;
  task: string;
  model?: string;
  maxResultChars?: number;
  sink?: SubagentSink;
  /** Forwarded into the child loop so parent Esc cancels nested work. */
  parentSignal?: AbortSignal;
  skillName?: string;
  parentCallId?: string;
  parentTurn?: number;
  /** Scopes the child registry to these literal tool names; NEVER_INHERITED still wins. Driven by skill `allowed-tools` frontmatter. */
  allowedTools?: readonly string[];
  /** Enforced count of real child tool dispatches. */
  maxToolIters?: number;
  /** Enforced wall-clock deadline for the whole child run. */
  maxElapsedMs?: number;
  /** Continue an earlier session instead of starting fresh — loads the prior messages from disk; `task` is treated as a continuation nudge. */
  resumeSession?: string;
  /** How this run bills — drives the card's cost unit. "usd" = token-priced
   *  (costUsd is meaningful), "quota" = provider plan window %, "none" = unmeasurable. */
  billingKind?: "usd" | "quota" | "none";
  /** Returns the provider plan-window used % (0..100) for this run's model.
   *  Snapshotted before and after the run to compute the consumed quota delta.
   *  Only consulted when billingKind === "quota". */
  measureQuota?: () => Promise<number | null>;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  turns: number;
  toolIters: number;
  elapsedMs: number;
  costUsd: number;
  /** See SubagentEvent.billingKind. */
  billingKind?: "usd" | "quota" | "none";
  /** Percent points of the provider plan window consumed by this run, when measurable. */
  quotaUsedPct?: number;
  model: string;
  skillName?: string;
  /** Zero-filled when no API calls landed so consumers always see a valid shape. */
  usage: Usage;
  /** True when the child terminated via forceSummaryAfterIterLimit (storm-breaker / context-guard) — `output` carries the partial synthesis the model managed to produce; not a full answer. User-abort forced summaries do NOT set this (their content is a UX placeholder, routed to `error`). */
  forcedSummary?: boolean;
  budgetExhausted?: "tool-iters" | "elapsed";
  maxToolIters?: number;
  maxElapsedMs?: number;
}

export interface SubagentToolOptions {
  client: DeepSeekClient;
  defaultSystem?: string;
  projectRoot?: string;
  defaultModel?: string;
  maxResultChars?: number;
  sink?: SubagentSink;
  /** Fires once per spawn, after `spawnSubagent` returns and before its result is formatted for the parent. Bind a `SubagentTelemetry.record` here for automatic distillation capture. */
  onSpawnComplete?: (result: SubagentResult) => void;
  /** Folds the child loop's usage (cost, cache hit/miss, completion tokens) into the
   *  parent session's SessionStats via `recordExternal` — the parent stats panel then
   *  shows the full spend, not just parent-loop API calls. (#2008) */
  recordExternal?: (model: string, usage: Usage) => void;
}

/** Memory-stable prefix — shared across spawns, cached. The model-dependent escalation contract is appended per spawn so a pro spawn doesn't get told it's running on flash (#582). */
const SUBAGENT_BASE_SYSTEM = `You are a Reasonix subagent. The parent agent spawned you to handle one focused subtask, then return.

Rules:
- Stay on the task you were given. Do not expand scope.
- Use tools as needed. You share the parent's sandbox + safety rules.
- When you're done, your final assistant message is the only thing the parent will see — make it complete and self-contained. No follow-up offers, no questions, no "let me know if you need more."
- Prefer one clear, distilled answer over a long log of what you tried.

${NEGATIVE_CLAIM_RULE}

${TUI_FORMATTING_RULES}`;

const DEFAULT_MAX_RESULT_CHARS = 8000;
// Subagents default to flash — their work is read-and-synthesize
// (explore, research), which doesn't need the 12× pro tier. Skill
// frontmatter `model: deepseek-v4-pro` is the opt-in override for
// skills that empirically benefit from the stronger model.
export const DEFAULT_SUBAGENT_MODEL = "deepseek-v4-flash";
const DEFAULT_SUBAGENT_EFFORT: import("../config.js").ReasoningEffort = "high";

const SUBAGENT_TOOL_NAME = "spawn_subagent";
/** All delegation entry points are excluded → depth=1 hard cap; submit_plan excluded → no picker mid-parent-turn. */
export const NEVER_INHERITED_TOOLS = new Set<string>([
  SUBAGENT_TOOL_NAME,
  "submit_plan",
  "run_skill",
  "explore",
  "research",
  "review",
  "security_review",
]);

/** Per-session spawn count past which the soft hint fires on every subsequent return. */
const SOFT_HINT_AFTER_SPAWNS = 1;
/** Per-session count past which the strong hint fires (asks the model to justify the next spawn). */
const STRONG_HINT_AFTER_SPAWNS = 4;
/** Per-session cumulative subagent token total past which the strong hint also fires. */
const STRONG_HINT_TOKEN_THRESHOLD = 50_000;

/** null → first spawn of the session, no hint. Pure for testability. */
export function subagentBudgetHint(spawnCount: number, totalTokens: number): string | null {
  if (spawnCount > STRONG_HINT_AFTER_SPAWNS || totalTokens >= STRONG_HINT_TOKEN_THRESHOLD) {
    return `[budget: this session has now spawned ${spawnCount} subagents totalling ${totalTokens} tokens. Each spawn pays a fresh prefix-cache miss plus a full child loop — confirm the next spawn is genuinely needed (parallel fan-out or >10-read context blow-up) before calling spawn_subagent again. If you can answer with direct tools, do that instead.]`;
  }
  if (spawnCount > SOFT_HINT_AFTER_SPAWNS) {
    return `[note: this session has spawned ${spawnCount} subagents totalling ${totalTokens} tokens; confirm this one is worth it.]`;
  }
  return null;
}

/** Errors captured in the result shape, never thrown — caller decides how to surface. */
export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SubagentResult> {
  const model = opts.model ?? DEFAULT_SUBAGENT_MODEL;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const sink = opts.sink;
  const skillName = opts.skillName;
  const parentCallId = opts.parentCallId;
  const parentTurn = opts.parentTurn;
  const runId = nextRunId();
  const maxToolIters = opts.maxToolIters;
  const maxElapsedMs = opts.maxElapsedMs;
  const sessionName = opts.resumeSession ?? `subagent-${runId}-${timestampSuffix()}`;

  const startedAt = Date.now();
  const taskPreview = opts.task.length > 30 ? `${opts.task.slice(0, 30)}…` : opts.task;
  const emit = (event: Omit<SubagentEvent, "parentCallId" | "parentTurn">): void => {
    sink?.current?.({
      ...event,
      ...(parentCallId ? { parentCallId } : {}),
      ...(parentTurn !== undefined ? { parentTurn } : {}),
    });
  };
  emit({
    kind: "start",
    runId,
    task: taskPreview,
    skillName,
    model,
    iter: 0,
    elapsedMs: 0,
    maxToolIters,
    maxElapsedMs,
  });

  if (opts.allowedTools) {
    const missing = opts.allowedTools.filter((n) => !opts.parentRegistry.has(n));
    if (missing.length > 0) {
      const errorMessage = `subagent allow-list names tool(s) not registered in the parent: ${missing.join(", ")}. Fix the skill's \`allowed-tools\` frontmatter or check spelling.`;
      emit({
        kind: "end",
        runId,
        task: taskPreview,
        skillName,
        model,
        iter: 0,
        elapsedMs: Date.now() - startedAt,
        error: errorMessage,
        turns: 0,
        costUsd: 0,
        billingKind: opts.billingKind ?? "usd",
        usage: new Usage(),
      });
      return {
        success: false,
        output: "",
        error: errorMessage,
        turns: 0,
        toolIters: 0,
        elapsedMs: Date.now() - startedAt,
        costUsd: 0,
        billingKind: opts.billingKind ?? "usd",
        model,
        skillName,
        usage: new Usage(),
      };
    }
  }

  const childTools = opts.allowedTools
    ? forkRegistryWithAllowList(
        opts.parentRegistry,
        new Set(opts.allowedTools),
        NEVER_INHERITED_TOOLS,
      )
    : forkRegistryExcluding(opts.parentRegistry, NEVER_INHERITED_TOOLS);
  let budgetExhausted: "tool-iters" | "elapsed" | undefined;
  let dispatchedTools = 0;
  if (maxToolIters !== undefined) {
    childTools.addToolInterceptor("subagent-tool-budget", () => {
      if (dispatchedTools >= maxToolIters) {
        budgetExhausted = "tool-iters";
        return JSON.stringify({
          error: `subagent tool budget exhausted after ${maxToolIters} calls — stop using tools and return your verified findings now`,
          __reasonixSubagentBudgetRefusal: true,
          budgetExhausted,
        });
      }
      dispatchedTools++;
      return undefined;
    });
  }
  // Quota-billed runs snapshot the provider plan window before the child does
  // any work; the after-snapshot (post-loop) yields this run's consumed delta.
  let quotaBaseline: number | null = null;
  if (opts.billingKind === "quota" && opts.measureQuota) {
    quotaBaseline = await opts.measureQuota().catch(() => null);
  }
  const childPrefix = new ImmutablePrefix({
    system: opts.system,
    toolSpecs: childTools.specs(),
  });
  const childLoop = new CacheFirstLoop({
    client: opts.client,
    prefix: childPrefix,
    tools: childTools,
    model,
    // Subagents run on a constrained thinking budget by default — the
    // task is already narrow by construction, and `high` cuts output
    // tokens substantially vs `max`.
    reasoningEffort: DEFAULT_SUBAGENT_EFFORT,
    hooks: [],
    stream: true,
    session: sessionName,
  });

  // Wire parent-abort → child-abort. Two pitfalls we have to handle:
  //
  //   1. `addEventListener("abort", ...)` does NOT fire for a signal
  //      that's already aborted (the abort event has already been
  //      dispatched once and `once: true` is moot). If the parent
  //      aborted between dispatch entry and our listener attach,
  //      the listener stays silent forever and the child runs free.
  //      → Check `.aborted` synchronously and forward immediately.
  //
  //   2. childLoop.step() reassigns its internal _turnAbort at the
  //      top of step(). loop.ts forwards prior aborted state into
  //      the fresh controller, so abort() called BEFORE step() runs
  //      still kills the new step at iter 0.
  const onParentAbort = () => childLoop.abort();
  const deadlineTimer =
    maxElapsedMs === undefined
      ? undefined
      : setTimeout(() => {
          budgetExhausted = "elapsed";
          childLoop.abort();
        }, maxElapsedMs);
  deadlineTimer?.unref?.();
  if (opts.parentSignal?.aborted) {
    childLoop.abort();
  } else {
    opts.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  let final = "";
  let errorMessage: string | undefined;
  let toolIter = 0;
  let summarisingEmitted = false;
  let forcedSummaryFired = false;
  let outputChars = 0;
  let streamedContent = "";
  let reasoningChars = 0;
  let toolReadChars = 0;
  let contextTokens = 0;
  let lastStreamEmitAt = 0;
  let charsSinceLastEmit = 0;
  // Throttle gates — 200ms or 400 chars between emits, whichever first.
  // Cheap enough that React doesn't drown, often enough that the seconds
  // counter has company.
  const STREAM_EMIT_INTERVAL_MS = 200;
  const STREAM_EMIT_CHARS = 400;
  const maybeEmitStreamProgress = (now: number, force: boolean): void => {
    if (!sink?.current) return;
    if (
      !force &&
      now - lastStreamEmitAt < STREAM_EMIT_INTERVAL_MS &&
      charsSinceLastEmit < STREAM_EMIT_CHARS
    ) {
      return;
    }
    lastStreamEmitAt = now;
    charsSinceLastEmit = 0;
    emit({
      kind: "stream-progress",
      runId,
      task: taskPreview,
      skillName,
      model,
      iter: toolIter,
      elapsedMs: now - startedAt,
      contextTokens,
      outputChars,
      reasoningChars,
      toolReadChars,
    });
  };
  try {
    for await (const ev of childLoop.step(opts.task)) {
      emit({ kind: "inner", runId, task: taskPreview, skillName, model, inner: ev });

      if (ev.role === "tool") {
        let budgetRefusal = false;
        try {
          budgetRefusal = JSON.parse(ev.content ?? "{}").__reasonixSubagentBudgetRefusal === true;
        } catch {
          // Normal non-JSON tool results are real work and count toward the budget.
        }
        if (!budgetRefusal) toolIter++;
        // New tool dispatched — the model went back to deciding, summarising flag resets so the next final-answer delta re-emits.
        summarisingEmitted = false;
        if (!budgetRefusal) toolReadChars += ev.content?.length ?? 0;
        emit({
          kind: "progress",
          runId,
          task: taskPreview,
          skillName,
          model,
          iter: toolIter,
          elapsedMs: Date.now() - startedAt,
        });
        // Force-emit so the read counter ticks visibly even if the
        // subsequent assistant_delta gap is short and the throttle gates
        // would otherwise hold the next emit back.
        maybeEmitStreamProgress(Date.now(), true);
      }
      if (ev.role === "assistant_delta") {
        const dContent = ev.content?.length ?? 0;
        const dReason = ev.reasoningDelta?.length ?? 0;
        if (dContent > 0 || dReason > 0) {
          streamedContent += ev.content ?? "";
          outputChars += dContent;
          reasoningChars += dReason;
          charsSinceLastEmit += dContent + dReason;
          maybeEmitStreamProgress(Date.now(), false);
        }
      }
      // First content delta (no concurrent tool_call_delta role) = the
      // model is now writing its final answer, not deciding the next tool.
      if (ev.role === "assistant_delta" && !summarisingEmitted && (ev.content ?? "").length > 0) {
        summarisingEmitted = true;
        emit({
          kind: "phase",
          runId,
          task: taskPreview,
          skillName,
          model,
          phase: "summarising",
          iter: toolIter,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (ev.role === "assistant_final") {
        if (ev.stats) {
          contextTokens = ev.stats.usage.promptTokens;
          maybeEmitStreamProgress(Date.now(), true);
        }
        if (ev.forcedSummary) {
          // Two paths emit forcedSummary: user-abort (loop.ts ~670) carries a
          // UX placeholder ("aborted by user (Esc)…") that's useless to a
          // parent loop; storm-breaker / context-guard (force-summary.ts)
          // carries a real partial synthesis worth keeping. Discriminate on
          // parentSignal.aborted because the abort path only fires when the
          // signal is set.
          if (opts.parentSignal?.aborted) {
            errorMessage = ev.content?.trim() || "subagent aborted before producing an answer";
          } else {
            final = ev.content ?? "";
            forcedSummaryFired = true;
          }
        } else {
          final = ev.content ?? "";
        }
      }
      if (ev.role === "error") {
        errorMessage = ev.error ?? "subagent error";
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    opts.parentSignal?.removeEventListener("abort", onParentAbort);
  }
  // The loop yields `done` without an `error` event when its API call
  // is aborted mid-flight (intentional UX — see the matching catch in
  // CacheFirstLoop.step). From a SUBAGENT consumer's perspective that
  // still counts as a failure: no answer came back, the parent has
  // nothing to render. Synthesize an error so `success: false` and the
  // UI surfaces the abort instead of returning empty output.
  if (!final && budgetExhausted && streamedContent.trim()) {
    final = streamedContent.trim();
    // Deadline abort errors describe transport cancellation, not the usefulness
    // of content already streamed. Preserve that content as the partial result.
    errorMessage = undefined;
  }
  if (!errorMessage && !final) {
    errorMessage = budgetExhausted
      ? `subagent ${budgetExhausted === "elapsed" ? "time" : "tool-call"} budget exhausted before a final answer`
      : opts.parentSignal?.aborted
        ? "subagent aborted before producing an answer"
        : "subagent ended without producing an answer";
  }

  const elapsedMs = Date.now() - startedAt;
  const turns = childLoop.stats.turns.length;
  const costUsd = childLoop.stats.totalCost;
  const usage = aggregateChildUsage(childLoop);
  const billingKind = opts.billingKind ?? "usd";
  // After-snapshot the provider window for quota-billed runs. Only a non-negative
  // delta under 100pp (no window reset / no overlap double-count) is trustworthy.
  let quotaUsedPct: number | undefined;
  if (billingKind === "quota" && opts.measureQuota && quotaBaseline !== null) {
    const after = await opts.measureQuota().catch(() => null);
    const delta = after !== null ? after - quotaBaseline : null;
    if (delta !== null && Number.isFinite(delta) && delta >= 0 && delta < 100) {
      quotaUsedPct = delta;
    }
  }

  const truncated =
    final.length > maxResultChars
      ? `${final.slice(0, maxResultChars)}\n\n[…truncated ${final.length - maxResultChars} chars; ask the subagent for a tighter summary if you need more.]`
      : final;

  emit({
    kind: "end",
    runId,
    task: taskPreview,
    skillName,
    model,
    iter: toolIter,
    elapsedMs,
    summary: errorMessage ? undefined : truncated.slice(0, 120),
    error: errorMessage,
    turns,
    costUsd,
    billingKind,
    ...(quotaUsedPct !== undefined ? { quotaUsedPct } : {}),
    usage,
    contextTokens,
    maxToolIters,
    maxElapsedMs,
    budgetExhausted,
  });

  return {
    success: !errorMessage && !forcedSummaryFired && !budgetExhausted,
    output: errorMessage ? "" : truncated,
    error: errorMessage,
    turns,
    toolIters: toolIter,
    elapsedMs,
    costUsd,
    billingKind,
    ...(quotaUsedPct !== undefined ? { quotaUsedPct } : {}),
    model,
    skillName,
    usage,
    forcedSummary: forcedSummaryFired || undefined,
    budgetExhausted,
    maxToolIters,
    maxElapsedMs,
  };
}

/** Zero-filled when no API calls landed so downstream consumers always see a valid shape. */
function aggregateChildUsage(loop: CacheFirstLoop): Usage {
  const agg = new Usage();
  for (const t of loop.stats.turns) {
    agg.promptTokens += t.usage.promptTokens;
    agg.completionTokens += t.usage.completionTokens;
    agg.totalTokens += t.usage.totalTokens;
    agg.promptCacheHitTokens += t.usage.promptCacheHitTokens;
    agg.promptCacheMissTokens += t.usage.promptCacheMissTokens;
  }
  return agg;
}

export function formatSubagentResult(r: SubagentResult): string {
  // Model + billing metadata ride in the result envelope so the UI can render
  // model name / cost / quota even when the live `subagent.progress` event
  // stream (which normally carries them) was never attached — e.g. after a
  // session reload, where `subagentRuns` is not persisted.
  const meta = {
    ...(r.model ? { model: r.model } : {}),
    ...(r.billingKind ? { billing_kind: r.billingKind } : {}),
    ...(r.quotaUsedPct !== undefined ? { quota_used_pct: r.quotaUsedPct } : {}),
  };
  if (r.budgetExhausted) {
    return JSON.stringify({
      success: false,
      partial: true,
      output: r.output || undefined,
      error: r.error,
      budget_exhausted: r.budgetExhausted,
      max_tool_iters: r.maxToolIters,
      max_elapsed_ms: r.maxElapsedMs,
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      cost_usd: r.costUsd,
      ...meta,
      note: "Subagent stopped at its enforced work budget. Treat any output as partial findings; follow up directly only on a specific unresolved risk.",
    });
  }
  if (r.forcedSummary) {
    return JSON.stringify({
      success: false,
      partial: true,
      output: r.output,
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      cost_usd: r.costUsd,
      ...meta,
      note: "Subagent was force-summarized (storm-breaker or context-guard fired). `output` carries the partial synthesis the model produced before being stopped — useful but not a complete answer. Decide whether to accept the partial, narrow the task and re-spawn, or fall back to direct tools.",
    });
  }
  if (!r.success) {
    return JSON.stringify({
      success: false,
      error: r.error ?? "unknown subagent error",
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      ...meta,
    });
  }
  return JSON.stringify({
    success: true,
    output: r.output,
    turns: r.turns,
    tool_iters: r.toolIters,
    elapsed_ms: r.elapsedMs,
    cost_usd: r.costUsd,
    ...meta,
  });
}

/** Library surface only — `reasonix code` uses Skills `runAs: subagent` as the user-facing path. */
export function registerSubagentTool(
  parentRegistry: ToolRegistry,
  opts: SubagentToolOptions,
): ToolRegistry {
  const baseSystem = opts.defaultSystem ?? SUBAGENT_BASE_SYSTEM;
  // Bake project memory into the default once — re-reading on every
  // spawn would (a) make the child prefix unstable when REASONIX.md
  // changes mid-session, defeating cache reuse across multiple
  // subagent calls, and (b) cost a stat() per call. The parent itself
  // also reads memory once at startup; matching that semantics keeps
  // subagent and parent on the same page. The escalation contract is
  // appended per-spawn against the spawn's resolved model id (#582).
  const defaultSystemBase = opts.projectRoot
    ? applyProjectMemory(baseSystem, opts.projectRoot)
    : baseSystem;
  const defaultModel = opts.defaultModel ?? DEFAULT_SUBAGENT_MODEL;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const sink = opts.sink;
  // Per-session counters survive across spawn calls because registerSubagentTool
  // runs once per parent registry — closure scope is the session scope.
  let sessionSpawnCount = 0;
  let sessionSpawnTokens = 0;

  parentRegistry.register({
    name: SUBAGENT_TOOL_NAME,
    parallelSafe: true,
    description:
      "Spawn an isolated subagent to handle a self-contained subtask in a fresh context, returning only its final answer. **Prefer direct tools.** Spawn primarily for parallel fan-out (2+ independent investigations issued in one tool batch) or when the work would otherwise need >10 file reads/searches whose trail you don't need to keep. Single greps, 1-3 file cross-references, and 'keep my context clean for one question' are NOT good reasons to spawn — direct tools are cheaper and let you reference the evidence later. Each fresh spawn pays a prefix-cache miss plus a full child loop. The subagent inherits your tools but runs in its own isolated message log; only the final assistant message comes back. The subagent runs to completion — same stops as top-level chat (token-context guard, storm breaker, parent Esc cascade).",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            'The subtask the subagent should perform. Be specific and self-contained — the subagent has none of your conversation context, only what you write here. When resuming via `resume_session`, this becomes a continuation nudge (e.g. "finish what you started" or a delta instruction).',
        },
        system: {
          type: "string",
          description:
            "Optional override for the subagent's system prompt. The default tells it to stay focused and return a concise answer; override only when the subtask needs a specialized persona. Ignored on resume — the prior session keeps its original system prompt for cache stability.",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description:
            "Which DeepSeek model the subagent runs on. Default is 'deepseek-v4-flash' — cheap and fast, fine for explore/research-style subtasks. Override to 'deepseek-v4-pro' (~12× more expensive) when the subtask genuinely needs the stronger model: cross-file architecture, subtle bug hunts, anything where flash has empirically underperformed.",
        },
        resume_session: {
          type: "string",
          description:
            "Provide a previous subagent's session name to continue it. When set, prior messages are loaded from disk and the original system prompt is reused (cache-friendly). `task` becomes a continuation nudge.",
        },
        type: {
          type: "string",
          enum: [...SUBAGENT_TYPE_NAMES],
          description:
            "Optional persona shaping the system prompt. 'explore' = wide-net read-only investigation, returns a distilled answer. 'verify' = narrow yes/no check with evidence. Omit when supplying your own 'system' or when the default generic persona fits.",
        },
      },
      required: ["task"],
    },
    fn: async (
      args: {
        task?: unknown;
        system?: unknown;
        model?: unknown;
        type?: unknown;
        resume_session?: unknown;
      },
      ctx,
    ) => {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return JSON.stringify({
          error: "spawn_subagent requires a non-empty 'task' argument.",
        });
      }
      const typeSpec = getSubagentType(args.type);
      const model =
        typeof args.model === "string" &&
        (args.model.startsWith("deepseek-") || args.model.startsWith("gpt-"))
          ? args.model
          : defaultModel;
      const system =
        typeof args.system === "string" && args.system.trim().length > 0
          ? args.system.trim()
          : (typeSpec?.system ?? `${defaultSystemBase}\n\n${escalationContract(model)}`);
      const resumeSession =
        typeof args.resume_session === "string" && args.resume_session.trim().length > 0
          ? args.resume_session.trim()
          : undefined;
      const result = await spawnSubagent({
        client: opts.client,
        parentRegistry,
        system,
        task,
        model,
        maxResultChars,
        sink,
        parentSignal: mergeSignals(ctx?.signal, ctx?.cancelSignal),
        resumeSession,
      });
      sessionSpawnCount++;
      sessionSpawnTokens += result.usage.totalTokens;
      if (opts.recordExternal && result.usage) {
        try {
          opts.recordExternal(result.model, result.usage);
        } catch {
          // Stats folding must never break the spawn-tool dispatch.
        }
      }
      if (opts.onSpawnComplete) {
        try {
          opts.onSpawnComplete(result);
        } catch {
          // Telemetry callback errors must not break the spawn-tool dispatch.
        }
      }
      const formatted = formatSubagentResult(result);
      const hint = subagentBudgetHint(sessionSpawnCount, sessionSpawnTokens);
      return hint ? `${formatted}\n${hint}` : formatted;
    },
  });

  return parentRegistry;
}

/** Plan-mode state propagates — a subagent spawned under `/plan` MUST NOT escape it. */
// Registry forks inherit the policy but start with fresh counters, preserving session-local limits.
export function forkRegistryExcluding(
  parent: ToolRegistry,
  exclude: ReadonlySet<string>,
): ToolRegistry {
  const child = new ToolRegistry({ rateLimit: parent.rateLimitPolicy });
  for (const spec of parent.specs()) {
    const name = spec.function.name;
    if (exclude.has(name)) continue;
    const def = parent.get(name);
    if (!def) continue;
    // Re-register copies the public ToolDefinition fields. The child
    // re-runs auto-flatten analysis on its own, which produces an
    // identical flatSchema for the same input — no surprise.
    child.register(def);
  }
  if (parent.planMode) child.setPlanMode(true);
  return child;
}

/** alsoExclude wins over allow so NEVER_INHERITED still drops `spawn_subagent` even if a skill allow-list names it. */
export function forkRegistryWithAllowList(
  parent: ToolRegistry,
  allow: ReadonlySet<string>,
  alsoExclude: ReadonlySet<string>,
): ToolRegistry {
  const child = new ToolRegistry({ rateLimit: parent.rateLimitPolicy });
  for (const spec of parent.specs()) {
    const name = spec.function.name;
    if (!allow.has(name)) continue;
    if (alsoExclude.has(name)) continue;
    const def = parent.get(name);
    if (!def) continue;
    child.register(def);
  }
  if (parent.planMode) child.setPlanMode(true);
  return child;
}
