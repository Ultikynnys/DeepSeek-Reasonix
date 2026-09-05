/** Wire protocol shared by the desktop daemon (src/cli/commands/desktop.ts)
 *  and the Tauri React shell (desktop/src/protocol.ts). Both bundles import
 *  these shapes from here so a field change can't silently drift between the
 *  two sides of the JSON-RPC bridge. */

import type { ApprovalPrompt } from "./approval-prompt.js";
import type { ChoiceOption, PlanStep, ReasoningEffort } from "./permission-types.js";

export type EditMode = "review" | "auto" | "yolo" | "plan";

/** A composer "quick send" — a one-click action that sends a message to the
 *  model. `message` is the full text sent via user_input; `shorthand` is the
 *  short form shown in the chat when the message is long. */
export interface QuickSend {
  id: string;
  label: string;
  message: string;
  shorthand: string;
}

/** Maximum character length allowed for a quick send button shorthand. */
export const QUICK_SEND_SHORTHAND_MAX_LENGTH = 20;

/** Clamp and normalize shorthand text to ensure it fits comfortably in the composer button. */
export function enforceQuickSendShorthand(raw: string): string {
  return raw.trim().slice(0, QUICK_SEND_SHORTHAND_MAX_LENGTH);
}

/** Built-in quick sends — always available; the active one is selected in
 *  Settings → General and defaults to Proceed. */
export const BUILTIN_QUICK_SENDS: readonly QuickSend[] = [
  { id: "proceed", label: "Proceed", message: "proceed", shorthand: "proceed" },
  {
    id: "commit-and-push",
    label: "Commit and Push all changes",
    message: "commit and push all changes",
    shorthand: "commit and push",
  },
];

export function isQuickSend(v: unknown): v is QuickSend {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.id === "string" &&
    typeof q.label === "string" &&
    typeof q.message === "string" &&
    typeof q.shorthand === "string"
  );
}

/** Built-ins plus user-defined customs — the full set of selectable quick sends. */
export function allQuickSends(customs: readonly QuickSend[]): QuickSend[] {
  return [...BUILTIN_QUICK_SENDS, ...customs].map((q) => ({
    ...q,
    shorthand: enforceQuickSendShorthand(q.shorthand || q.label),
  }));
}

/** The active quick send by id, falling back to Proceed when unknown/absent. */
export function resolveActiveQuickSend(
  id: string | undefined,
  customs: readonly QuickSend[],
): QuickSend {
  const found = allQuickSends(customs).find((q) => q.id === id) ?? BUILTIN_QUICK_SENDS[0]!;
  return {
    ...found,
    shorthand: enforceQuickSendShorthand(found.shorthand || found.label),
  };
}

export type WebSearchEngineName =
  | "bing"
  | "bing-intl"
  | "searxng"
  | "metaso"
  | "baidu"
  | "tavily"
  | "perplexity"
  | "exa"
  | "brave"
  | "ollama"
  | "zai";

export type ExternalSessionSource = "claude" | "codex";

export interface OllamaGenerationSettings {
  temperature?: number;
  topP?: number;
  minP?: number;
  seed?: number;
  keepAlive: string;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topK?: number;
  repeatLastN?: number;
}

export type OllamaGenerationPatch = {
  [K in keyof OllamaGenerationSettings]?: OllamaGenerationSettings[K] | null;
};

export interface ExternalSessionApp {
  source: ExternalSessionSource;
  label: string;
  root: string;
  available: boolean;
  sessionCount: number;
  latestMtime?: string;
}

// ---- events ----

export type ConnectedEvent = { type: "$connected" };
export type ReadyEvent = { type: "$ready" };
export type ProtocolErrorEvent = { type: "$error"; message: string };
export type TurnCompleteEvent = { type: "$turn_complete" };

export type DesktopDiagnosticLevel = "debug" | "info" | "warn" | "error";

/** Structured daemon diagnostics delivered to the Tauri WebView console.
 *  Details must be redacted and must never contain credentials or message bodies. */
export interface DesktopDiagnosticEvent {
  type: "$diagnostic";
  ts: string;
  source: "daemon";
  level: DesktopDiagnosticLevel;
  event: string;
  message?: string;
  details?: Record<string, unknown>;
}

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
  /** YOLO auto-selection window (ms) — the card picks the first option at expiry. */
  countdownMs?: number;
}

