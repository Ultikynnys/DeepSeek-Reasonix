import type { LoopEvent } from "../loop.js";
import type { ChatMessage, RawUsage, ToolCall } from "../types.js";
import { redactEventValue } from "./event-redaction.js";
import { EventType } from "./events.js";
import type {
  CompactionFinishedEvent,
  CompactionStartedEvent,
  Event,
  ErrorEvent as KernelErrorEvent,
  ModelDeltaEvent,
  ModelFinalEvent,
  ModelTurnStartedEvent,
  SessionCompactedEvent,
  SessionOpenedEvent,
  SessionRetractedEvent,
  SlashInvokedEvent,
  StatusEvent,
  SubagentProgressEvent,
  ToolCallEvent,
  ToolConfirmAllowEvent,
  ToolConfirmAlwaysAllowEvent,
  ToolConfirmDenyEvent,
  ToolDispatchedEvent,
  ToolIntentEvent,
  ToolPreparingEvent,
  ToolResultEvent,
  UserMessageEvent,
} from "./events.js";

export interface EventizeContext {
  model: string;
  prefixHash: string;
  reasoningEffort: import("../config.js").ReasoningEffort;
}

export class Eventizer {
  private nextId = 0;
  private lastTurn = -1;
  private nextToolSeq = 0;
  /** Fallback ids for compaction events that arrive without a loop-generated compactionId. */
  private nextCompactionSeq = 0;
  /** Tool calls announced via tool_call_delta but not yet dispatched. FIFO upgraded by tool_start. */
  private preparingCallIds: string[] = [];
  /** Tool calls dispatched but not yet finished. FIFO popped by tool result. */
  private inflightCallIds: string[] = [];
  private inflightToolStartedAt: number[] = [];
  /** Per-turn dedupe so each toolCallIndex emits exactly one tool.preparing. */
  private announcedToolIdx = new Set<string>();

