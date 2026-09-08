/** Event-log kernel types. Every transition is an appended Event; every view is a pure reducer projection (no I/O). */

import type {
  KernelCompactionFinishedEvent,
  KernelCompactionStartedEvent,
  KernelErrorEvent,
  KernelModelDeltaEvent,
  KernelModelFinalEvent,
  KernelModelTurnStartedEvent,
  KernelStatusEvent,
  KernelSubagentProgressEvent,
  KernelToolIntentEvent,
  KernelToolOutputEvent,
  KernelToolPreparingEvent,
  KernelToolResultEvent,
  KernelUserMessageEvent,
  KernelWarningEvent,
  KernelWireEventBase,
} from "@reasonix/core-utils";
import type { PlanStep, PlanStepRisk, StepCompletion } from "../tools/plan-types.js";
import type { ChatMessage } from "../types.js";

export type EventId = number;

export interface EventBase extends KernelWireEventBase {}

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
  /** Transient mid-run stdout/stderr feed for a blocking shell tool (`run_command`). */
  toolOutput: "tool.output",

  toolConfirmAllow: "tool.confirm.allow",
  toolConfirmDeny: "tool.confirm.deny",
  toolConfirmAlwaysAllow: "tool.confirm.always_allow",
  effectFileTouched: "effect.file.touched",
  effectMemoryWritten: "effect.memory.written",
  planSubmitted: "plan.submitted",
  planStepCompleted: "plan.step.completed",
  hookFired: "hook.fired",
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

export interface UserMessageEvent extends KernelUserMessageEvent {
  attachments?: ReadonlyArray<{ kind: "file" | "url"; ref: string }>;
}

export interface SlashInvokedEvent extends EventBase {
  type: typeof EventType.slashInvoked;
  name: string;
  args: string;
}

export interface ModelTurnStartedEvent extends KernelModelTurnStartedEvent {}

export interface ModelDeltaEvent extends KernelModelDeltaEvent {
  toolCallIndex?: number;
}

export interface ModelFinalEvent extends KernelModelFinalEvent {}

export interface ToolPreparingEvent extends KernelToolPreparingEvent {}

export interface ToolIntentEvent extends KernelToolIntentEvent {}

export interface ToolDispatchedEvent extends EventBase {
  type: typeof EventType.toolDispatched;
  callId: string;
}

export interface ToolDeniedEvent extends EventBase {
  type: typeof EventType.toolDenied;
  callId: string;
  reason: "permission" | "budget" | "policy" | "hook";
}

export interface ToolResultEvent extends KernelToolResultEvent {
  truncated?: boolean;
  durationMs: number;
}

export interface ToolCallEvent extends EventBase {
  type: typeof EventType.toolCall;
  name: string;
  args: Record<string, unknown>;
}

/** Transient incremental stdout/stderr of a blocking shell tool call. Never
 *  persisted; fills the gap between dispatch and settle. The authoritative
 *  full output arrives on the matching `tool.result`. */
export interface ToolOutputEvent extends KernelToolOutputEvent {}

/** Sanitized, transient child-agent activity. Raw child output and reasoning never enter this event. */
export interface SubagentProgressEvent extends KernelSubagentProgressEvent {}

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

export interface CompactionStartedEvent extends KernelCompactionStartedEvent {}

export interface CompactionFinishedEvent extends KernelCompactionFinishedEvent {}

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
export interface StatusEvent extends KernelStatusEvent {}

export interface ErrorEvent extends KernelErrorEvent {
  name?: string;
  code?: string;
  phase?: string;
  retryable?: boolean;
}

/** Non-fatal system event surfaced to UIs as a quiet inline divider — compaction,
 *  rate-limit pause, user-aborted iter, storm-stuck interrupt, etc. Carries a
 *  severity so noisy/self-correcting warnings can be filtered out by the surface. */
export interface WarningEvent extends KernelWarningEvent {}

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
  | ToolOutputEvent
  | ToolConfirmAllowEvent
  | ToolConfirmDenyEvent
  | ToolConfirmAlwaysAllowEvent
  | FileTouchedEvent
  | MemoryWrittenEvent
  | PlanSubmittedEvent
  | PlanStepCompletedEvent
  | HookFiredEvent
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
  plan: PlanView;
  workspace: WorkspaceView;
  capabilities: CapabilityView;
  status: StatusView;
  session: SessionMetaView;
}