export interface PlanRequiredEvent {
  type: "$plan_required";
  id: number;
  plan: string;
  steps?: unknown[];
  summary?: string;
  /** Stable submit_plan tool call that anchors live progress in the chat timeline. */
  callId?: string;
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

/** Authoritative tab list, emitted at the END of a `desktop_resync`. The
 *  frontend replaces its tab set with this snapshot — stale tabs left over
 *  from an older backend generation (id reuse across restarts) get pruned
 *  instead of living on as ghosts that route events to the wrong tab. */
export interface TabsSnapshotEvent {
  type: "$tabs_snapshot";
  tabs: { id: string; workspaceDir: string; active: boolean }[];
}

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
  | { kind: "image"; dataUrl: string; mimeType: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      result?: string;
      ok?: boolean;
    }
  | { kind: "warning"; id?: string; text: string; severity?: "low" | "high" };

export type LoadedMessage =
  | { kind: "user"; text: string; images?: string[] }
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
    /** Per-provider cumulative costs in each provider's native unit (USD for
     *  token-priced APIs, plan-window % for quota APIs). Never converted between
     *  providers. Keyed by provider id ("deepseek" | "openai" | "ollama" | "gemini"). */
    costByProvider?: Record<string, SessionProviderCost>;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalCompletionTokens: number;
  };
  /** Set on `desktop_resync` re-emits — the frontend must not let a resync
   *  echo clobber a live streaming transcript (same session, busy). */
  resync?: boolean;
}

/** Per-provider cumulative session usage in the provider's native unit. Mirrors
 *  src/telemetry/stats.ts SessionProviderCost — defined here so the frontend
 *  has a standalone wire shape (core-utils cannot import from src). */
export interface SessionProviderCost {
  kind: "usd" | "quota" | "none";
  /** Cumulative USD — only present when kind === "usd". */
  totalCostUsd?: number;
  /** Cumulative plan-window percentage points consumed — only when kind === "quota". */
  quotaUsedPct?: number;
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
  /** Active quick-send action id (default "proceed"). */
  quickSendId: string;
  /** User-defined quick sends (built-ins are code-defined). */
  quickSends: QuickSend[];
  budgetUsd: number | null;
  /** User-configured context-window cap (tokens); null = per-model default (300K). */
  contextTokens?: number | null;
  /** Effective per-turn iteration cap after config, environment, and default resolution. */
  maxIterPerTurn?: number | null;
  /** Explicit config override; null means environment/default resolution is active. */
  maxIterPerTurnOverride?: number | null;
  /** When true, all automatic compaction sources (turn-start folds, post-response folds, context guards) are disabled. Only manual compaction runs. */
  disableAutoCompaction?: boolean;
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  model: string;
  /** Ids with an explicit `models` provider mapping in config.json — offered
   *  by the model picker alongside the catalogs, since the user declared them. */
  customModels?: string[];
  /** Ollama chat endpoint (OpenAI-compatible) — shown in the Models settings page. */
  ollamaBaseUrl?: string;
  webSearchEngine?: WebSearchEngineName;
  webSearchEndpoint?: string;
  webSearchApiKeys?: {
    metaso?: string;
    tavily?: string;
    perplexity?: string;
    exa?: string;
    ollama?: string;
    brave?: string;
    zai?: string;
  };
  /** Per-tab subagent model — the default model used when a subagent skill has no explicit `model:` frontmatter override. Absent = deepseek-v4-flash. */
  subagentModel?: string;
  showSystemEvents?: boolean;
  /** Per-field visibility toggles for the bottom status row. Absent = all default to true. */
  statusBar?: {
    showBalance?: boolean;
    showSessionCost?: boolean;
    showTurnCost?: boolean;
    showCacheHit?: boolean;
    showCtxUsage?: boolean;
    showVersion?: boolean;
    showFeedbackHint?: boolean;
  };
  /** Effective native Ollama generation values after environment/config/default resolution. */
  ollamaGeneration?: OllamaGenerationSettings;
  /** Explicit persisted values, used to expose per-field reset actions. */
  ollamaGenerationOverrides?: OllamaGenerationPatch;
  /** Endpoint + auth state for the tab's current model — per tab, follows model switches. */
  modelEndpoint?: ModelEndpointInfo;
  /** Resolved endpoint for the tab's effective subagent model. */
  subagentModelEndpoint?: ModelEndpointInfo;
  /** OpenAI website-account OAuth state — never ships tokens, only the masked account. */
  openaiOAuth?: {
    signedIn: boolean;
    account?: string;
    /** Last OAuth flow failure (e.g. upstream invalid_client / timeout) — drives the status-bar auth chip until the next successful sign-in. */
    flowError?: string;
  };
  /** Google Antigravity OAuth state — powers gemini-* models on the Antigravity quota. */
  antigravityOAuth?: {
    signedIn: boolean;
    account?: string;
    /** Exact model ids returned by Antigravity for this account. */
    models?: string[];
    /** Last OAuth flow failure — drives the status-bar Gemini auth chip until the next successful sign-in. */
    flowError?: string;
  };
  /** Auto-approved shell command prefixes for the current project. */
  shellAllowed?: string[];
  /** Auto-approved outside-sandbox directory prefixes for the current project. */
  pathAllowed?: string[];
  version: string;
}