  consume(ev: LoopEvent, ctx: EventizeContext): Event[] {
    const out: Event[] = [];
    if (ev.turn !== this.lastTurn) {
      this.lastTurn = ev.turn;
      this.announcedToolIdx.clear();
      // Compaction events can arrive OUTSIDE a model turn — a user-triggered
      // /compact runs between turns or right after a session load, where a
      // synthesized model.turn.started would leave a phantom pending assistant
      // card that never settles. Only an auto fold that opens a brand-new turn
      // (the turn-start pre-iter fold) gets the turn-started card.
      const isUserCompaction =
        (ev.role === "compaction_start" || ev.role === "compaction_end") &&
        ev.compactionReason === "user";
      if (!isUserCompaction) out.push(this.turnStartedEvent(ev.turn, ctx));
    }
    switch (ev.role) {
      case "assistant_delta":
        if (ev.content) out.push(this.deltaEvent(ev.turn, "content", ev.content));
        if (ev.reasoningDelta) out.push(this.deltaEvent(ev.turn, "reasoning", ev.reasoningDelta));
        break;
      case "tool_call_delta": {
        const idx = ev.toolCallIndex;
        const name = ev.toolName;
        if (idx === undefined || !name) break;
        const key = `${ev.turn}:${idx}`;
        if (this.announcedToolIdx.has(key)) break;
        this.announcedToolIdx.add(key);
        const callId = `tc-${++this.nextToolSeq}`;
        this.preparingCallIds.push(callId);
        out.push(this.toolPreparingEvent(ev.turn, callId, name));
        break;
      }
      case "assistant_final":
        out.push(this.finalEvent(ev));
        break;
      case "tool_start": {
        const callId = this.preparingCallIds.shift() ?? `tc-${++this.nextToolSeq}`;
        this.inflightCallIds.push(callId);
        this.inflightToolStartedAt.push(performance.now());
        out.push(this.toolIntentEvent(ev.turn, callId, ev.toolName ?? "", ev.toolArgs ?? ""));
        out.push(this.toolDispatchedEvent(ev.turn, callId));
        break;
      }
      case "tool": {
        const callId = this.inflightCallIds.shift() ?? `tc-orphan-${++this.nextToolSeq}`;
        const startedAt = this.inflightToolStartedAt.shift();
        const durationMs = startedAt === undefined ? 0 : performance.now() - startedAt;
        const ok = !looksLikeToolError(ev.content, ev.toolName);
        out.push(this.toolResultEvent(ev.turn, callId, ok, ev.content, durationMs));
        break;
      }
      case "warning": {
        const classified = this.classifyWarning(ev);
        if (classified) out.push(classified);
        break;
      }
      case "error":
        out.push(
          this.errorEvent(ev.turn, ev.error ?? ev.content, ev.errorDetail?.recoverable ?? false, {
            name: ev.errorDetail?.name,
            code: ev.errorDetail?.code,
            phase: ev.errorDetail?.phase,
            retryable: ev.errorDetail?.retryable,
          }),
        );
        break;
      case "status":
        out.push(this.statusEvent(ev.turn, ev.content));
        break;
      case "compaction_start":
        out.push(
          this.compactionStartedEvent(
            ev.turn,
            ev.compactionId ?? `compaction-${++this.nextCompactionSeq}`,
            ev.compactionReason ?? "auto-context-pressure",
            ev.compactionKind,
            ev.aggressive,
          ),
        );
        break;
      case "compaction_end": {
        const compactionId = ev.compactionId ?? `compaction-${++this.nextCompactionSeq}`;
        out.push(
          this.compactionFinishedEvent(compactionId, {
            turn: ev.turn,
            kind: ev.compactionKind,
            folded: ev.folded ?? false,
            beforeMessages: ev.beforeMessages ?? 0,
            afterMessages: ev.afterMessages ?? 0,
            summaryChars: ev.summaryChars ?? 0,
            summary: ev.summary,
            error: ev.foldError,
            warn: ev.foldWarn,
            // The prune + triage payloads arrive on compaction_end; forward
            // them so the UI can render the card meta and drop files from the
            // "Files in context" panel (previously swallowed on this path).
            prunedFiles: ev.prunedFiles,
            prunedTokens: ev.prunedTokens,
            droppedFiles: ev.droppedFiles,
          }),
        );
        // The fold REPLACED the live log — record the replacement so the kernel
        // conversation projection stays replayable after compaction, exactly like
        // tool results and assistant finals are. The reducer swaps its message
        // list on this event (the one event that doesn't append).
        //
        // USER-triggered /compact ONLY. Auto folds (turn-start / post-response)
        // run MID-TURN: swapping the list renumbers every message (user turns
        // become array positions, assistant turns become dense counts) while the
        // loop keeps counting absolute turns, so the rest of the live turn's
        // events (deltas, tool cards, final) target a turn number that no longer
        // exists in the UI and are silently dropped — the turn renders as
        // "silently thinking" then ends with nothing. The running compaction
        // card already communicates the auto fold; the next session load
        // applies the replacement.
        if (ev.folded && ev.replacementMessages && ev.compactionReason === "user") {
          out.push(
            this.sessionCompactedEvent(
              ev.turn,
              ev.beforeMessages ?? 0,
              ev.afterMessages ?? 0,
              ev.compactionReason ?? "auto-context-pressure",
              ev.replacementMessages,
            ),
          );
        }
        break;
      }
      // session_retracted: an abort-discard truncated the live log mid-turn —
      // record the replacement so the kernel conversation projection stays
      // replayable (same swap semantics as session.compacted).
      case "session_retracted":
        out.push(
          this.sessionRetractedEvent(
            ev.turn,
            ev.sessionRetractedKind ?? "abort-discard",
            ev.beforeMessages ?? 0,
            ev.afterMessages ?? 0,
            ev.replacementMessages ?? [],
          ),
        );
        break;
      // `done` / `branch_*` intentionally drop — no kernel-level event.
      default:
        break;
    }
    return out;
  }

