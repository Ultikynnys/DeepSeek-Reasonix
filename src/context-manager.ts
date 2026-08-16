import {
  COMPACTION_SUMMARY_MARKER,
  buildFilesDroppedMarker,
  messageOf,
} from "@reasonix/core-utils";
import type { DeepSeekClient } from "./client.js";
import { Usage } from "./client.js";
import { providerForModel } from "./config.js";
import { pruneUnusedFileReads } from "./file-prune.js";
import {
  buildFileTriageInstruction,
  collectContextFilePaths,
  parseFileTriage,
} from "./file-triage.js";
import { healLoadedMessages } from "./loop.js";
import { stripHallucinatedToolMarkup } from "./loop.js";
import { buildFoldSummaryInstruction, extractPinnedConstraints } from "./loop/compaction-prompt.js";
import {
  COMPACTION_MAX_ATTEMPTS,
  COMPACTION_RETRY_DELAY_MS,
  withCompactionRetry,
} from "./loop/compaction-retry.js";
import { buildAssistantMessage } from "./loop/messages.js";
import { DEFAULT_MAX_RESULT_CHARS } from "./mcp/registry.js";
import type { AppendOnlyLog } from "./memory/runtime.js";
import { rewriteSession } from "./memory/session.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  type SessionStats,
} from "./telemetry/stats.js";
import { IMAGE_DETAIL_LOW_TOKENS, countTokensBounded, estimateRequestTokens } from "./tokenizer.js";
import type { ChatMessage, ToolSpec, UserContentPart } from "./types.js";

/** Auto-fold when a turn's response shows promptTokens above this fraction of ctxMax. */
export const HISTORY_FOLD_THRESHOLD = 0.75;
/** Tail budget after a normal fold, as a fraction of ctxMax. */
export const HISTORY_FOLD_TAIL_FRACTION = 0.2;
/** Above this fraction the normal fold's tail budget didn't buy enough headroom — fold harder. */
export const HISTORY_FOLD_AGGRESSIVE_THRESHOLD = 0.78;
/** Tail budget after an aggressive fold — half the normal one, sacrifices recent context for headroom. */
export const HISTORY_FOLD_AGGRESSIVE_TAIL_FRACTION = 0.1;
/** Skip the fold if the head wouldn't shrink the log by at least this fraction. */
export const HISTORY_FOLD_MIN_SAVINGS_FRACTION = 0.3;
/** Above this fraction we exit the turn with a summary instead of folding (defense in depth). */
export const FORCE_SUMMARY_THRESHOLD = 0.8;
/** Turn-start local estimate above this fraction triggers a pre-iter fold — terminal prior
 *  turns, session restores, and huge pastes. Shares HISTORY_FOLD_THRESHOLD (75%) so every
 *  request ships below the fold line regardless of turn shape. */
export const TURN_START_FOLD_THRESHOLD = HISTORY_FOLD_THRESHOLD;
/** Summaries shorter than this are degenerate model output — the fold fails loud instead of committing garbage. */
export const HISTORY_FOLD_SUMMARY_MIN_CHARS = 16;
// Base hard deadline for fold summaries so a hung request cannot stall the turn loop. The real
// deadline scales with the size of the head being summarized: a fixed short cap deterministically
// kills legitimate folds at large contexts (prefill + queue time grows with the prompt) — exactly
// when compaction matters most.
export const HISTORY_FOLD_SUMMARY_TIMEOUT_MS = 15_000;
/** Extra budget per head token — prefill roughly scales with input size. Bumped from 0.5ms after
 *  real sessions at ~240k-token heads measured 1-2+ min per fold — 0.5ms budgeted only ~2 min
 *  where prefill + queue jitter is worst, so legitimate folds timed out mid-compaction. */
export const HISTORY_FOLD_SUMMARY_PER_TOKEN_MS = 1.0;
/** Ceiling for the scaled deadline — a hung request still can't stall the turn loop; it just
 *  gets a full prefill-sized window first (~4.3 min at a 240k-token head). */