/** Endpoint + auth state for the tab's CURRENT model — the status bar's API
 *  chip is per tab and flips between DeepSeek, OpenAI, Ollama and Gemini with the model. */
export interface ModelEndpointInfo {
  provider: "deepseek" | "openai" | "ollama" | "gemini" | "zai";
  baseUrl: string;
  /** Auth source for OpenAI endpoints — absent for the DeepSeek provider. */
  openaiAuth?: "oauth" | "apiKey" | "none";
  /** Masked account email when signed in via OAuth. */
  oauthAccount?: string;
  /** Auth source for gemini endpoints (Antigravity quota). */
  antigravityAuth?: "oauth" | "none";
  /** Masked Google account email when signed in via Antigravity OAuth. */
  antigravityAccount?: string;
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

/** One quota window reported by the Codex app-server (account/rateLimits/read).
 *  Windows are identified by `windowMinutes`, never by position — OpenAI has
 *  changed which buckets appear for different plans (issue #32707). */
export interface CodexQuotaWindow {
  /** Window length in minutes — 300 = 5-hour, 10080 = weekly. */
  windowMinutes: number;
  /** Server-reported usage in this window (0-100+). */
  usedPercent: number;
  /** 100 - usedPercent — the statusbar's "% left". Computed once, daemon-side. */
  remainingPercent: number;
  /** ISO timestamp of the next reset, or null when the server didn't report one. */
  resetsAt: string | null;
}

/** ChatGPT-plan Codex quota (daemon source: src/codex-backend.ts, OAuth fetch
 *  of the official codex rate_limits endpoint — no codex CLI needed). `null`
 *  payload means "no data" — not signed in, rejected, or malformed — the UI
 *  degrades to no chip instead of a wrong number. */
export interface CodexQuota {
  /** Plan type from account/read (e.g. "plus", "pro"), or null. */
  plan: string | null;
  /** 5-hour window, when the plan reports one (some plans only report weekly). */
  fiveHour: CodexQuotaWindow | null;
  /** Weekly window — the primary ribbon value. */
  weekly: CodexQuotaWindow | null;
  /** Percentage points of the weekly window consumed since the previous fetch
   *  (fetches fire on every $turn_complete). Null until a second measurement
   *  exists. Pure API numbers, no cost conversion. */
  turnUsedPct?: number | null;
  fetchedAt: number;
}

export interface CodexQuotaEvent {
  type: "$codex_quota";
  quota: CodexQuota | null;
  /** Why quota is null (HTTP status, malformed payload, network error) —
   *  surfaced in the statusbar tooltip so a silent "—" is diagnosable. */
  reason?: string;
}

/** One Ollama cloud usage window (`GET {origin}/api/usage`). The API reports
 *  usage as a fraction of the plan's limit (session window resets every 5 h,
 *  weekly every 7 d) but never the absolute cap — the daemon scales the
 *  fraction to percent, mirroring how the Codex quota reports usedPercent. */
export interface OllamaQuotaWindow {
  /** API-reported usage in this window as a percentage of the plan's limit (usage × 100). */
  usagePct: number;
  /** 100 - usagePct — the statusbar's "% left". */
  remainingPct: number;
}

/** Cloud Ollama usage for the signed-in account (daemon source: `GET
 *  {origin}/api/usage` with the same Bearer key as chat). `null` payload means
 *  "no data" — no key, local daemon, or fetch failure — the UI degrades to a
 *  dash instead of a wrong number. */
export interface OllamaQuota {
  /** 5-hour session window (resets every 5 h). */
  session: OllamaQuotaWindow | null;
  /** 7-day weekly window (resets every 7 d). */
  weekly: OllamaQuotaWindow | null;
  /** Percentage points of the session window consumed since the previous
   *  fetch (fetches fire on every $turn_complete). Null until a second
   *  measurement exists. */
  turnUsedPct?: number | null;
  fetchedAt: number;
}

export interface OllamaQuotaEvent {
  type: "$ollama_quota";
  quota: OllamaQuota | null;
  /** Why quota is null — surfaced in the statusbar tooltip. */
  reason?: string;
}

/** The account's Google Antigravity (Gemini Code Assist) plan, from
 *  loadCodeAssist.currentTier. */
export interface AntigravityPlan {
  tierId: string;
  name: string;
  upgradeText?: string;
  upgradeType?: string;
  upgradeUri?: string;
}

/** One per-model quota window from retrieveUserQuota.buckets. */
export interface AntigravityQuotaWindow {
  modelId: string;
  /** Fraction of the window already consumed, 0..1. */
  usedFraction: number;
  /** ISO timestamp when the window resets; absent when not a limited bucket. */
  resetTime?: string;
}

/** Google Antigravity usage for the signed-in account (daemon source: the
 *  undocumented Code Assist `v1internal` API — loadCodeAssist for the plan,
 *  retrieveUserQuota for per-model windows). `null` payload means "no data" —
 *  not signed in or fetch failure — the UI degrades to no chip. */
export interface AntigravityQuota {
  plan: AntigravityPlan | null;
  /** Per-model usage windows (already vertex-deduped, daemon-side). */
  windows: AntigravityQuotaWindow[];
  /** Percentage points of the active model's window consumed since the previous
   *  fetch (fetches fire on every $turn_complete). Null until a second
   *  measurement exists. */
  turnUsedPct?: number | null;
  fetchedAt: number;
}

export interface AntigravityQuotaEvent {
  type: "$antigravity_quota";
  quota: AntigravityQuota | null;
  /** Why quota is null — surfaced in the statusbar tooltip. */
  reason?: string;
}

/** Dynamically fetched model list for the Ollama provider — driven by the
 *  picker's "Ollama" section so the hundreds of available models don't need
 *  hardcoding. `error` replaces the list when the endpoint is unreachable,
 *  auth was rejected, or the payload was malformed. */
export interface OllamaModelsEvent {
  type: "$ollama_models";
  /** Raw model ids the endpoint reported (e.g. `llama3.1:latest`). */
  models: string[];
  /** Subset of `models` confirmed vision-capable (multimodal) — the UI uses
   *  this to enable image upload for those models. Absent when none detected
   *  or the catalog couldn't be probed. */
  visionModels?: string[];
  /** The account's Ollama plan (`free`, `pro`, ...) when resolvable via the
   *  cloud `/api/me` endpoint — lets the picker explain filtering. */
  plan?: string;
  /** Models hidden because the account's plan doesn't cover them (only set
   *  when the endpoint is subscription-gated and the probe detected some). */
  hiddenCount?: number;
  error?: string;
}

// ---- commands ----

export interface SettingsPatch {
  reasoningEffort?: ReasoningEffort;
  editMode?: EditMode;
  quickSendId?: string;
  quickSends?: QuickSend[];
  budgetUsd?: number | null;
  /** Context-window cap in tokens, clamped to [128000, 1000000]; null/undefined = per-model default. */
  contextTokens?: number | null;
  /** Per-turn iteration cap, clamped to [50, 100]; null/undefined = default (50). */
  maxIterPerTurn?: number | null;
  /** Disable automatic compaction from all sources except the manual button. */
  disableAutoCompaction?: boolean;
  baseUrl?: string;
  workspaceDir?: string;
  model?: string;
  /** Per-tab subagent model — default for subagent skills without an explicit `model:` frontmatter. */
  subagentModel?: string;
  /** Ollama chat endpoint override (OpenAI-compatible). null = back to the local default. */
  ollamaBaseUrl?: string | null;
  /** Native Ollama generation options. Null fields clear their persisted override. */
  ollamaGeneration?: OllamaGenerationPatch;
  webSearchEngine?: WebSearchEngineName;
  webSearchEndpoint?: string | null;
  metasoApiKey?: string | null;
  baiduApiKey?: string | null;
  tavilyApiKey?: string | null;
  perplexityApiKey?: string | null;
  exaApiKey?: string | null;
  ollamaApiKey?: string | null;
  braveApiKey?: string | null;
  zaiApiKey?: string | null;
  showSystemEvents?: boolean;
}

/** An image to attach to a user message. Clipboard paste flows ship the
 *  bytes the UI already encoded; drag-and-drop ships a path the daemon reads
 *  (the webview has no fs access for arbitrary OS paths). */
export type UserImageAttachment =
  | { source: "clipboard"; dataUrl: string }
  | { source: "file"; path: string };

export type OutgoingCommand = { tabId?: string } & (
  | { cmd: "user_input"; text: string; images?: UserImageAttachment[] }
  | { cmd: "abort" }
  | { cmd: "cancel_tool" }
  | {
      cmd: "confirm_response";
      id: number;
      response: import("./permission-types.js").ConfirmationChoice;
    }
  | { cmd: "choice_response"; id: number; response: import("./permission-types.js").ChoiceVerdict }
  | { cmd: "plan_response"; id: number; response: import("./permission-types.js").PlanVerdict }
  | {
      cmd: "checkpoint_response";
      id: number;
      response: import("./permission-types.js").CheckpointVerdict;
    }
  | {
      cmd: "revision_response";
      id: number;
      response: import("./permission-types.js").RevisionVerdict;
    }
  | { cmd: "session_list" }
  | { cmd: "desktop_resync" }
  | { cmd: "session_delete"; name: string }
  | { cmd: "session_clear" }
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
  | { cmd: "setup_save_openai_key"; key: string }
  | { cmd: "oauth_begin" }
  | { cmd: "oauth_cancel" }
  | { cmd: "oauth_signout" }
  | { cmd: "gemini_oauth_begin" }
  | { cmd: "gemini_oauth_cancel" }
  | { cmd: "gemini_oauth_signout" }
  | { cmd: "antigravity_models_refresh" }
  | { cmd: "settings_get" }
  | ({ cmd: "settings_save" } & SettingsPatch)
  | { cmd: "codex_quota_get" }
  | { cmd: "ollama_quota_get" }
  | { cmd: "antigravity_quota_get" }
  | { cmd: "ollama_models_list"; force?: boolean }
  | { cmd: "mention_query"; query: string; nonce: number }
  | { cmd: "mention_preview"; path: string; nonce: number }
  | { cmd: "mention_picked"; path: string }
  | { cmd: "tab_open"; workspaceDir?: string }
  | { cmd: "tab_close" }
  | { cmd: "tab_activate"; tabId: string }
  | { cmd: "workspace_recent_remove"; path: string }
  | { cmd: "mcp_specs_get" }
  | { cmd: "mcp_specs_add"; spec: string }
  | { cmd: "mcp_specs_remove"; spec: string }
  | { cmd: "rule_add"; ruleType: "shell" | "path"; pattern: string }
  | { cmd: "rule_remove"; ruleType: "shell" | "path"; pattern: string }
  | { cmd: "skills_get" }
  | { cmd: "skill_run"; name: string; args?: string }
  | { cmd: "jobs_list" }
  | { cmd: "jobs_stop"; jobId: number }
  | { cmd: "jobs_stop_all" }
  | { cmd: "compact_history" }
  | { cmd: "retry" }
  | { cmd: "btw"; text: string }
);
