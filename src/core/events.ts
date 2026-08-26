/** Event-log kernel types. Every transition is an appended Event; every view is a pure reducer projection (no I/O). */

import type { PlanStep, PlanStepRisk, StepCompletion } from "../tools/plan-types.js";
import type { ChatMessage, RawUsage, ToolCall } from "../types.js";

export type EventId = number;

export interface EventBase {
  id: EventId;
  ts: string;
  turn: number;
}

/** Event type-name constants — emit sites (eventize.ts), reducer cases, and the desktop bridge reference these instead of restating literals. */
export const EventType = {
  userMessage: "user.message",
  slashInvoked: "slash.invoked",
  modelTurnStarted: "model.turn.started",
  modelDelta: "model.delta",
  modelFinal: "model.final",
  toolPreparing: "tool.preparing",
  toolIntent: "tool.intent",
  toolDispatched: "tool.dispatched",
  toolDenied: "tool.denied",
  toolResult: "tool.result",
  toolCall: "tool.call",
  subagentProgress: "subagent.progress",

  toolConfirmAllow: "tool.confirm.allow",
  toolConfirmDeny: "tool.confirm.deny",
  toolConfirmAlwaysAllow: "tool.confirm.always_allow",
  effectFileTouched: "effect.file.touched",
  effectMemoryWritten: "effect.memory.written",
  planSubmitted: "plan.submitted",
  planStepCompleted: "plan.step.completed",
  hookFired: "hook.fired",
  policyBudgetWarning: "policy.budget.warning",
  policyBudgetBlocked: "policy.budget.blocked",
  policyEscalated: "policy.escalated",
  sessionOpened: "session.opened",
  sessionCompacted: "session.compacted",
  sessionRetracted: "session.retracted",
  compactionStarted: "compaction.started",
  compactionFinished: "compaction.finished",
  capabilityRegistered: "capability.registered",
  capabilityRemoved: "capability.removed",
  status: "status",
  error: "error",
  warning: "warning",
} as const;

export interface UserMessageEvent extends EventBase {
  type: typeof EventType.userMessage;
  text: string;
  attachments?: ReadonlyArray<{ kind: "file" | "url"; ref: string }>;
}

export interface SlashInvokedEvent extends EventBase {
  type: typeof EventType.slashInvoked;
  name: string;
  args: string;
}

export interface ModelTurnStartedEvent extends EventBase {
  type: typeof EventType.modelTurnStarted;
  model: string;
  reasoningEffort: import("../config.js").ReasoningEffort;
  prefixHash: string;
}

export interface ModelDeltaEvent extends EventBase {
  type: typeof EventType.modelDelta;
  channel: "content" | "reasoning" | "tool_args";
  text: string;
  toolCallIndex?: number;
}

export interface ModelFinalEvent extends EventBase {
  type: typeof EventType.modelFinal;
  content: string;
  reasoningContent?: string;
  toolCalls: ReadonlyArray<ToolCall>;
  usage: RawUsage;
  costUsd: number;
  /** True iff this was the no-tools wrap-up after budget / abort / context guard. */
  forcedSummary?: boolean;
  /** Model-generated image (assistant image output) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
}

export interface ToolPreparingEvent extends EventBase {
  type: typeof EventType.toolPreparing;
  callId: string;
  name: string;
}

export interface ToolIntentEvent extends EventBase {
  type: typeof EventType.toolIntent;
  callId: string;
  name: string;
  /** JSON string exactly as the model emitted it. */
  args: string;
}

export interface ToolDispatchedEvent extends EventBase {
  type: typeof EventType.toolDispatched;
  callId: string;
}

export interface ToolDeniedEvent extends EventBase {
  type: typeof EventType.toolDenied;
  callId: string;
  reason: "permission" | "budget" | "policy" | "hook";
}

export interface ToolResultEvent extends EventBase {
  type: typeof EventType.toolResult;
  callId: string;
  ok: boolean;
  output: string;
  truncated?: boolean;
  durationMs: number;
}

export interface ToolCallEvent extends EventBase {
  type: typeof EventType.toolCall;
  name: string;
  args: Record<string, unknown>;
}