  emitUserMessage(turn: number, text: string): UserMessageEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.userMessage,
      text,
    };
  }

  emitSlashInvoked(turn: number, name: string, args: string): SlashInvokedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.slashInvoked,
      name,
      args,
    };
  }

  emitSessionOpened(turn: number, name: string, resumedFromTurn: number): SessionOpenedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.sessionOpened,
      name,
      resumedFromTurn,
    };
  }

  private sessionCompactedEvent(
    turn: number,
    before: number,
    after: number,
    reason: "user" | "auto-context-pressure",
    replacementMessages: ReadonlyArray<ChatMessage>,
  ): SessionCompactedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.sessionCompacted,
      beforeMessages: before,
      afterMessages: after,
      reason,
      replacementMessages,
    };
  }

  /** Session edits (retry / rewind from the desktop handler) truncate the live
   *  log outside the turn stream — emit the kernel replacement directly, like
   *  emitCompactionFinished: a side-channel for non-turn-stream actions. */
  emitSessionRetracted(
    turn: number,
    kind: "retry" | "rewind" | "abort-discard",
    before: number,
    after: number,
    replacementMessages: ReadonlyArray<ChatMessage>,
  ): SessionRetractedEvent {
    return this.sessionRetractedEvent(turn, kind, before, after, replacementMessages);
  }

  private sessionRetractedEvent(
    turn: number,
    kind: "retry" | "rewind" | "abort-discard",
    before: number,
    after: number,
    replacementMessages: ReadonlyArray<ChatMessage>,
  ): SessionRetractedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.sessionRetracted,
      kind,
      beforeMessages: before,
      afterMessages: after,
      replacementMessages,
    };
  }

  emitToolCall(turn: number, name: string, args: Record<string, unknown>): ToolCallEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolCall,
      name,
      args: redactEventValue(args),
    };
  }

  emitSubagentProgress(
    turn: number,
    progress: Omit<SubagentProgressEvent, "id" | "ts" | "turn" | "type">,
  ): SubagentProgressEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.subagentProgress,
      ...progress,
    };
  }

  /** Synthetic compaction card end when compaction_end never arrives (desktop
   *  closes the turn generator mid-await on abort). Mirrors emitAbortedFinal. */
  emitCompactionFinished(
    compactionId: string,
    result: {
      turn: number;
      kind?: "fold" | "force-summary";
      folded: boolean;
      beforeMessages: number;
      afterMessages: number;
      summaryChars: number;
      summary?: string;
      error?: string;
      prunedFiles?: number;
      prunedTokens?: number;
    },
  ): CompactionFinishedEvent {
    return this.compactionFinishedEvent(compactionId, result);
  }

  /** Synthetic final when a consumer closes the turn generator mid-await on
   * abort — settles the pending assistant card ($turn_complete alone does
   * not). */
  emitAbortedFinal(turn: number): ModelFinalEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.modelFinal,
      content: "[aborted by user — no response produced.]",
      toolCalls: [],
      usage: {},
      costUsd: 0,
    };
  }

  emitToolConfirmAllow(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
  ): ToolConfirmAllowEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolConfirmAllow,
      kind,
      payload: redactEventValue(payload),
    };
  }

  emitToolConfirmDeny(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
    denyContext?: string,
  ): ToolConfirmDenyEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolConfirmDeny,
      kind,
      payload: redactEventValue(payload),
      denyContext,
    };
  }

  emitToolConfirmAlwaysAllow(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
    prefix: string,
  ): ToolConfirmAlwaysAllowEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolConfirmAlwaysAllow,
      kind,
      payload: redactEventValue(payload),
      prefix,
    };
  }

  private turnStartedEvent(turn: number, ctx: EventizeContext): ModelTurnStartedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.modelTurnStarted,
      model: ctx.model,
      reasoningEffort: ctx.reasoningEffort,
      prefixHash: ctx.prefixHash,
    };
  }

  private deltaEvent(
    turn: number,
    channel: "content" | "reasoning" | "tool_args",
    text: string,
  ): ModelDeltaEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.modelDelta,
      channel,
      text,
    };
  }

  private finalEvent(ev: LoopEvent): ModelFinalEvent {
    const usage: RawUsage = ev.stats
      ? {
          prompt_tokens: ev.stats.usage.promptTokens,
          completion_tokens: ev.stats.usage.completionTokens,
          total_tokens: ev.stats.usage.totalTokens,
          prompt_cache_hit_tokens: ev.stats.usage.promptCacheHitTokens,
          prompt_cache_miss_tokens: ev.stats.usage.promptCacheMissTokens,
        }
      : {};
    const costUsd = ev.stats?.cost ?? 0;
    const out: ModelFinalEvent = {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: ev.turn,
      type: EventType.modelFinal,
      content: ev.content,
      // toolCalls land later via tool_start → tool.intent — not in this event.
      toolCalls: [] as ReadonlyArray<ToolCall>,
      usage,
      costUsd,
    };
    if (ev.reasoningContent !== undefined) out.reasoningContent = ev.reasoningContent;
    if (ev.replaceStreamedOutput) out.replaceStreamedOutput = true;
    if (ev.forcedSummary) out.forcedSummary = true;
    if (ev.image) out.image = ev.image;
    return out;
  }

  private toolPreparingEvent(turn: number, callId: string, name: string): ToolPreparingEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolPreparing,
      callId,
      name,
    };
  }

  private toolIntentEvent(
    turn: number,
    callId: string,
    name: string,
    args: string,
  ): ToolIntentEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolIntent,
      callId,
      name,
      args,
    };
  }

  private toolDispatchedEvent(turn: number, callId: string): ToolDispatchedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolDispatched,
      callId,
    };
  }

  private toolResultEvent(
    turn: number,
    callId: string,
    ok: boolean,
    output: string,
    durationMs: number,
  ): ToolResultEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.toolResult,
      callId,
      ok,
      output,
      durationMs,
    };
  }

  private statusEvent(turn: number, text: string): StatusEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.status,
      text,
    };
  }

  private compactionStartedEvent(
    turn: number,
    compactionId: string,
    reason: "user" | "auto-context-pressure",
    kind?: "fold" | "force-summary",
    aggressive?: boolean,
  ): CompactionStartedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.compactionStarted,
      compactionId,
      reason,
      ...(kind ? { kind } : {}),
      ...(aggressive ? { aggressive: true } : {}),
    };
  }

  private compactionFinishedEvent(
    compactionId: string,
    result: {
      turn: number;
      kind?: "fold" | "force-summary";
      folded: boolean;
      beforeMessages: number;
      afterMessages: number;
      summaryChars: number;
      summary?: string;
      error?: string;
      warn?: string;
      prunedFiles?: number;
      prunedTokens?: number;
      droppedFiles?: string[];
    },
  ): CompactionFinishedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: result.turn,
      type: EventType.compactionFinished,
      compactionId,
      ...(result.kind ? { kind: result.kind } : {}),
      folded: result.folded,
      beforeMessages: result.beforeMessages,
      afterMessages: result.afterMessages,
      summaryChars: result.summaryChars,
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.warn ? { warn: result.warn } : {}),
      ...(result.prunedFiles !== undefined ? { prunedFiles: result.prunedFiles } : {}),
      ...(result.prunedTokens !== undefined ? { prunedTokens: result.prunedTokens } : {}),
      ...(result.droppedFiles !== undefined ? { droppedFiles: result.droppedFiles } : {}),
    };
  }

  private errorEvent(
    turn: number,
    message: string,
    recoverable: boolean,
    detail?: { name?: string; code?: string; phase?: string; retryable?: boolean },
  ): KernelErrorEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: EventType.error,
      message,
      recoverable,
      ...detail,
    };
  }

  /** Pattern-match warning text since LoopEvent doesn't carry a typed kind. Returns null
   *  for low-severity warnings (self-correcting / counter messages); the UI surface drops
   *  them entirely instead of rendering noise. */
  private classifyWarning(ev: LoopEvent): Event | null {
    const c = ev.content;
    if (/\bauto-escalating to\b|\barmed\b.*pro|NEEDS_PRO/.test(c)) {
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: EventType.policyEscalated,
        fromModel: "",
        toModel: "",
        reason: c.includes("armed") ? "user-request" : "self-report",
      };
    }
    if (/budget\b.*\$|\$\d.*\/\s*\$\d/.test(c)) {
      const blocked = /blocked|exceeded|refus/i.test(c);
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: blocked ? EventType.policyBudgetBlocked : EventType.policyBudgetWarning,
        spentUsd: 0,
        capUsd: 0,
      };
    }
    if (ev.severity === "low") return null;
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: ev.turn,
      type: EventType.warning,
      text: c,
      severity: ev.severity ?? "high",
    };
  }
}

function looksLikeToolError(content: string, _toolName: string | undefined): boolean {
  if (!content) return false;
  if (content.startsWith("ERROR:")) return true;
  if (content.startsWith("[hook block]")) return true;
  if (/^\{"error"\s*:/.test(content)) return true;
  if (/\bConfirmationError:|\bNeedsConfirmationError\b/.test(content)) return true;
  return false;
}