export const HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS = 300_000;
// Automatic fold-summary retries after a transient provider failure. The client retries the
// initial HTTP request, while the shared compaction policy also covers response-body/network
// failures that happen after headers arrive. Timeouts/aborts remain terminal.
export const HISTORY_FOLD_SUMMARY_MAX_ATTEMPTS = COMPACTION_MAX_ATTEMPTS;
/** Pause between fold-summary attempts — gives a high-load provider time to recover. */
export const HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS = COMPACTION_RETRY_DELAY_MS;
// Compaction step 3 (file relevance triage) — one small flash call per fold,
// only when the log carries file-path-bearing tool calls. Fixed deadline: the
// prompt is the fresh summary + path list, NOT the folded head, so a hung
// request can't stall the fold for long. Fail-open: a triage timeout/error
// yields zero drops and the fold commits as if the step never ran.
export const FILE_TRIAGE_TIMEOUT_MS = 20_000;
export const FILE_TRIAGE_MODEL = "deepseek-v4-flash";
/** Prepended to fold summary content so the model knows it's a synthesized recap.
 *  Re-export of the shared constant so existing imports keep resolving. */
export const HISTORY_FOLD_MARKER = COMPACTION_SUMMARY_MARKER;
/** Header that precedes preserved skill bodies in a fold's synthesized assistant message. */
export const SKILL_PIN_MEMO_HEADER = "[Active skill memos — preserved verbatim across the fold:]";
/** Matches the wrapper emitted by `run_skill` so the fold can lift bodies out before summarizing. */
const SKILL_PIN_REGEX = /<skill-pin name="([^"]+)">\n[\s\S]*?\n<\/skill-pin>/g;

export interface ContextManagerDeps {
  client: DeepSeekClient;
  log: AppendOnlyLog;
  stats: SessionStats;
  sessionName: string | null;
  getCurrentTurn: () => number;
  getSystemPrompt: () => string;
  /** Reuses the live prefix → fold summary call shares the cached bytes the main agent already paid for. */
  getToolSpecs?: () => readonly ToolSpec[];
  getFewShots?: () => readonly ChatMessage[];
  /** Fired when the message log was rewritten by fold; lets the loop drop session-scoped caches whose validity rested on the elided history (e.g. read-before-edit tracker). */
  onLogRewrite?: () => void;
}

export type PostUsageDecisionKind = "none" | "fold" | "exit-with-summary";

export interface PostUsageDecision {
  kind: PostUsageDecisionKind;
  promptTokens: number;
  ctxMax: number;
  ratio: number;
  /** Token budget for the recent tail when kind === "fold"; smaller in the aggressive band. */
  tailBudget?: number;
  /** True when this fold is in the 70-85% band — used in user-facing messaging. */
  aggressive?: boolean;
}

export interface FoldResult {
  folded: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryChars: number;
  /** The synthesized summary text (marker already stripped) — lets UIs render the recap inline. */
  summary?: string;
  /** Why the fold didn't happen, when the summarizer failed (as opposed to a legit nothing-to-fold noop). */
  error?: string;
  /** Advisory warning on a successful fold — e.g. file triage failed, nothing dropped. */
  warn?: string;
  /** Unique file paths whose read results were stubbed by the prune step. */
  prunedFiles?: number;
  /** Tokens saved by the prune step (content tokens − stub tokens). */
  prunedTokens?: number;
  /** File paths the triage step classified as no longer relevant — the UI drops
   *  them from "Files in context". Absent when the triage kept everything. */
  droppedFiles?: string[];
}

// Per-message token cost includes tool_calls JSON and reasoning_content;
// otherwise heavy tool-call arguments slip through the tail-budget check and
// the boundary slides past the active tool turn. reasoning_content counts
// against API promptTokens and must be passed back round-trip — ignoring it
// causes the fold to underestimate usage by thousands of tokens in
// thinking-mode sessions. No chat-template wrapper here — that would
// double-count.
function countMessageTokens(m: ChatMessage): number {
  let n = 0;
  if (typeof m.content === "string") {
    n += countTokensBounded(m.content);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part.type === "text") {
        n += countTokensBounded(part.text);
      } else if (part.type === "image_url") {
        n += IMAGE_DETAIL_LOW_TOKENS;
      }
    }
  }
  if (m.role === "assistant") {
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      n += countTokensBounded(JSON.stringify(m.tool_calls));
    }
    if (m.reasoning_content && (m.reasoning_content as string).length > 0) {
      n += countTokensBounded(m.reasoning_content as string);
    }
  }
  return n;
}

