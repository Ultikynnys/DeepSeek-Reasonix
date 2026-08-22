import type { RepairReport } from "../repair/index.js";
import type { CacheDiagnosticEntry } from "../telemetry/cache-diagnostics.js";
import type { TurnStats } from "../telemetry/stats.js";
import type { ChatMessage } from "../types.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /** Only liveness signal during a large-args tool call (no content/reasoning bytes). */
  | "tool_call_delta"
  /** Pre-dispatch ping so the TUI can show a spinner during long tool awaits. */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /** Transient indicator for silent phases; UI clears on next primary event. */
  | "status"
  /** Mid-turn steer injected as queued user guidance without aborting the current turn. */
  | "steer"
  /** Compaction card lifecycle — mirrors tool_start/tool so UIs can render a
   *  compaction card in the same queue as tool cards. Start carries the reason,
   *  end carries the FoldResult. Never emitted without a matching end. */
  | "compaction_start"
  | "compaction_end"
  /** Session edit (abort-discard) truncated the log mid-turn — carries the
   *  post-truncation log so the eventizer can emit session.retracted and the
   *  kernel conversation view stays replayable. */
  | "session_retracted";

/** "low" = chatty / self-correcting / counter — Desktop+Dashboard filter these out by default.
 *  Undefined / "high" = real event the user should see (compaction, abort, budget, rate-limit, etc.).
 *  TUI ignores this and renders every warning. */
export type EventSeverity = "low" | "high";

export interface LoopEvent {
  turn: number;
  role: EventRole;
  content: string;
  severity?: EventSeverity;
  reasoningDelta?: string;
  toolName?: string;
  /** Raw args JSON — needed by `reasonix diff` to explain why a tool was called. */
  toolArgs?: string;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number;
  /** Zero-based index of the tool call this delta belongs to (multi-tool progress). */
  toolCallIndex?: number;
  /** Count of tool calls whose args have parsed as valid JSON (UI progress, not dispatch gate). */
  toolCallReadyCount?: number;
  /** Stable id for tool_start / tool pairs — also the inflight-set key. UI uses this as the card id so it can derive `running` from `loop.inflight.has(callId)` instead of trusting end-event delivery. */
  callId?: string;
  stats?: TurnStats;
  /** Per-turn local cache evidence — prefix hashes + inferred miss reason. Surfaced
   *  on assistant_final; DeepSeek reports token counts, Reasonix infers reasons. */
  cacheDiagnostic?: CacheDiagnosticEntry;
  repair?: RepairReport;
  error?: string;
  errorDetail?: {
    name: string;
    message: string;
    code?: string;
    phase?: string;
    retryable: boolean;
    recoverable: boolean;
  };
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in forced-summary text. */
  forcedSummary?: boolean;
  /** Stable id pairing compaction_start with its compaction_end — the UI keys the card by it. */
  compactionId?: string;
  /** Why the fold runs — "user" = /compact, "auto-context-pressure" = loop-internal fold. */
  compactionReason?: "user" | "auto-context-pressure";
  /** What kind of compaction runs — "fold" (head folded into a summary message) vs
   *  "force-summary" (log trimmed + summarized in place under the context guard).
   *  Carried on both compaction_start and compaction_end. */
  compactionKind?: "fold" | "force-summary";
  /** compaction_end with folded=true: the post-fold message log — lets the eventizer
   *  emit session.compacted so the kernel conversation view stays replayable after
   *  the log replacement. */
  replacementMessages?: ReadonlyArray<ChatMessage>;
  /** True when the fold is in the 70-85% aggressive band — user-facing messaging. */
  aggressive?: boolean;
  /** compaction_end: whether the fold actually replaced the log. */
  folded?: boolean;
  /** compaction_end: message count before the fold. */
  beforeMessages?: number;
  /** compaction_end: message count after the fold. */
  afterMessages?: number;
  /** session_retracted: which session edit truncated the log. */
  sessionRetractedKind?: "retry" | "rewind" | "abort-discard";
  /** compaction_end: length of the synthesized summary, in characters. */
  summaryChars?: number;
  /** compaction_end: the synthesized summary text (marker already stripped by the fold). */
  summary?: string;
  /** compaction_end: why the fold didn't happen, when the summarizer failed. */
  foldError?: string;
  /** compaction_end: advisory warning on a successful fold — e.g. file triage failed, nothing dropped. */
  foldWarn?: string;
  /** compaction_end: unique file paths whose read results were pruned by the fold's prune step. */
  prunedFiles?: number;
  /** compaction_end: tokens saved by the prune step. */
  prunedTokens?: number;
  /** compaction_end: file paths the triage step classified as no longer
   *  relevant — the UI drops them from "Files in context". */
  droppedFiles?: string[];
}