/** Sanitized, transient child-agent activity. Raw child output and reasoning never enter this event. */
export interface SubagentProgressEvent extends EventBase {
  type: typeof EventType.subagentProgress;
  runId: string;
  parentCallId?: string;
  action: "start" | "phase" | "stream" | "tool-start" | "tool-end" | "end";
  task: string;
  skillName?: string;
  model?: string;
  phase?: "exploring" | "summarising";
  iter?: number;
  elapsedMs?: number;
  /** Latest prompt size reported by the child model call. */
  contextTokens?: number;
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  childCallId?: string;
  toolName?: string;
  /** Redacted and bounded JSON arguments; never includes a tool result body. */
  toolArgs?: string;
  toolOk?: boolean;
  error?: string;
  turns?: number;
  costUsd?: number;
  /** "usd" = token-priced cost, "quota" = provider plan window %, "none" = unmeasurable. */
  billingKind?: "usd" | "quota" | "none";
  /** Percent points of the provider plan window consumed by this run, when measurable. */
  quotaUsedPct?: number;
  maxToolIters?: number;
  maxElapsedMs?: number;
  budgetExhausted?: "tool-iters" | "elapsed";
}

export interface ToolConfirmAllowEvent extends EventBase {
  type: typeof EventType.toolConfirmAllow;
  kind: "run_command" | "run_background";
  payload: { command: string };
}

export interface ToolConfirmDenyEvent extends EventBase {
  type: typeof EventType.toolConfirmDeny;
  kind: "run_command" | "run_background";
  payload: { command: string };
  denyContext?: string;
}

export interface ToolConfirmAlwaysAllowEvent extends EventBase {
  type: typeof EventType.toolConfirmAlwaysAllow;
  kind: "run_command" | "run_background";
  payload: { command: string };
  prefix: string;
}

export interface FileTouchedEvent extends EventBase {
  type: typeof EventType.effectFileTouched;
  path: string;
  mode: "create" | "edit" | "delete";
  bytes: number;
}

export interface MemoryWrittenEvent extends EventBase {
  type: typeof EventType.effectMemoryWritten;
  scope: "user" | "project" | "hash";
  key: string;
}

export interface PlanSubmittedEvent extends EventBase {
  type: typeof EventType.planSubmitted;
  steps: ReadonlyArray<PlanStep>;
  body: string;
}

export interface PlanStepCompletedEvent extends EventBase {
  type: typeof EventType.planStepCompleted;
  stepId: string;
  title?: string;
  notes?: string;
  /** Raw payload echoed for replay; mirrors what the tool returned. */
  completion: StepCompletion;
}

export interface HookFiredEvent extends EventBase {
  type: typeof EventType.hookFired;
  hookName: string;
  phase: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  outcome: "ok" | "blocked" | "modified" | "error";
}

export interface BudgetWarningEvent extends EventBase {
  type: typeof EventType.policyBudgetWarning;
  spentUsd: number;
  capUsd: number;
}

export interface BudgetBlockedEvent extends EventBase {
  type: typeof EventType.policyBudgetBlocked;
  spentUsd: number;
  capUsd: number;
}

export interface EscalatedEvent extends EventBase {
  type: typeof EventType.policyEscalated;
  fromModel: string;
  toModel: string;
  reason: "self-report" | "failure-threshold" | "user-request";
  /** Optional one-liner rationale from the `<<<NEEDS_PRO: ...>>>` form. */
  rationale?: string;
}

export interface SessionOpenedEvent extends EventBase {
  type: typeof EventType.sessionOpened;
  name: string;
  resumedFromTurn: number;
}

export interface SessionCompactedEvent extends EventBase {
  type: typeof EventType.sessionCompacted;
  beforeMessages: number;
  afterMessages: number;
  reason: "user" | "auto-context-pressure";
  /** Post-compact message list. Only event that REPLACES (not appends) the conversation view. */
  replacementMessages: ReadonlyArray<ChatMessage>;
}

/** A session edit truncated the live log (retry / rewind / abort-discard). Like
 *  session.compacted: the one event that REPLACES the conversation view, so
 *  replaying the events sidecar yields the truncated conversation. */
export interface SessionRetractedEvent extends EventBase {
  type: typeof EventType.sessionRetracted;
  /** What session edit truncated the log. */
  kind: "retry" | "rewind" | "abort-discard";
  beforeMessages: number;
  afterMessages: number;
  /** Post-truncation message list — REPLACES the conversation view. */
  replacementMessages: ReadonlyArray<ChatMessage>;
}

export interface CompactionStartedEvent extends EventBase {
  type: typeof EventType.compactionStarted;
  /** Stable id pairing start with its finished event — the UI keys the card by it. */
  compactionId: string;
  reason: "user" | "auto-context-pressure";
  /** What kind of compaction runs — "fold" (head folded into a summary message) vs
   *  "force-summary" (log trimmed + summarized in place under the context guard). */
  kind?: "fold" | "force-summary";
  /** True when the fold is in the 70-85% aggressive band — user-facing messaging. */
  aggressive?: boolean;
}