/** The fold summarizer runs on a DeepSeek model (deepseek-v4-flash), which
 *  rejects OpenAI image content parts (400) — collapse them to a text
 *  placeholder so a session with image attachments can still fold. */
function contentPartsToTextForDeepSeek(parts: UserContentPart[]): string {
  const text = parts
    .map((p) => (p.type === "text" ? p.text : "[image attached]"))
    .filter((s) => s.length > 0)
    .join("\n");
  return text || "[image attached]";
}

// Dedupe by name, last invocation wins. Read-only — leaves head bytes unchanged so the
// summarizer call's prefix still matches what the main agent already cached.
function collectPinnedSkills(head: ChatMessage[]): { names: string[]; bodies: string[] } {
  const pinned = new Map<string, string>();
  for (const msg of head) {
    if (typeof msg.content !== "string") continue;
    SKILL_PIN_REGEX.lastIndex = 0;
    for (const match of msg.content.matchAll(SKILL_PIN_REGEX)) {
      const name = match[1] as string;
      const full = match[0];
      pinned.delete(name);
      pinned.set(name, full);
    }
  }
  return { names: [...pinned.keys()], bodies: [...pinned.values()] };
}

export class ContextManager {
  /** Running token total — null until first computed. Appends increment it;
   *  compactInPlace invalidates it (lazy recompute) — without this, Desktop's
   *  per-tool-event getLogTokens re-tokenized the whole log on every call. */
  private logTokenTotal: number | null = null;
  /** Per-message counts — messages are immutable once appended, so counts
   *  survive recomputes after compaction for kept messages. */
  private logTokenCache = new WeakMap<ChatMessage, number>();

  constructor(private deps: ContextManagerDeps) {
    deps.log.onAppend((msg) => {
      if (this.logTokenTotal !== null) this.logTokenTotal += this.countMessageTokensCached(msg);
    });
    deps.log.onReplace(() => {
      this.logTokenTotal = null;
    });
  }

  /** Real-time token count of the current log — Desktop's context meter.
   *  O(1) steady-state: appends increment a running total, compaction
   *  invalidates it and the next call recomputes lazily. */
  getLogTokens(): number {
    if (this.logTokenTotal === null) {
      let total = 0;
      for (const e of this.deps.log.entries) total += this.countMessageTokensCached(e);
      this.logTokenTotal = total;
    }
    return this.logTokenTotal;
  }

  private countMessageTokensCached(m: ChatMessage): number {
    const cached = this.logTokenCache.get(m);
    if (cached !== undefined) return cached;
    const n = countMessageTokens(m);
    this.logTokenCache.set(m, n);
    return n;
  }

