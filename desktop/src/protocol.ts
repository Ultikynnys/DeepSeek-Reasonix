/** Wire protocol shared with the desktop daemon. The event/command type
 *  definitions live in @reasonix/core-utils (desktop-protocol.ts) so a field
 *  change can't silently drift between the two sides of the JSON-RPC bridge.
 *  The kernel-event shapes below (model.* / tool.* / compaction.* / warning /
 *  error) are a read-only projection of the daemon's src/core/events.ts union
 *  and stay declared here until the kernel Event union itself moves into
 *  core-utils. */
import type {
  BalanceEvent,
  BtwResultEvent,
  CheckpointRequiredEvent,
  CheckpointVerdict,
  ChoiceOption,
  ChoiceRequiredEvent,
  ChoiceVerdict,
  CodexQuota,
  CodexQuotaEvent,
  ConfirmRequiredEvent,
  ConfirmationChoice,
  CtxBreakdownEvent,
  EditMode,
  ExternalSessionApp,
  ExternalSessionSource,
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  McpSpecInfo,
  McpSpecStatus,
  McpSpecsEvent,
  MemoryDetailEvent,
  MemoryEntryDetail,
  MemoryEntryInfo,
  MemoryEntryKind,
  MemoryEvent,
  MemoryExportEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  ModelEndpointInfo,
  NeedsSetupEvent,
  OutgoingCommand,
  PathAccessRequiredEvent,
  PlanClearedEvent,
  PlanRequiredEvent,
  PlanStep,
  PlanVerdict,
  ProtocolErrorEvent,
  ReadyEvent,
  ReasoningEffort,
  RetryResultEvent,
  RevisionRequiredEvent,
  RevisionVerdict,
  SessionCompactedEvent,
  SessionEmptyEvent,
  SessionImportResultEvent,
  SessionImportSourcesEvent,
  SessionLoadedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SkillInfo,
  SkillScope,
  SkillsEvent,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TabsSnapshotEvent,
  TurnCompleteEvent,
  UserImageAttachment,
  WebSearchEngineName,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
} from "@reasonix/core-utils";
import { invoke } from "@tauri-apps/api/core";

export type {
  BalanceEvent,
  BtwResultEvent,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
  CheckpointRequiredEvent,
  CheckpointVerdict,
  ChoiceOption,
  ChoiceRequiredEvent,
  ChoiceVerdict,
  CodexQuota,
  CodexQuotaEvent,
  ConfirmRequiredEvent,
  ConfirmationChoice,
  CtxBreakdownEvent,
  EditMode,
  ExternalSessionApp,
  ExternalSessionSource,
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  McpSpecInfo,
  McpSpecsEvent,
  McpSpecStatus,
  MemoryDetailEvent,
  MemoryEntryDetail,
  MemoryEntryInfo,
  MemoryEntryKind,
  MemoryEvent,
  MemoryExportEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  ModelEndpointInfo,
  NeedsSetupEvent,
  OutgoingCommand,
  PathAccessRequiredEvent,
  PlanClearedEvent,
  PlanRequiredEvent,
  PlanStep,
  PlanVerdict,
  ProtocolErrorEvent,
  ReadyEvent,
  ReasoningEffort,
  RetryResultEvent,
  RevisionRequiredEvent,
  RevisionVerdict,
  SessionCompactedEvent,
  SessionEmptyEvent,
  SessionImportResultEvent,
  SessionImportSourcesEvent,
  SessionLoadedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SkillInfo,
  SkillsEvent,
  SkillScope,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TurnCompleteEvent,
  UserImageAttachment,
  WebSearchEngineName,
};

/** Legacy alias for the memory-browser name (context-panel imports it). */
export type MemoryDetail = MemoryEntryDetail;

// ---- kernel-event projections (daemon source of truth: src/core/events.ts) ----

export type UserMessageEvent = {
  type: "user.message";
  id: number;
  ts: string;
  turn: number;
  text: string;
};

export type ModelTurnStartedEvent = {
  type: "model.turn.started";
  id: number;
  ts: string;
  turn: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  prefixHash: string;
};

