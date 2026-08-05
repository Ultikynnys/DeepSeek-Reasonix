import { COMPACTION_SUMMARY_MARKER } from "@reasonix/core-utils";
import type { DeepSeekClient } from "./client.js";
import { Usage } from "./client.js";
import { pruneUnusedFileReads } from "./file-prune.js";
import { healLoadedMessages } from "./loop.js";
import { stripHallucinatedToolMarkup } from "./loop.js";
import { buildAssistantMessage } from "./loop/messages.js";
import { DEFAULT_MAX_RESULT_CHARS } from "./mcp/registry.js";
import type { AppendOnlyLog } from "./memory/runtime.js";
import { rewriteSession } from "./memory/session.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  type SessionStats,
} from "./telemetry/stats.js";
import { countTokensBounded, estimateRequestTokens } from "./tokenizer.js";
import type { ChatMessage, ToolSpec } from "./types.js";

function extractPinnedConstraints(systemPrompt: string): string {
  // matchAll because the system prompt can carry multiple blocks under the same
  // prefix — e.g. global User memory + per-project User memory, or several
  // Project memory files. Single .match() would only grab the first.
  const pattern =
    /# (?:HIGH PRIORITY constraints|User memory|Project memory)[\s\S]*?(?=\n# |\n---|$)/g;
  return Array.from(systemPrompt.matchAll(pattern), (m) => m[0]).join("\n\n");
}

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
// Automatic fold-summary retries after a fast retryable failure (5xx / 429 / network): the
// client already retried 4× with short backoff, so this is one slower pause + one more attempt
// — a partial outage gets time to clear before the fold gives up. Timeouts/aborts never retry.
export const HISTORY_FOLD_SUMMARY_MAX_ATTEMPTS = 2;
/** Pause between fold-summary attempts — matches the "wait 30s and retry" user hint. */
export const HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS = 30_000;
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
  /** Unique file paths whose read results were stubbed by the prune step. */
  prunedFiles?: number;
  /** Tokens saved by the prune step (content tokens − stub tokens). */
  prunedTokens?: number;
}