  /** Decision after a turn's response — fold, exit with summary, or carry on. */
  decideAfterUsage(
    usage: Usage | null,
    model: string,
    alreadyFoldedThisTurn: boolean,
  ): PostUsageDecision {
    const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
    if (!usage) {
      // Missing provider usage is not evidence that the request was small. Use
      // the live log as a conservative lower bound so dropped usage chunks
      // cannot disable post-response compaction indefinitely.
      const promptTokens = this.getLogTokens();
      const ratio = promptTokens / ctxMax;
      const base = { promptTokens, ctxMax, ratio };
      if (ratio > FORCE_SUMMARY_THRESHOLD) return { kind: "exit-with-summary", ...base };
      if (alreadyFoldedThisTurn) return { kind: "none", ...base };
      if (ratio > HISTORY_FOLD_AGGRESSIVE_THRESHOLD) {
        return {
          kind: "fold",
          ...base,
          tailBudget: Math.floor(ctxMax * HISTORY_FOLD_AGGRESSIVE_TAIL_FRACTION),
          aggressive: true,
        };
      }
      if (ratio > HISTORY_FOLD_THRESHOLD) {
        return {
          kind: "fold",
          ...base,
          tailBudget: Math.floor(ctxMax * HISTORY_FOLD_TAIL_FRACTION),
          aggressive: false,
        };
      }
      return { kind: "none", ...base };
    }
    const ratio = usage.promptTokens / ctxMax;
    const base = { promptTokens: usage.promptTokens, ctxMax, ratio };
    if (ratio > FORCE_SUMMARY_THRESHOLD) {
      return { kind: "exit-with-summary", ...base };
    }
    if (alreadyFoldedThisTurn) return { kind: "none", ...base };
    if (ratio > HISTORY_FOLD_AGGRESSIVE_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * HISTORY_FOLD_AGGRESSIVE_TAIL_FRACTION),
        aggressive: true,
      };
    }
    if (ratio > HISTORY_FOLD_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * HISTORY_FOLD_TAIL_FRACTION),
        aggressive: false,
      };
    }
    return { kind: "none", ...base };
  }

  /** Turn-start estimate vs ctxMax — caller folds if the ratio crosses
   *  TURN_START_FOLD_THRESHOLD. Replaces the old preflight/mechanical pair. */
  estimateTurnStart(
    messages: ChatMessage[],
    toolSpecs: ReadonlyArray<unknown> | undefined | null,
    model: string,
  ): { estimateTokens: number; ctxMax: number; ratio: number } {
    const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
    const estimate = estimateRequestTokens(messages, toolSpecs ?? null, true);
    return { estimateTokens: estimate, ctxMax, ratio: estimate / ctxMax };
  }

  /** Hard request invariant: callers must not send a payload above the model budget. */
  requestBudget(
    messages: ChatMessage[],
    toolSpecs: ReadonlyArray<unknown> | undefined | null,
    model: string,
  ): { fits: boolean; estimateTokens: number; ctxMax: number; ratio: number } {
    const estimate = this.estimateTurnStart(messages, toolSpecs, model);
    return { ...estimate, fits: estimate.estimateTokens <= estimate.ctxMax };
  }

  async fold(
    model: string,
    opts?: {
      keepRecentTokens?: number;
      requireTailBoundary?: boolean;
      // Never let the fold summarize the most recent user→assistant exchange away —
      // clamps the boundary to the last user message even when tool results blew
      // the tail budget. Used by the post-response fold, which now runs AFTER
      // the current iter's tool dispatch (the exchange is complete but must
      // survive into the tail so the model still sees the tool results).
      protectActiveExchange?: boolean;
    },
  ): Promise<FoldResult> {
    const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
    const tailBudget = opts?.keepRecentTokens ?? Math.floor(ctxMax * HISTORY_FOLD_TAIL_FRACTION);
    // Keep the live array reference — append() pushes in place, compactInPlace()
    // swaps the array. Identity lets the commit step detect messages appended
    // after the snapshot (see merge-at-commit below).
    const snapshotEntries = this.deps.log.entries;
    const all = this.deps.log.toMessages();
    const noop: FoldResult = {
      folded: false,
      beforeMessages: all.length,
      afterMessages: all.length,
      summaryChars: 0,
    };
    if (all.length === 0) return noop;

    const tokenCounts = all.map(countMessageTokens);
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

    let cumTokens = 0;
    let boundary = all.length;
    // Absolute index of the most recent user message — independent of the budget
    // walk below (the walk can break before reaching it when tool results are huge).
    let lastUserIdx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    for (let i = all.length - 1; i >= 0; i--) {
      if (cumTokens + tokenCounts[i]! > tailBudget) break;
      cumTokens += tokenCounts[i]!;
      if (all[i]!.role === "user") boundary = i;
    }
    // protectActiveExchange: the post-response fold runs AFTER this iter's tool
    // dispatch, so the log's tail is [user, assistant(tool_calls), tool results…].
    // Oversized results can blow the tail budget before the walk reaches the
    // user message — without the clamp the active exchange would land in the
    // head, get summarized away, and the model would never see the tool results.
    // Clamp the boundary to the last user message and recompute the tail cost.
    if (opts?.protectActiveExchange && lastUserIdx > 0 && boundary > lastUserIdx) {
      boundary = lastUserIdx;
      cumTokens = 0;
      for (let i = boundary; i < all.length; i++) cumTokens += tokenCounts[i]!;
    }
    if (boundary <= 0) return noop;
    // Preflight-only: refuse when no user landed in tail — the active tool turn
    // would be wiped. Default fold path (post-response) tolerates empty tail so
    // cache-aligned summary tests still exercise the "summarize all" shape.
    if (opts?.requireTailBoundary && boundary >= all.length) return noop;

    // Guard: when the tail would be empty, the most recent assistant message
    // (with its pending tool_calls) is summarized away. fixToolCallPairing
    // would then drop the tool results that follow as stray/unpaired — the
    // model would never see them. Force at least the last user→assistant
    // exchange into the tail.
    if (boundary >= all.length && all.length >= 1) {
      const last = all[all.length - 1]!;
      if (
        last.role === "assistant" &&
        Array.isArray(last.tool_calls) &&
        last.tool_calls.length > 0
      ) {
        // Walk back to find the user message that precedes this assistant
        for (let i = all.length - 2; i >= 0; i--) {
          if (all[i]!.role === "user") {
            boundary = i;
            break;
          }
        }
        if (boundary >= all.length) boundary = all.length - 1;
        // Recompute cumTokens for the adjusted tail
        cumTokens = 0;
        for (let i = boundary; i < all.length; i++) cumTokens += tokenCounts[i]!;
      }
    }

    const headTokens = totalTokens - cumTokens;
    // Only skip a "not worth it" fold when the log is already under the fold
    // line. Above it, a small head still buys headroom — and a noop here is
    // exactly what let context climb past the 75% threshold to the 80%
    // forced-summary guard (the "Nothing to fold" dead-end).
    const overThreshold = totalTokens > ctxMax * HISTORY_FOLD_THRESHOLD;
    if (!overThreshold && headTokens < totalTokens * HISTORY_FOLD_MIN_SAVINGS_FRACTION) {
      return noop;
    }

    // Step 2 — prune unused files. read_file results whose path is never
    // referenced again are the bulk of long-session heads; stubbing them (a)
    // shrinks the summarizer request — the step that used to ship every dead
    // file body and time out on 240k-token heads — and (b) keeps the
    // surviving tail from carrying dead cache bytes into the next turn.
    // Runs on a copy; the log is only touched if the fold commits below.
    // Message count is preserved, so the merge-at-commit slice below stays
    // valid. Active-exchange reads (after the last user message) are exempt.
    const pruned = pruneUnusedFileReads(all);
    const prunedHead = pruned.messages.slice(0, boundary);
    const prunedTail = pruned.messages.slice(boundary);
    // Deadline scales with what the summarizer actually ships — the pruned
    // head — not the original, so dead file bodies no longer inflate the
    // fold window.
    const prunedHeadTokens = prunedHead.reduce((acc, m) => acc + countMessageTokens(m), 0);

    const { names: pinnedNames, bodies: pinnedBodies } = collectPinnedSkills(prunedHead);
    const summary = await this.summarizeForFold(prunedHead, pinnedNames, prunedHeadTokens, model);
    if (!summary.content) {
      // Summarizer failure — surface it so the loop can warn instead of the
      // "compacting history…" status silently no-opping. Turn aborts are
      // already swallowed inside summarizeForFold (the abort path owns the
      // messaging), so error is only set for real failures.
      if (summary.error) return { ...noop, error: summary.error };
      // Empty output without an error is still a summarizer failure — a real
      // fold of a >75% head can never legitimately produce zero content.
      // Treating it as "nothing to fold" silently re-folds every turn.
      return { ...noop, error: "summarizer returned empty content — fold skipped" };
    }
    if (summary.content.length < HISTORY_FOLD_SUMMARY_MIN_CHARS) {
      return {
        ...noop,
        error: `summarizer returned a degenerate summary (${summary.content.length} chars) — fold skipped`,
      };
    }

    // Step 3 — agent-driven file relevance triage. Steps 1-2 shrink the LOG;
    // this step shrinks the session's "Files in context" list: the model
    // classifies every path the session touched as keep/drop against the fresh
    // summary. Drops surface to the UI (FoldResult.droppedFiles) and are
    // persisted as a marker in the summary message so a session reload
    // re-derives the same reduced list. Runs BEFORE the merge-at-commit
    // identity check, so the fold-concurrency guard covers messages appended
    // during this call too. Fail-open: any triage failure (parse, timeout,
    // model error) leaves the fold intact with zero drops. Skipped entirely
    // when the log has no file tool calls — nothing to classify.
    const allPaths = collectContextFilePaths(all);
    const triage =
      allPaths.length > 0
        ? await this.triageFilesForFold(summary.content, allPaths, model)
        : { keep: allPaths, drop: [] as string[], warn: undefined };
    const droppedFiles = triage.drop;
    const triageWarn = triage.warn;

    const memoTail =
      pinnedBodies.length > 0 ? `\n\n${SKILL_PIN_MEMO_HEADER}\n\n${pinnedBodies.join("\n\n")}` : "";
    const constraints = extractPinnedConstraints(this.deps.getSystemPrompt());
    const constraintTail = constraints
      ? `\n\n[PINNED CONSTRAINTS — preserved verbatim]\n\n${constraints}`
      : "";
    // Route via buildAssistantMessage so the synthetic summary carries
    // reasoning_content under thinking-mode sessions — without it the
    // next API call 400s with "must be passed back" (#1042). Stamp uses
    // the SESSION model so an empty placeholder is added even when the
    // summarizer call somehow returned no reasoning.
    const droppedMarker =
      droppedFiles.length > 0 ? `\n\n${buildFilesDroppedMarker(droppedFiles)}` : "";
    const summaryMsg = buildAssistantMessage(
      HISTORY_FOLD_MARKER + summary.content + droppedMarker + memoTail + constraintTail,
      [],
      model,
      summary.reasoningContent,
    );
    // Merge-at-commit: the summarizer call can run for seconds while a
    // user-triggered /compact races an in-flight tool dispatch (the desktop
    // compact_history IPC has no busy gate on the loop). A wholesale
    // replacement would clobber any message appended to the live log after
    // the snapshot — e.g. a tool result that landed mid-fold — orphaning it
    // so the model never sees the read. The array identity check is the
    // append-only detector: appends push in place, compactInPlace swaps.
    const liveEntries = this.deps.log.entries;
    if (liveEntries !== snapshotEntries) {
      // The log was REPLACED mid-summary (a concurrent compaction, /clear, or
      // recovery path swapped the array). The snapshot boundary no longer
      // describes the live log — applying the fold would resurrect the
      // pre-replacement head and clobber whoever won the race. Refuse to
      // apply rather than corrupt; the caller surfaces the error.
      return {
        ...noop,
        error: "log was rewritten while compaction was running — skipped",
      };
    }
    const liveAppends = liveEntries.slice(all.length);
    const replacement = [summaryMsg, ...prunedTail, ...liveAppends];
    this.deps.log.compactInPlace(replacement);
    // Sync commit ordering: in-memory swap first, then the full-file atomic
    // rewrite. Both are synchronous, so this method cannot resolve until the
    // ENTIRE compacted log is on disk — the UI's "compacting history…" status
    // stays up until the write completes.
    const persistError = this.persistRewrite(replacement);
    this.deps.onLogRewrite?.();
    return {
      folded: true,
      beforeMessages: all.length,
      afterMessages: replacement.length,
      summaryChars: summary.content.length,
      summary: summary.content,
      ...(triageWarn ? { warn: triageWarn } : {}),
      ...(persistError ? { error: persistError } : {}),
      ...(pruned.prunedFiles.length > 0
        ? { prunedFiles: pruned.prunedFiles.length, prunedTokens: pruned.tokensSaved }
        : {}),
      ...(droppedFiles.length > 0 ? { droppedFiles } : {}),
    };
  }

  /** Drop a trailing in-flight assistant-with-tool_calls before a forced summary. Tail-only mutation; prefix cache safe. */
  trimTrailingToolCalls(): boolean {
    const tail = this.deps.log.entries[this.deps.log.entries.length - 1];
    if (
      !tail ||
      tail.role !== "assistant" ||
      !Array.isArray(tail.tool_calls) ||
      tail.tool_calls.length === 0
    ) {
      return false;
    }
    const kept = this.deps.log.entries.slice(0, -1);
    this.deps.log.compactInPlace([...kept]);
    const persistError = this.persistRewrite([...kept]);
    if (persistError) process.stderr.write(`reasonix: ${persistError}\n`);
    return true;
  }

  private async summarizeForFold(
    messagesToSummarize: ChatMessage[],
    pinnedSkillNames: string[],
    headTokens: number,
    activeModel: string,
  ): Promise<{ content: string; reasoningContent: string; error?: string }> {
    // Pick a cheap model valid for the current transport: the Codex backend
    // rejects DeepSeek model names; the DeepSeek endpoint rejects GPT names.
    // gpt-4o-mini is NOT available through the Codex backend (ChatGPT accounts);
    // gpt-5.6-luna is the cheapest GPT-5.6 tier that the backend accepts
    // (Luna < Terra < Sol in cost).
    const summaryModel =
      providerForModel(activeModel) === "openai" ? "gpt-5.6-luna" : "deepseek-v4-flash";
    const healed = healLoadedMessages(messagesToSummarize, DEFAULT_MAX_RESULT_CHARS).messages;
    const agentSystem = this.deps.getSystemPrompt();
    const fewShots = this.deps.getFewShots?.() ?? [];
    const tools = this.deps.getToolSpecs?.() ?? [];
    const instruction = buildFoldSummaryInstruction(pinnedSkillNames);
    // DeepSeek models reject OpenAI image content parts (400) — collapse them
    // to a text placeholder so a session with image attachments can still fold.
    // GPT models accept images natively, but the placeholder is harmless either way.
    const foldSafe = healed.map((m) =>
      Array.isArray(m.content) ? { ...m, content: contentPartsToTextForDeepSeek(m.content) } : m,
    );
    const messages: ChatMessage[] = [
      { role: "system", content: agentSystem },
      ...fewShots.map((m) => ({ ...m })),
      ...foldSafe,
      { role: "user", content: instruction },
    ];
    // Deliberately NOT wired to the turn's abort signal: compaction is
    // non-interruptible by design. Esc/Stop during a fold used to abort the
    // summarizer here and silently no-op the compaction — "compacting
    // history…" was the last word, the log stayed unfolded, and the context
    // kept climbing to the 80% forced-summary guard. The fold now runs to
    // completion bounded only by the scaled deadline below; the loop honors
    // a deferred Esc at its next iteration boundary instead.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Deadline scales with the head being summarized: prefill + queue time
    // grows with the prompt, so a fixed short timeout would deterministically
    // kill folds at large context sizes (e.g. 15s vs a 240k-token prefill) —
    // exactly when compaction matters most. Still ceilinged so a hung
    // request can't stall the turn loop indefinitely (~4.3 min at a
    // 240k-token head — comfortably past the 1-2 min a real fold takes).
    const deadlineMs = Math.min(
      HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS,
      HISTORY_FOLD_SUMMARY_TIMEOUT_MS + Math.round(headTokens * HISTORY_FOLD_SUMMARY_PER_TOKEN_MS),
    );
    try {
      return await withCompactionRetry({
        maxAttempts: HISTORY_FOLD_SUMMARY_MAX_ATTEMPTS,
        retryDelayMs: HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS,
        maxElapsedMs: deadlineMs + HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS,
        timeoutMessage: "fold-timeout",
        attempt: async (attemptSignal) => {
          const deadlineCtrl = new AbortController();
          const requestSignal = AbortSignal.any([attemptSignal, deadlineCtrl.signal]);
          let timedOut = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              deadlineCtrl.abort(new Error("fold-timeout"));
              reject(new Error("fold-timeout"));
            }, deadlineMs);
          });
          try {
            const resp = await Promise.race([
              this.deps.client.chat({
                model: summaryModel,
                messages,
                tools: tools.length ? (tools as ToolSpec[]) : undefined,
                signal: requestSignal,
                thinking: "disabled",
              }),
              timeoutPromise,
            ]);
            this.deps.stats.record(
              this.deps.getCurrentTurn(),
              summaryModel,
              resp.usage ?? new Usage(),
            );
            return {
              content: stripHallucinatedToolMarkup((resp.content ?? "").trim()),
              reasoningContent: resp.reasoningContent ?? "",
            };
          } catch (err) {
            // Whichever promise wins the race, preserve the local timeout's
            // non-retryable identity instead of misclassifying its abort as a
            // transient provider drop.
            if (timedOut) throw new Error("fold-timeout");
            throw err;
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      });
    } catch (err) {
      const message = messageOf(err);
      return {
        content: "",
        reasoningContent: "",
        error: message === "fold-timeout" ? "summary request timed out" : message,
      };
    }
  }

  /** Compaction step 3 — the file relevance triage call: minimal system prompt
   *  + fresh fold summary + path list (no head re-prefill), own AbortController
   *  with FILE_TRIAGE_TIMEOUT_MS cap, fail-open — any failure keeps every file. */
  private async triageFilesForFold(
    summary: string,
    allPaths: string[],
    activeModel: string,
  ): Promise<{ keep: string[]; drop: string[]; warn?: string }> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a file-relevance classifier. You reply only with the JSON object the user's instruction asks for.",
      },
      { role: "user", content: buildFileTriageInstruction(summary, allPaths) },
    ];
    const triageCtrl = new AbortController();
    let triageTimer: ReturnType<typeof setTimeout> | undefined;
    // Deadline race, not just abort: the client's own socket cap is 11 min and
    // this call runs INSIDE the fold — a hung connection would freeze the
    // "compacting history…" card (and the loop's tool dispatch) for minutes.
    // The race rejects at FILE_TRIAGE_TIMEOUT_MS; the catch below fail-opens
    // with zero drops, same as any other triage failure.
    const deadlinePromise = new Promise<never>((_, reject) => {
      triageTimer = setTimeout(() => {
        triageCtrl.abort();
        reject(new Error("file-triage-timeout"));
      }, FILE_TRIAGE_TIMEOUT_MS);
    });
    // gpt-4o-mini is NOT available through the Codex backend (ChatGPT accounts);
    // gpt-5.6-luna is the cheapest GPT-5.6 tier that the backend accepts
    // (Luna < Terra < Sol in cost).
    const triageModel =
      providerForModel(activeModel) === "openai" ? "gpt-5.6-luna" : FILE_TRIAGE_MODEL;
    try {
      const resp = await Promise.race([
        this.deps.client.chat({
          model: triageModel,
          messages,
          signal: triageCtrl.signal,
          thinking: "disabled",
        }),
        deadlinePromise,
      ]);
      this.deps.stats.record(this.deps.getCurrentTurn(), triageModel, resp.usage ?? new Usage());
      return parseFileTriage(resp.content, allPaths);
    } catch (err) {
      // Fail-open: relevance is advisory — the fold proceeds with no drops.
      // The failure is surfaced as a fold warning so the UI card explains
      // why "Files in context" was not trimmed.
      const message = messageOf(err);
      return {
        keep: allPaths,
        drop: [],
        warn: `file triage failed — no files dropped (${message})`,
      };
    } finally {
      if (triageTimer) clearTimeout(triageTimer);
    }
  }

  /** Rewrite the on-disk session; null on success or a loud, UI-bound error
   *  string — a compaction that dies on disk must not look durable. */
  private persistRewrite(messages: ChatMessage[]): string | null {
    if (!this.deps.sessionName) return null;
    try {
      rewriteSession(this.deps.sessionName, messages);
      return null;
    } catch (err) {
      const message = messageOf(err);
      return `compaction committed but failed to save the session — ${message}. The conversation will revert on reload.`;
    }
  }
}
