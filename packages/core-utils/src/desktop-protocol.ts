/** Wire protocol shared by the desktop daemon (src/cli/commands/desktop.ts)
 *  and the Tauri React shell (desktop/src/protocol.ts). Both bundles import
 *  these shapes from here so a field change can't silently drift between the
 *  two sides of the JSON-RPC bridge. */

import type { ApprovalPrompt } from "./approval-prompt.js";
import type { ChoiceOption, PlanStep, ReasoningEffort } from "./permission-types.js";

export type EditMode = "review" | "auto" | "yolo" | "plan";

export type WebSearchEngineName =
  | "bing"
  | "searxng"
  | "metaso"
  | "tavily"
  | "perplexity"
  | "exa"
  | "brave"
  | "ollama";

export type ExternalSessionSource = "claude" | "codex";

export interface ExternalSessionApp {
  source: ExternalSessionSource;
  label: string;
  root: string;
  available: boolean;
  sessionCount: number;
  latestMtime?: string;
}

// ---- events ----

export type ReadyEvent = { type: "$ready" };
export type ProtocolErrorEvent = { type: "$error"; message: string };
export type TurnCompleteEvent = { type: "$turn_complete" };

export interface ConfirmRequiredEvent {
  type: "$confirm_required";
  id: number;
  kind: "run_command" | "run_background";
  command: string;
  prompt?: ApprovalPrompt;
}

export interface PathAccessRequiredEvent {
  type: "$path_access_required";
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt?: ApprovalPrompt;
}

export interface ChoiceRequiredEvent {
  type: "$choice_required";
  id: number;
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
}

export interface PlanRequiredEvent {
  type: "$plan_required";
  id: number;
  plan: string;
  steps?: unknown[];
  summary?: string;
  /** YOLO auto-approval window (ms) — the card auto-picks the first option at expiry. */
  countdownMs?: number;
}

export interface CheckpointRequiredEvent {
  type: "$checkpoint_required";
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
}

export interface RevisionRequiredEvent {
  type: "$revision_required";
  id: number;
  reason: string;
  remainingSteps: PlanStep[];
  summary?: string;
  /** YOLO auto-approval window (ms) — the card auto-picks accept rewrite at expiry. */
  countdownMs?: number;
}

export interface StepCompletedEvent {
  type: "$step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
}

export type PlanClearedEvent = { type: "$plan_cleared" };

export interface SessionsEvent {
  type: "$sessions";
  items: {
    name: string;
    messageCount: number;
    mtime: string;
    summary?: string;
    workspaceStatus?: "matched" | "legacy_missing_meta";
  }[];
}

export interface SessionImportSourcesEvent {
  type: "$session_import_sources";
  apps: ExternalSessionApp[];
}

export interface SessionImportResultEvent {
  type: "$session_import_result";
  imported: number;
  skipped: number;
  failed: number;
}

export interface MentionResultsEvent {
  type: "$mention_results";
  nonce: number;
  query: string;
  results: string[];
}

export interface MentionPreviewEvent {
  type: "$mention_preview";
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
}

export interface TabOpenedEvent {
  type: "$tab_opened";
  workspaceDir: string;
  /** True when the frontend should focus this tab (user-opened, or the restored focused tab). */
  active?: boolean;
}

export type TabClosedEvent = { type: "$tab_closed" };

export type McpSpecStatus = "configured" | "handshake" | "connected" | "failed" | "disabled";

export interface McpSpecInfo {
  raw: string;
  name: string | null;
  transport: "stdio" | "sse" | "streamable-http";
  summary: string;
  parseError?: string;
  status: McpSpecStatus;
  statusReason?: string;
  toolCount?: number;
}

export interface McpSpecsEvent {
  type: "$mcp_specs";
  specs: McpSpecInfo[];
  bridged: boolean;
}

export type SkillScope = "project" | "custom" | "global" | "builtin";

export interface SkillInfo {
  name: string;
  description: string;
  scope: SkillScope;
  path: string;
  runAs: "inline" | "subagent";
  model?: string;
}

export interface SkillsEvent {
  type: "$skills";
  items: SkillInfo[];
}

export interface CtxBreakdownEvent {
  type: "$ctx_breakdown";
  reservedTokens: number;
  /** Current log token count (real-time) — sent after /compact to refresh the meter. */
  logTokens?: number;
  /** Model context cap — denominator + compaction-limit ticks for the meter. */
  ctxMax?: number;
}

export type MemoryEntryKind = "project_file" | "global_file" | "structured";

export interface MemoryEntryInfo {
  kind: MemoryEntryKind;
  scope: "project" | "global";
  name: string;
  path: string;
  description: string;
  type?: string;
}

export type MemoryEntryDetail = MemoryEntryInfo & {
  body: string;
  createdAt?: string;
};

export interface MemoryEvent {
  type: "$memory";
  entries: MemoryEntryInfo[];
}

export interface MemoryDetailEvent {
  type: "$memory_detail";
  detail: MemoryEntryDetail;
}

export interface MemoryResultEvent {
  type: "$memory_result";
  ok: boolean;
  message: string;
}

export interface MemoryExportEvent {
  type: "$memory_export";
  text: string;
}

export type RetryResultEvent = { type: "$retry_result"; text: string };

export type BtwResultEvent = { type: "$btw_result"; question: string; answer: string };

export type RewindResultEvent = { type: "$rewind_result"; turn: number; text: string };

export interface JobInfo {
  id: number;
  tabId: string;
  sessionLabel: string;
  command: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  outputTail: string;
  spawnError?: string;
}

export interface JobsEvent {
  type: "$jobs";
  items: JobInfo[];
}

export type LoadedSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      result?: string;
      ok?: boolean;
    };