export interface CompactionFinishedEvent extends EventBase {
  type: typeof EventType.compactionFinished;
  /** Same compactionId as the matching started event. */
  compactionId: string;
  /** What kind of compaction ran — see CompactionStartedEvent.kind. */
  kind?: "fold" | "force-summary";
  folded: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryChars: number;
  /** The synthesized summary text — lets the card render the recap inline. */
  summary?: string;
  /** Why the fold didn't happen, when the summarizer failed (timeout / API error). */
  error?: string;
  /** Advisory warning on a successful fold — e.g. file triage failed, nothing dropped. */
  warn?: string;
  /** Unique file paths whose read results were pruned by the fold's prune step. */
  prunedFiles?: number;
  /** Tokens saved by the prune step. */
  prunedTokens?: number;
}

export interface CapabilityRegisteredEvent extends EventBase {
  type: typeof EventType.capabilityRegistered;
  name: string;
  permission: "ask" | "allow" | "deny";
}

export interface CapabilityRemovedEvent extends EventBase {
  type: typeof EventType.capabilityRemoved;
  name: string;
}

/** Transient — never persisted, drops on next primary event. */
export interface StatusEvent extends EventBase {
  type: typeof EventType.status;
  text: string;
}

export interface ErrorEvent extends EventBase {
  type: typeof EventType.error;
  message: string;
  recoverable: boolean;
  name?: string;
  code?: string;
  phase?: string;
  retryable?: boolean;
}

/** Non-fatal system event surfaced to UIs as a quiet inline divider — compaction,
 *  rate-limit pause, user-aborted iter, storm-stuck interrupt, etc. Carries a
 *  severity so noisy/self-correcting warnings can be filtered out by the surface. */
export interface WarningEvent extends EventBase {
  type: typeof EventType.warning;
  text: string;
  severity: "low" | "high";
}

export type Event =
  | UserMessageEvent
  | SlashInvokedEvent
  | ModelTurnStartedEvent
  | ModelDeltaEvent
  | ModelFinalEvent
  | ToolPreparingEvent
  | ToolIntentEvent
  | ToolDispatchedEvent
  | ToolDeniedEvent
  | ToolResultEvent
  | ToolCallEvent
  | SubagentProgressEvent
  | ToolConfirmAllowEvent
  | ToolConfirmDenyEvent
  | ToolConfirmAlwaysAllowEvent
  | FileTouchedEvent
  | MemoryWrittenEvent
  | PlanSubmittedEvent
  | PlanStepCompletedEvent
  | HookFiredEvent
  | BudgetWarningEvent
  | BudgetBlockedEvent
  | EscalatedEvent
  | SessionOpenedEvent
  | SessionCompactedEvent
  | SessionRetractedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | CapabilityRegisteredEvent
  | CapabilityRemovedEvent
  | StatusEvent
  | ErrorEvent
  | WarningEvent;

export type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>;

/** Pure projection: folds an event slice into a view. No I/O. */
export type Reducer<TView> = (view: TView, ev: Event) => TView;

export interface ConversationView {
  messages: ReadonlyArray<ChatMessage>;
  pendingToolCalls: ReadonlyArray<{ callId: string; name: string }>;
}

export interface BudgetView {
  spentUsd: number;
  capUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  warned: boolean;
  blocked: boolean;
}

export interface PlanStepView {
  id: string;
  title: string;
  action: string;
  risk?: PlanStepRisk;
  completed: boolean;
  notes?: string;
}

export interface PlanView {
  steps: ReadonlyArray<PlanStepView>;
  body: string | null;
  submittedTurn: number | null;
}

export interface WorkspaceView {
  filesTouched: ReadonlyMap<string, "create" | "edit" | "delete">;
}

export interface CapabilityView {
  tools: ReadonlyArray<{ name: string; permission: "ask" | "allow" | "deny" }>;
}

export interface StatusView {
  current: string | null;
}

export interface SessionMetaView {
  name: string | null;
  openedAt: string | null;
  resumedFromTurn: number | null;
  currentTurn: number;
  lastError: string | null;
}

export interface ProjectionSet {
  conversation: ConversationView;
  budget: BudgetView;
  plan: PlanView;
  workspace: WorkspaceView;
  capabilities: CapabilityView;
  status: StatusView;
  session: SessionMetaView;
}
