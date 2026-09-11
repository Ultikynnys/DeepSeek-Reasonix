/** Wire protocol shared with the desktop daemon. The event/command type
 *  definitions live in @reasonix/core-utils (desktop-protocol.ts) so a field
 *  change can't silently drift between the two sides of the JSON-RPC bridge.
 *  The kernel-event shapes below (model.* / tool.* / compaction.* / warning /
 *  error) are a read-only projection of the daemon's src/core/events.ts union
 *  and stay declared here until the kernel Event union itself moves into
 *  core-utils. */
import type {
  AntigravityQuota,
  AntigravityQuotaEvent,
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
  ConnectedEvent,
  CtxBreakdownEvent,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
  DirectKernelWireEvent,
  EditMode,
  JobInfo,
  JobsEvent,
  KernelCompactionFinishedEvent,
  KernelCompactionStartedEvent,
  KernelModelDeltaEvent,
  KernelModelFinalEvent,
  KernelModelTurnStartedEvent,
  KernelStatusEvent,
  KernelSubagentProgressEvent,
  KernelToolIntentEvent,
  KernelToolOutputEvent,
  KernelToolPreparingEvent,
  KernelToolResultEvent,
  KernelUsage,
  KernelUserMessageEvent,
  KernelWarningEvent,
  KernelWireToolCall,
  LoadedMessage,
  LoadedSegment,
  McpExtensionCheck,
  McpExtensionCheckEvent,
  McpExtensionServerState,
  McpExtensionStatus,
  McpExtensionStatusEvent,
  MailAuthEvent,
  MailAuthPhase,
  MailAuthState,
  PlaywrightBrowserInstall,
  PlaywrightBrowserInstallEvent,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  PlaywrightExtensionBrowser,
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
  OllamaGenerationPatch,
  OllamaGenerationSettings,
  OllamaModelsEvent,
  OllamaQuota,
  OllamaQuotaEvent,
  OllamaQuotaWindow,
  OpencodeModelsEvent,
  OutgoingCommand,
  PathAccessRequiredEvent,
  PlanClearedEvent,
  PlanRequiredEvent,
  PlanStep,
  PlanVerdict,
  ProtocolErrorEvent,
  QuickSend,
  ReadyEvent,
  ReasoningEffort,
  RetryResultEvent,
  RevisionRequiredEvent,
  RevisionVerdict,
  SessionCompactedEvent,
  SessionEmptyEvent,
  SessionLoadedEvent,
  SessionProviderCost,
  SessionRetractedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SettingsPayload,
  KernelErrorEvent as SharedKernelErrorEvent,
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
} from "@reasonix/core-utils";
import { invoke } from "@tauri-apps/api/core";

/** Re-export so UI components can identify Antigravity-routed model ids. */
export { isAntigravityModel } from "@reasonix/core-utils";
export {
  BUILTIN_QUICK_SENDS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  MailProvider,
  allQuickSends,
  enforceQuickSendShorthand,
  isQuickSend,
  resolveActiveQuickSend,
} from "@reasonix/core-utils";

export type {
  AntigravityQuota,
  AntigravityQuotaEvent,
  BalanceEvent,
  BtwResultEvent,
  ConnectedEvent,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
  OllamaModelsEvent,
  OllamaQuota,
  OllamaQuotaEvent,
  OllamaQuotaWindow,
  OpencodeModelsEvent,
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
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  McpExtensionCheck,
  McpExtensionCheckEvent,
  McpExtensionServerState,
  McpExtensionStatus,
  McpExtensionStatusEvent,
  MailAuthEvent,
  MailAuthPhase,
  MailAuthState,
  PlaywrightBrowserInstall,
  PlaywrightBrowserInstallEvent,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  PlaywrightExtensionBrowser,
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
  OllamaGenerationPatch,
  OllamaGenerationSettings,
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
  SessionLoadedEvent,
  SessionRetractedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SettingsPayload,
  SessionProviderCost,
  SkillInfo,
  SkillsEvent,
  SkillScope,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TurnCompleteEvent,
  UserImageAttachment,
  QuickSend,
  WebSearchEngineName,
};

/** Legacy alias for the memory-browser name (context-panel imports it). */
export type MemoryDetail = MemoryEntryDetail;

// ---- kernel events shared with the daemon ----

export type UserMessageEvent = KernelUserMessageEvent;
export type ModelTurnStartedEvent = KernelModelTurnStartedEvent;
export type ModelDeltaEvent = KernelModelDeltaEvent;
export type Usage = KernelUsage;
export type WireToolCall = KernelWireToolCall;
export type ModelFinalEvent = KernelModelFinalEvent;
export type ToolPreparingEvent = KernelToolPreparingEvent;
export type ToolIntentEvent = KernelToolIntentEvent;
export type ToolResultEvent = KernelToolResultEvent;
export type ToolOutputEvent = KernelToolOutputEvent;
export type SubagentProgressEvent = KernelSubagentProgressEvent;
export type StatusEvent = KernelStatusEvent;
export type CompactionStartedEvent = KernelCompactionStartedEvent;
export type CompactionFinishedEvent = KernelCompactionFinishedEvent;
export type WarningEvent = KernelWarningEvent;
export type KernelErrorEvent = SharedKernelErrorEvent;

export type IncomingEvent = { tabId?: string } & (
  | ConnectedEvent
  | ReadyEvent
  | ProtocolErrorEvent
  | TurnCompleteEvent
  | DesktopDiagnosticEvent
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
  | SessionsEvent
  | SessionLoadedEvent
  | SessionCompactedEvent
  | SessionEmptyEvent
  | NeedsSetupEvent
  | SettingsEvent
  | BalanceEvent
  | CodexQuotaEvent
  | OllamaQuotaEvent
  | OllamaModelsEvent
  | OpencodeModelsEvent
  | AntigravityQuotaEvent
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
  | McpExtensionStatusEvent
  | McpExtensionCheckEvent
  | MailAuthEvent
  | PlaywrightBrowserInstallEvent
  | SkillsEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | MemoryResultEvent
  | MemoryExportEvent
  | JobsEvent
  | DirectKernelWireEvent
  | SessionCompactedEvent
  | SessionRetractedEvent
  | RetryResultEvent
  | BtwResultEvent
  | { type: "oauth_begin_result"; url: string }
  | { type: "gemini_oauth_begin_result"; url: string }
);

/** Send one command to the desktop backend over the Tauri JSON-RPC bridge. */
export function rpcSend(cmd: OutgoingCommand): Promise<void> {
  return invoke("rpc_send", { line: JSON.stringify(cmd) });
}