export type ModelDeltaEvent = {
  type: "model.delta";
  id: number;
  ts: string;
  turn: number;
  channel: "content" | "reasoning" | "tool_args";
  text: string;
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/** Mirror of the daemon's ToolCall (src/types.ts) — rides model.final. */
export type WireToolCall = {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ModelFinalEvent = {
  type: "model.final";
  id: number;
  ts: string;
  turn: number;
  content: string;
  reasoningContent?: string;
  toolCalls: ReadonlyArray<WireToolCall>;
  usage: Usage;
  costUsd: number;
  /** True iff this was the no-tools wrap-up after budget / abort / context guard. */
  forcedSummary?: boolean;
};

export type ToolPreparingEvent = {
  type: "tool.preparing";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  name: string;
};

export type ToolIntentEvent = {
  type: "tool.intent";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  name: string;
  args: string;
};

export type ToolResultEvent = {
  type: "tool.result";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  ok: boolean;
  output: string;
};

export type SubagentProgressEvent = {
  type: "subagent.progress";
  id: number;
  ts: string;
  turn: number;
  runId: string;
  parentCallId?: string;
  action: "start" | "phase" | "stream" | "tool-start" | "tool-end" | "end";
  task: string;
  skillName?: string;
  model?: string;
  phase?: "exploring" | "summarising";
  iter?: number;
  elapsedMs?: number;
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  childCallId?: string;
  toolName?: string;
  toolArgs?: string;
  toolOk?: boolean;
  error?: string;
  turns?: number;
  costUsd?: number;
  maxToolIters?: number;
  maxElapsedMs?: number;
  budgetExhausted?: "tool-iters" | "elapsed";
};

export type StatusEvent = {
  type: "status";
  id: number;
  ts: string;
  turn: number;
  text: string;
};

export type CompactionStartedEvent = {
  type: "compaction.started";
  id: number;
  ts: string;
  turn: number;
  /** Stable id pairing start with its finished event — the UI keys the card by it. */
  compactionId: string;
  reason: "user" | "auto-context-pressure";
  /** "fold" = head folded into a summary message; "force-summary" = context-guard / stuck trim + summarize in place. */
  kind?: "fold" | "force-summary";
  aggressive?: boolean;
};

export type CompactionFinishedEvent = {
  type: "compaction.finished";
  id: number;
  ts: string;
  turn: number;
  /** Same compactionId as the matching started event. */
  compactionId: string;
  /** "fold" = head folded into a summary message; "force-summary" = context-guard / stuck trim + summarize in place. */
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
  /** File paths the fold's triage step classified as no longer relevant — the
   *  "Files in context" panel drops them. */
  droppedFiles?: string[];
};

export type WarningEvent = {
  type: "warning";
  id: number;
  ts: string;
  turn: number;
  text: string;
  severity: "low" | "high";
};

export type KernelErrorEvent = {
  type: "error";
  id: number;
  ts: string;
  turn: number;
  message: string;
  recoverable: boolean;
};

export type IncomingEvent = { tabId?: string } & (
  | ReadyEvent
  | ProtocolErrorEvent
  | TurnCompleteEvent
  | DesktopDiagnosticEvent
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
  | SessionsEvent
  | SessionImportSourcesEvent
  | SessionImportResultEvent
  | SessionLoadedEvent
  | SessionCompactedEvent
  | SessionEmptyEvent
  | NeedsSetupEvent
  | SettingsEvent
  | BalanceEvent
  | CodexQuotaEvent
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | TabOpenedEvent
  | TabClosedEvent
  | TabsSnapshotEvent
  | McpSpecsEvent
  | SkillsEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | MemoryResultEvent
  | MemoryExportEvent
  | JobsEvent
  | UserMessageEvent
  | ModelTurnStartedEvent
  | ModelDeltaEvent
  | ModelFinalEvent
  | ToolPreparingEvent
  | ToolIntentEvent
  | ToolResultEvent
  | SubagentProgressEvent
  | StatusEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | WarningEvent
  | KernelErrorEvent
  | RetryResultEvent
  | BtwResultEvent
  | { type: "oauth_begin_result"; url: string }
);

/** Send one command to the desktop backend over the Tauri JSON-RPC bridge. */
export function rpcSend(cmd: OutgoingCommand): Promise<void> {
  return invoke("rpc_send", { line: JSON.stringify(cmd) });
}