// Per-message token cost includes tool_calls JSON and reasoning_content;
// otherwise heavy tool-call arguments slip through the tail-budget check and
// the boundary slides past the active tool turn. reasoning_content counts
// against API promptTokens and must be passed back round-trip — ignoring it
// causes the fold to underestimate usage by thousands of tokens in
// thinking-mode sessions. No chat-template wrapper here — that would
// double-count.
function countMessageTokens(m: ChatMessage): number {
  let n = countTokensBounded(typeof m.content === "string" ? m.content : "");
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

function buildFoldSummaryInstruction(pinnedSkillNames: string[]): string {
  const base =
    "Summarize the conversation above as one self-contained prose recap. Preserve the user's " +
    "ORIGINAL OBJECTIVE (never paraphrase away negative constraints like 'do NOT do X'), all " +
    "'do not' / 'never' / 'avoid' instructions, decisions reached, files inspected or modified, " +
    "tool results still relevant, and any open todos. Skip turn-by-turn play-by-play. " +
    "Output plain prose only — no tool calls, no markdown headings, no SEARCH/REPLACE blocks.";
  if (pinnedSkillNames.length === 0) return base;
  const list = pinnedSkillNames.map((n) => `"${n}"`).join(", ");
  return `${base} The following skill memos are pinned verbatim and appended after your summary — do NOT quote or paraphrase their bodies: ${list}.`;
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

/** Fast retryable fold-summary failures get one automatic retry. The client already retried
 *  4× with short backoff, so what survived that is either permanent (4xx) or a slow hang
 *  (fold-timeout) — only 5xx / 429 / network errors are worth the longer pause. */
function isRetryableFoldSummaryError(message: string): boolean {
  if (message === "fold-timeout" || message === "fold-aborted" || message === "aborted") {
    return false;
  }
  if (/^DeepSeek (5\d{2}|429):/.test(message)) return true;
  if (/^DeepSeek \d{3}:/.test(message)) return false;
  return true; // network-level failures (fetch failed, ECONNRESET, …)
}

/** Plain pause between fold attempts. Deliberately NOT abortable: compaction is
 *  non-interruptible by design (Esc/Stop is honored at the next loop boundary
 *  instead), so the retry window must survive user input too. */
function foldRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ContextManager {
  constructor(private deps: ContextManagerDeps) {}

  /** Real-time token count of the current log — used by Desktop to refresh the
   *  context meter after /compact when no API usage event is available. */
  getLogTokens(): number {
    const entries = this.deps.log.toMessages();
    let total = 0;
    for (const e of entries) {
      total += countMessageTokens(e);
    }
    return total;
  }

  /** Decision after a turn's response — fold, exit with summary, or carry on. */
  decideAfterUsage(
    usage: Usage | null,
    model: string,
    alreadyFoldedThisTurn: boolean,
  ): PostUsageDecision {
    const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
    if (!usage) return { kind: "none", promptTokens: 0, ctxMax, ratio: 0 };
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
    if (headTokens < totalTokens * HISTORY_FOLD_MIN_SAVINGS_FRACTION) return noop;

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
    const summary = await this.summarizeForFold(prunedHead, pinnedNames, prunedHeadTokens);
    if (!summary.content) {
      // Summarizer failure — surface it so the loop can warn instead of the
      // "compacting history…" status silently no-opping. Turn aborts are
      // already swallowed inside summarizeForFold (the abort path owns the
      // messaging), so error is only set for real failures.
      if (summary.error) return { ...noop, error: summary.error };
      return noop;
    }

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
    const summaryMsg = buildAssistantMessage(
      HISTORY_FOLD_MARKER + summary.content + memoTail + constraintTail,
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
    this.persistRewrite(replacement);
    this.deps.onLogRewrite?.();
    return {
      folded: true,
      beforeMessages: all.length,
      afterMessages: replacement.length,
      summaryChars: summary.content.length,
      summary: summary.content,
      ...(pruned.prunedFiles.length > 0
        ? { prunedFiles: pruned.prunedFiles.length, prunedTokens: pruned.tokensSaved }
        : {}),
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
    this.persistRewrite([...kept]);
    return true;
  }

  private async summarizeForFold(
    messagesToSummarize: ChatMessage[],
    pinnedSkillNames: string[],
    headTokens: number,
  ): Promise<{ content: string; reasoningContent: string; error?: string }> {
    const summaryModel = "deepseek-v4-flash";
    const healed = healLoadedMessages(messagesToSummarize, DEFAULT_MAX_RESULT_CHARS).messages;
    const agentSystem = this.deps.getSystemPrompt();
    const fewShots = this.deps.getFewShots?.() ?? [];
    const tools = this.deps.getToolSpecs?.() ?? [];
    const instruction = buildFoldSummaryInstruction(pinnedSkillNames);
    const messages: ChatMessage[] = [
      { role: "system", content: agentSystem },
      ...fewShots.map((m) => ({ ...m })),
      ...healed,
      { role: "user", content: instruction },
    ];
    // Deliberately NOT wired to the turn's abort signal: compaction is
    // non-interruptible by design. Esc/Stop during a fold used to abort the
    // summarizer here and silently no-op the compaction — "compacting
    // history…" was the last word, the log stayed unfolded, and the context
    // kept climbing to the 80% forced-summary guard. The fold now runs to
    // completion bounded only by the scaled deadline below; the loop honors
    // a deferred Esc at its next iteration boundary instead.
    const foldCtrl = new AbortController();
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
    for (let attempt = 0; attempt < HISTORY_FOLD_SUMMARY_MAX_ATTEMPTS; attempt++) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          foldCtrl.abort();
          reject(new Error("fold-timeout"));
        }, deadlineMs);
      });
      try {
        const resp = await Promise.race([
          this.deps.client.chat({
            model: summaryModel,
            messages,
            tools: tools.length ? (tools as ToolSpec[]) : undefined,
            signal: foldCtrl.signal,
            thinking: "disabled",
          }),
          timeoutPromise,
        ]);
        this.deps.stats.record(this.deps.getCurrentTurn(), summaryModel, resp.usage ?? new Usage());
        return {
          content: stripHallucinatedToolMarkup((resp.content ?? "").trim()),
          reasoningContent: resp.reasoningContent ?? "",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Automatic retry for fast retryable failures (5xx / 429 / network):
        // the client already retried 4× with short backoff, so this pause is
        // the longer "wait 30s and retry" window — a partial outage gets
        // time to clear before the fold gives up. Timeouts are not retried —
        // they already consumed the full scaled deadline.
        const retryable =
          attempt < HISTORY_FOLD_SUMMARY_MAX_ATTEMPTS - 1 && isRetryableFoldSummaryError(message);
        if (!retryable) {
          return {
            content: "",
            reasoningContent: "",
            error: message === "fold-timeout" ? "summary request timed out" : message,
          };
        }
      } finally {
        // Disarm the attempt deadline before the retry pause — leaving it
        // armed would abort foldCtrl mid-pause and poison the next attempt.
        if (timeout) clearTimeout(timeout);
      }
      // Retryable failure — pause, then loop into the next attempt.
      await foldRetryDelay(HISTORY_FOLD_SUMMARY_RETRY_DELAY_MS);
    }
    // Unreachable — every attempt returns or continues past the last one.
    return { content: "", reasoningContent: "", error: "summary request failed" };
  }

  private persistRewrite(messages: ChatMessage[]): void {
    if (!this.deps.sessionName) return;
    try {
      rewriteSession(this.deps.sessionName, messages);
    } catch {
      /* disk full / perms — in-memory mutation still applies */
    }
  }
}