export type LoadedMessage =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      turn: number;
      segments: LoadedSegment[];
      pending: false;
    };

export interface SessionLoadedEvent {
  type: "$session_loaded";
  name: string;
  messages: LoadedMessage[];
  carryover: {
    totalCostUsd: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalCompletionTokens: number;
  };
}

/** A fold committed and REPLACED the conversation — the chat must swap its
 *  message list to the post-fold log (summary message + preserved tail), like
 *  a session reload. `replacementMessages` ships in the same LoadedMessage
 *  wire shape as $session_loaded.messages. */
export interface SessionCompactedEvent {
  type: "session.compacted";
  id: number;
  ts: string;
  turn: number;
  beforeMessages: number;
  afterMessages: number;
  reason: "user" | "auto-context-pressure";
  replacementMessages: LoadedMessage[];
}

export interface SessionEmptyEvent {
  type: "$session_empty";
  name: string;
  sizeBytes: number;
}

export type NeedsSetupEvent = { type: "$needs_setup"; reason: "no_api_key" };

export interface SettingsEvent {
  type: "$settings";
  reasoningEffort: ReasoningEffort;
  editMode: EditMode;
  budgetUsd: number | null;
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  model: string;
  editor?: string;
  webSearchEngine?: WebSearchEngineName;
  webSearchEndpoint?: string;
  webSearchApiKeys?: {
    metaso?: string;
    tavily?: string;
    perplexity?: string;
    exa?: string;
    ollama?: string;
    brave?: string;
  };
  subagentModels?: Record<string, "flash" | "pro">;
  showSystemEvents?: boolean;
  version: string;
}

export interface QQSettingsEvent {
  type: "$qq_settings";
  appId?: string;
  appSecret?: string;
  sandbox: boolean;
  enabled: boolean;
  configured: boolean;
  runtimeState: "disconnected" | "connecting" | "connected" | "failed";
  lastError?: string;
  appIdPreview?: string;
  access: string;
}

export interface BalanceInfoItem {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
}

export interface BalanceEvent {
  type: "$balance";
  currency: string;
  total: number;
  isAvailable: boolean;
  balanceInfos: BalanceInfoItem[];
}

// ---- commands ----

export interface SettingsPatch {
  reasoningEffort?: ReasoningEffort;
  editMode?: EditMode;
  budgetUsd?: number | null;
  baseUrl?: string;
  workspaceDir?: string;
  model?: string;
  editor?: string;
  webSearchEngine?: WebSearchEngineName;
  webSearchEndpoint?: string | null;
  metasoApiKey?: string | null;
  tavilyApiKey?: string | null;
  perplexityApiKey?: string | null;
  exaApiKey?: string | null;
  ollamaApiKey?: string | null;
  braveApiKey?: string | null;
  subagentModels?: Record<string, "flash" | "pro">;
  showSystemEvents?: boolean;
}

export interface QQConfigPatch {
  appId?: string;
  appSecret?: string;
  sandbox: boolean;
}

export type OutgoingCommand = { tabId?: string } & (
  | { cmd: "user_input"; text: string }
  | { cmd: "abort" }
  | { cmd: "cancel_tool" }
  | { cmd: "confirm_response"; id: number; response: import("./permission-types.js").ConfirmationChoice }
  | { cmd: "choice_response"; id: number; response: import("./permission-types.js").ChoiceVerdict }
  | { cmd: "plan_response"; id: number; response: import("./permission-types.js").PlanVerdict }
  | { cmd: "checkpoint_response"; id: number; response: import("./permission-types.js").CheckpointVerdict }
  | { cmd: "revision_response"; id: number; response: import("./permission-types.js").RevisionVerdict }
  | { cmd: "session_list" }
  | { cmd: "desktop_resync" }
  | { cmd: "session_delete"; name: string }
  | { cmd: "session_load"; name: string }
  | { cmd: "session_rename"; name: string; title: string }
  | { cmd: "session_import"; source: ExternalSessionSource; path: string; name?: string }
  | { cmd: "session_import_scan" }
  | { cmd: "session_import_bulk"; sources: ExternalSessionSource[] }
  | { cmd: "memory_read"; path: string }
  | {
      cmd: "memory_write";
      scope: "global" | "project";
      name: string;
      description: string;
      body: string;
      type?: string;
      priority?: "low" | "medium" | "high";
    }
  | { cmd: "memory_delete"; path: string }
  | { cmd: "memory_export" }
  | { cmd: "memory_import"; json: string }
  | { cmd: "new_chat" }
  | { cmd: "setup_save_key"; key: string }
  | { cmd: "settings_get" }
  | ({ cmd: "settings_save" } & SettingsPatch)
  | { cmd: "qq_status_get" }
  | { cmd: "qq_connect" }
  | { cmd: "qq_disconnect" }
  | ({ cmd: "qq_config_save" } & QQConfigPatch)
  | { cmd: "mention_query"; query: string; nonce: number }
  | { cmd: "mention_preview"; path: string; nonce: number }
  | { cmd: "mention_picked"; path: string }
  | { cmd: "tab_open"; workspaceDir?: string }
  | { cmd: "tab_close" }
  | { cmd: "tab_activate"; tabId: string }
  | { cmd: "mcp_specs_get" }
  | { cmd: "mcp_specs_add"; spec: string }
  | { cmd: "mcp_specs_remove"; spec: string }
  | { cmd: "skills_get" }
  | { cmd: "skill_run"; name: string; args?: string }
  | { cmd: "jobs_list" }
  | { cmd: "jobs_stop"; jobId: number }
  | { cmd: "jobs_stop_all" }
  | { cmd: "compact_history" }
  | { cmd: "retry" }
  | { cmd: "rewind"; userTurn: number }
  | { cmd: "btw"; text: string }
);
