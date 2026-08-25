import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stdin } from "node:process";
import { createInterface } from "node:readline";
import {
  MAX_IMAGE_BYTES,
  flattenText,
  messageOf,
  redactDiagnosticText,
  redactDiagnosticValue,
  scanImageMentions,
  stripMentionTokens,
  toApprovalPrompt,
} from "@reasonix/core-utils";
import type {
  BalanceEvent,
  BtwResultEvent,
  CheckpointRequiredEvent,
  ChoiceRequiredEvent,
  CodexQuotaEvent,
  ConfirmRequiredEvent,
  CtxBreakdownEvent,
  DesktopDiagnosticEvent,
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  McpSpecInfo,
  McpSpecStatus,
  McpSpecsEvent,
  MemoryDetailEvent,
  MemoryEvent,
  MemoryExportEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  ModelEndpointInfo,
  NeedsSetupEvent,
  OllamaModelsEvent,
  OllamaQuotaEvent,
  PathAccessRequiredEvent,
  PlanClearedEvent,
  PlanRequiredEvent,
  PlanStep,
  RetryResultEvent,
  RevisionRequiredEvent,
  SessionCompactedEvent,
  SessionEmptyEvent,
  SessionImportResultEvent,
  SessionImportSourcesEvent,
  SessionLoadedEvent,
  SessionsEvent,
  SettingsEvent,
  SkillsEvent,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TabsSnapshotEvent,
  UserImageAttachment,
} from "@reasonix/core-utils";
import {
  type FileWithStats,
  listDirectory,
  listFilesWithStatsAsync,
  parseAtQuery,
  rankPickerCandidates,
} from "../../at-mentions.js";
import { pickPrimaryBalance } from "../../client.js";
import { codeSystemPrompt } from "../../code/prompt.js";
import { applyPlanMode, buildCodeToolset } from "../../code/setup.js";
import { fetchCodexQuotaViaOAuth, resolveCodexTransport } from "../../codex-backend.js";
import {
  DEFAULT_GEMINI_CHAT_URL,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_CHAT_URL,
  anyProviderConfigured,
  bridgeEndpointEnv,
  defaultConfigPath,
  deriveNativeOllamaOrigin,
  isOpenAIStandardEndpoint,
  isPlausibleKey,
  isReasoningEffort,
  loadApiKey,
  loadBraveApiKey,
  loadContextTokens,
  loadDesktopOpenTabs,
  loadEditMode,
  loadEditor,
  loadEndpoint,
  loadEndpointForModel,
  loadExaApiKey,
  loadMaxIterPerTurn,
  loadMaxOutputTokens,
  loadMetasoApiKey,
  loadModel,
  loadOllamaApiKey,
  loadOllamaEndpoint,
  loadPerplexityApiKey,
  loadReasoningEffort,
  loadRecentWorkspaces,
  loadResolvedSkillPaths,
  loadShowSystemEvents,
  loadSubagentModels,
  loadTavilyApiKey,
  loadWorkspaceDir,
  modelAcceptsImages,
  providerForModel,
  pushRecentWorkspace,
  readConfig,
  webSearchEngine as readWebSearchEngine,
  saveAntigravityOAuth,
  saveApiKey,
  saveBaseUrl,
  saveContextTokens,
  saveDesktopOpenTabs,
  saveEditMode,
  saveEditor,
  saveModel,
  saveOpenAIApiKey,
  saveOpenAIOAuth,
  saveReasoningEffort,
  saveShowSystemEvents,
  saveSubagentModels,
  saveWorkspaceDir,
  writeConfig,
} from "../../config.js";
import { redactEventValue } from "../../core/event-redaction.js";
import { Eventizer } from "../../core/eventize.js";
import { EventType } from "../../core/events.js";
import type { Event as KernelEvent, SubagentProgressEvent } from "../../core/events.js";
import { pauseGate } from "../../core/pause-gate.js";
import { autoResolveVerdict } from "../../core/pause-policy.js";
import { augmentProcessPath } from "../../desktop/login-shell-path.js";
import {
  collectMemoryEntriesForWorkspace,
  deleteMemoryEntry,
  exportMemories,
  importMemories,
  readMemoryEntryDetail,
  writeMemoryEntry,
} from "../../desktop/memory-browser.js";
import { normalizeImageToDataUrl } from "../../image-format.js";

import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  antigravityAccount,
  beginAntigravityOAuthFlow,
  fetchAntigravityModels,
  onboardAntigravity,
  resolveAntigravityToken,
  signOutAntigravity,
} from "../../antigravity-oauth.js";
import { loadDotenv } from "../../env.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  type LoopAbortOptions,
  type LoopEvent,
} from "../../index.js";
import { createLogger } from "../../logging.js";
import { parseMcpSpec } from "../../mcp/spec.js";
import {
  type ModelPrefs,
  type SessionMeta,
  deleteSession,
  listSessionsForWorkspace,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  patchSessionWorkspaceIfMissing,
  resolveSessionModelPrefs,
  sessionPath,
  timestampSuffix,
} from "../../memory/session.js";
import {
  type OAuthFlow,
  beginOAuthFlow,
  oauthAccount,
  resolveOpenAIToken,
  signOutOpenAI,
} from "../../oauth.js";
import {
  contextTokensForModel,
  loadOllamaVerdicts,
  ollamaVerdictsPath,
  partitionByVerdicts,
  saveOllamaVerdicts,
  scopeKeyFor,
  setVerdict,
  showPayloadContextLength,
  verdictFor,
  visionModelsFor,
} from "../../ollama-model-map.js";
import { registerSeeImageTool } from "../../tools/see-image.js";
import type { SubagentEvent } from "../../tools/subagent.js";

import {
  discoverExternalSessionApps,
  importExternalSession,
  importExternalSessions,
} from "../../session-import.js";
import { SkillStore } from "../../skills.js";
import { resolveContextTokens } from "../../telemetry/stats.js";
import { countTokensBounded } from "../../tokenizer.js";
import type { ChoiceOption } from "../../tools/choice.js";
import type { ChatMessage, TurnImage } from "../../types.js";
import { VERSION } from "../../version.js";
import { type McpRuntime, createMcpRuntime } from "./mcp-runtime.js";

export interface DesktopOptions {
  model: string;
  budgetUsd?: number;
  /** Root directory the agent's filesystem tools operate inside. Defaults to cwd. */
  dir?: string;
}

export function desktopUserAbortLoopOptions(): LoopAbortOptions | undefined {
  // User-facing Abort stops generation; it must not erase a prompt that remains visible in chat.
  return undefined;
}

/** Race the generator's next event against the aborter — resolves `null` on
 * abort even while the loop is suspended (the fold is non-interruptible).
 * Exported for tests. */
export function raceLoopStep(
  gen: AsyncGenerator<LoopEvent>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<LoopEvent> | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    gen.next().then(
      (r) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

type InMessage = import("@reasonix/core-utils").OutgoingCommand;

/** Direct fd write — bypasses Node's stream layer (and its piped-output
 *  block buffering) so every JSON line reaches Rust the moment it's
 *  produced, not whenever the next 8 KB flushes. */
type EmittableEvent =
  | KernelEvent
  | SessionCompactedEvent
  | { type: "$ready" }
  | { type: "$error"; message: string }
  | { type: "$turn_complete" }
  | DesktopDiagnosticEvent
  | { type: "oauth_begin_result"; url: string }
  | { type: "gemini_oauth_begin_result"; url: string }
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | SessionsEvent
  | SessionImportSourcesEvent
  | SessionImportResultEvent
  | SessionLoadedEvent
  | SessionEmptyEvent
  | NeedsSetupEvent
  | SettingsEvent
  | BalanceEvent
  | CodexQuotaEvent
  | OllamaQuotaEvent
  | OllamaModelsEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | RetryResultEvent
  | BtwResultEvent
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
  | JobsEvent;

const STDOUT_BACKPRESSURE_WAIT = new Int32Array(new SharedArrayBuffer(4));

type SyncWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number;

const SESSION_TITLE_MAX_CHARS = 200;

/** Trim + cap a user-provided session title; empty string means "clear summary". Exported for tests. */
export function normalizeSessionTitle(raw: string): string {
  return flattenText(raw).slice(0, SESSION_TITLE_MAX_CHARS);
}

/** Drain `buffer` to `fd` across partial writes; retry EAGAIN after a 5 ms park. Exported for tests. */
export function writeAllSync(
  fd: number,
  buffer: Buffer,
  opts: {
    write?: SyncWriter;
    wait?: () => void;
  } = {},
): void {
  const write = opts.write ?? writeSync;
  const wait = opts.wait ?? (() => Atomics.wait(STDOUT_BACKPRESSURE_WAIT, 0, 0, 5));
  let offset = 0;
  while (offset < buffer.length) {
    let written: number;
    try {
      written = write(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        wait();
        continue;
      }
      throw err;
    }
    if (written <= 0) throw new Error("stdout write returned 0 bytes");
    offset += written;
  }
}

function writeEvent(ev: EmittableEvent, tabId?: string): void {
  const payload = tabId ? { ...ev, tabId } : ev;
  writeAllSync(1, Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
}

export function redactDesktopDiagnosticMessage(raw: string, max = 2000): string {
  return redactDiagnosticText(raw, max);
}

type SubagentProgressPayload = Omit<SubagentProgressEvent, "id" | "ts" | "turn" | "type">;

/** Allowlisted projection for the desktop wire. Assistant text, reasoning deltas, and tool results are omitted. */
export function projectSubagentEvent(ev: SubagentEvent): SubagentProgressPayload | null {
  const base = {
    runId: ev.runId,
    ...(ev.parentCallId ? { parentCallId: ev.parentCallId } : {}),
    task: redactDesktopDiagnosticMessage(ev.task, 120),
    ...(ev.skillName ? { skillName: redactDesktopDiagnosticMessage(ev.skillName, 80) } : {}),
    ...(ev.model ? { model: redactDesktopDiagnosticMessage(ev.model, 80) } : {}),
    ...(ev.iter !== undefined ? { iter: ev.iter } : {}),
    ...(ev.elapsedMs !== undefined ? { elapsedMs: ev.elapsedMs } : {}),
    ...(ev.maxToolIters !== undefined ? { maxToolIters: ev.maxToolIters } : {}),
    ...(ev.maxElapsedMs !== undefined ? { maxElapsedMs: ev.maxElapsedMs } : {}),
    ...(ev.budgetExhausted ? { budgetExhausted: ev.budgetExhausted } : {}),
  };
  switch (ev.kind) {
    case "start":
      return { ...base, action: "start", phase: "exploring" };
    case "progress":
      return { ...base, action: "phase", phase: "exploring" };
    case "phase":
      return { ...base, action: "phase", ...(ev.phase ? { phase: ev.phase } : {}) };
    case "stream-progress":
      return {
        ...base,
        action: "stream",
        outputChars: ev.outputChars ?? 0,
        reasoningChars: ev.reasoningChars ?? 0,
        toolReadChars: ev.toolReadChars ?? 0,
      };
    case "end":
      return {
        ...base,
        action: "end",
        ...(ev.error ? { error: redactDesktopDiagnosticMessage(ev.error, 500) } : {}),
        ...(ev.turns !== undefined ? { turns: ev.turns } : {}),
        ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
      };
    case "inner": {
      const inner = ev.inner;
      if (!inner || (inner.role !== "tool_start" && inner.role !== "tool")) return null;
      return {
        ...base,
        action: inner.role === "tool_start" ? "tool-start" : "tool-end",
        ...(inner.callId ? { childCallId: inner.callId } : {}),
        ...(inner.toolName
          ? { toolName: redactDesktopDiagnosticMessage(inner.toolName, 100) }
          : {}),
        ...(inner.role === "tool_start" && inner.toolArgs
          ? { toolArgs: sanitizeSubagentToolArgs(inner.toolArgs) }
          : {}),
        ...(inner.role === "tool"
          ? { toolOk: !/^\s*(?:error\b|\{\s*"error")/i.test(inner.content) }
          : {}),
      };
    }
  }
}

function sanitizeSubagentToolArgs(raw: string): string {
  const clipped = redactDesktopDiagnosticMessage(raw, 2000);
  try {
    return JSON.stringify(redactEventValue(JSON.parse(clipped)));
  } catch {
    return clipped;
  }
}

function diagnosticErrorMessage(err: unknown): string {
  return redactDesktopDiagnosticMessage(messageOf(err));
}

export function buildDesktopDiagnostic(
  event: string,
  details?: Record<string, unknown>,
  opts: { tabId?: string; level?: DesktopDiagnosticEvent["level"]; message?: string } = {},
): DesktopDiagnosticEvent {
  return {
    type: "$diagnostic",
    ts: new Date().toISOString(),
    source: "daemon",
    level: opts.level ?? "debug",
    event,
    ...(opts.message ? { message: diagnosticErrorMessage(opts.message) } : {}),
    ...(details ? { details: redactDiagnosticValue(details) as Record<string, unknown> } : {}),
  };
}

function emitDiagnostic(
  event: string,
  details?: Record<string, unknown>,
  opts: { tabId?: string; level?: DesktopDiagnosticEvent["level"]; message?: string } = {},
): void {
  writeEvent(buildDesktopDiagnostic(event, details, opts), opts.tabId);
}

function emitDiagnosticError(
  event: string,
  err: unknown,
  opts: { tabId?: string; details?: Record<string, unknown> } = {},
): void {
  emitDiagnostic(event, opts.details, {
    tabId: opts.tabId,
    level: "error",
    message: diagnosticErrorMessage(err),
  });
}

function wireEventDetails(ev: EmittableEvent): Record<string, unknown> {
  switch (ev.type) {
    case "$error":
      return { messageLength: ev.message.length };
    case "error":
      return { turn: ev.turn, recoverable: ev.recoverable, messageLength: ev.message.length };
    case "warning":
      return { turn: ev.turn, severity: ev.severity, textLength: ev.text.length };
    case "model.turn.started":
      return { turn: ev.turn, model: ev.model, reasoningEffort: ev.reasoningEffort };
    case "model.delta":
      return { turn: ev.turn, channel: ev.channel, chars: ev.text.length };
    case "model.final":
      return {
        turn: ev.turn,
        contentChars: ev.content.length,
        reasoningChars: ev.reasoningContent?.length ?? 0,
        toolCalls: ev.toolCalls.length,
        usage: ev.usage,
        costUsd: ev.costUsd,
      };
    case "tool.preparing":
      return { turn: ev.turn, callId: ev.callId, name: ev.name };
    case "tool.intent":
      return { turn: ev.turn, callId: ev.callId, name: ev.name, argsChars: ev.args.length };
    case "tool.result":
      return { turn: ev.turn, callId: ev.callId, ok: ev.ok, outputChars: ev.output.length };
    case "subagent.progress":
      return {
        turn: ev.turn,
        runId: ev.runId,
        action: ev.action,
        toolName: ev.toolName ?? null,
        iter: ev.iter ?? null,
      };
    case "$session_loaded":
      return {
        name: ev.name,
        messages: ev.messages.length,
        carryover: ev.carryover,
        resync: ev.resync ?? false,
      };
    case "$sessions":
      return { sessions: ev.items.length };
    case "$ctx_breakdown":
      return {
        reservedTokens: ev.reservedTokens,
        logTokens: ev.logTokens ?? null,
        ctxMax: ev.ctxMax ?? null,
      };
    case "$codex_quota":
      return {
        hasQuota: ev.quota !== null,
        reason: ev.reason ?? null,
        weekly: ev.quota?.weekly ?? null,
        fiveHour: ev.quota?.fiveHour ?? null,
        turnUsedPct: ev.quota?.turnUsedPct ?? null,
      };
    case "$ollama_quota":
      return {
        hasQuota: ev.quota !== null,
        reason: ev.reason ?? null,
        session: ev.quota?.session ?? null,
        weekly: ev.quota?.weekly ?? null,
        turnUsedPct: ev.quota?.turnUsedPct ?? null,
      };
    case "$balance":
      return {
        currency: ev.currency,
        isAvailable: ev.isAvailable,
        currencies: ev.balanceInfos.length,
      };
    case "$tab_opened":
      return { workspaceDirChars: ev.workspaceDir.length, active: ev.active ?? false };
    case "$tabs_snapshot":
      return { tabs: ev.tabs.length };
    case "$turn_complete":
      return {};
    default:
      return {};
  }
}

function emit(ev: EmittableEvent, tabId?: string): void {
  writeEvent(ev, tabId);
  // Model deltas are streamed at token/chunk frequency. They are already
  // observable in the WebView transcript; duplicating every chunk as a
  // diagnostic doubles synchronous stdout writes and can starve the loop.
  if (ev.type === "$diagnostic" || ev.type === "model.delta") return;
  emitDiagnostic(
    "wire.emit",
    { eventType: ev.type, ...wireEventDetails(ev) },
    {
      tabId,
      level: ev.type === "$error" || ev.type === "error" ? "error" : "debug",
      ...(ev.type === "$error" || ev.type === "error" ? { message: ev.message } : {}),
    },
  );
}

/** Emit a kernel event to a tab; session.compacted's replacement payload is
 *  converted from the kernel ChatMessage shape into the LoadedMessage wire
 *  shape so the App reducer can swap in the post-fold conversation. */
function emitKernelEvent(kev: KernelEvent, tabId?: string): void {
  if (kev.type === "session.compacted") {
    const wire: SessionCompactedEvent = {
      type: EventType.sessionCompacted,
      id: kev.id,
      ts: kev.ts,
      turn: kev.turn,
      beforeMessages: kev.beforeMessages,
      afterMessages: kev.afterMessages,
      reason: kev.reason,
      replacementMessages: buildLoadedMessages([...kev.replacementMessages]),
    };
    emit(wire, tabId);
    return;
  }
  emit(kev, tabId);
}

function tailLines(s: string, n: number): string {
  if (!s) return "";
  const lines = s.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

const LOADED_RECENT_MESSAGE_WINDOW = 200;
const LOADED_MIN_ELIDE_CHARS = 4096;
const LOADED_ELIDED_PREFIX = "[elided — older than the last ";

function elideLoadedField(value: string): string {
  if (value.length <= LOADED_MIN_ELIDE_CHARS) return value;
  if (value.startsWith(LOADED_ELIDED_PREFIX)) return value;
  return `${LOADED_ELIDED_PREFIX}${LOADED_RECENT_MESSAGE_WINDOW} messages; ${value.length.toLocaleString()} chars dropped to save memory. Full content is on disk in the session log.]`;
}

function elideLoadedMessages(messages: LoadedMessage[]): LoadedMessage[] {
  if (messages.length < LOADED_RECENT_MESSAGE_WINDOW) return messages;
  const cutoff = messages.length - LOADED_RECENT_MESSAGE_WINDOW;
  return messages.map((msg, i) => {
    if (i >= cutoff || msg.kind !== "assistant") return msg;
    return {
      ...msg,
      segments: msg.segments.map((segment) => {
        switch (segment.kind) {
          case "reasoning":
          case "text":
            return { ...segment, text: elideLoadedField(segment.text) };
          case "tool":
            return {
              ...segment,
              args: elideLoadedField(segment.args),
              ...(segment.result !== undefined ? { result: elideLoadedField(segment.result) } : {}),
            };
          default:
            return segment;
        }
      }),
    };
  });
}

/** Clipboard data URLs pass through; dropped files are read, sniffed and re-encoded. */
async function resolveUserImages(
  attachments: ReadonlyArray<UserImageAttachment>,
): Promise<TurnImage[]> {
  const out: TurnImage[] = [];
  for (const att of attachments) {
    if (att.source === "clipboard") {
      if (!att.dataUrl.startsWith("data:image/")) {
        throw new Error("clipboard payload is not a data:image URL");
      }
      // Normalize the same as dropped files: sniff the real bytes so an
      // animated WebP paste (or a mismatched MIME) is caught here with a clear
      // error instead of reaching the vision API and 400ing.
      const comma = att.dataUrl.indexOf(",");
      const b64 = comma >= 0 ? att.dataUrl.slice(comma + 1) : "";
      const normalized = await normalizeImageToDataUrl(Buffer.from(b64, "base64"));
      if (!normalized.ok) throw new Error(normalized.message);
      out.push({ url: normalized.dataUrl });
      continue;
    }
    const stat = statSync(att.path);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
      );
    }
    const normalized = await normalizeImageToDataUrl(await readFile(att.path));
    if (!normalized.ok) {
      throw new Error(normalized.message);
    }
    // Keep the source path so the agent can open/modify the actual file, not
    // just see the pixels.
    out.push({ url: normalized.dataUrl, path: att.path });
  }
  return out;
}

/** OpenAI-only: `@path` mentions that resolve to an existing supported image
 *  become vision attachments (the token is stripped from the text). Non-image
 *  or missing mentions stay in the text for the model to reach via tools. */
export async function extractImageMentions(
  text: string,
  rootDir: string,
): Promise<{ text: string; attachments: UserImageAttachment[] }> {
  const mentions = scanImageMentions(text, (p) => (isAbsolute(p) ? p : join(rootDir, p)));
  // Existence is a daemon-only check — the webview has no fs access. Mentions
  // whose files are missing keep their token so the model can investigate.
  const existing = mentions.filter((m) => existsSync(m.path) && statSync(m.path).isFile());
  return {
    text: stripMentionTokens(text, existing),
    attachments: existing.map((m) => ({ source: "file" as const, path: m.path })),
  };
}

/** User records carry plain text for text-only turns and OpenAI content parts
 *  when images are attached — extract the text and image data URLs for the
 *  LoadedMessage wire shape. */
function userLoadedMessage(content: ChatMessage["content"]): {
  kind: "user";
  text: string;
  images?: string[];
} {
  if (typeof content === "string" || content === undefined || content === null) {
    return { kind: "user", text: content ?? "" };
  }
  const textParts: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text.length > 0) {
      textParts.push(part.text);
    } else if (part.type === "image_url") {
      images.push(part.image_url.url);
    }
  }
  return { kind: "user", text: textParts.join("\n"), images: images.length ? images : undefined };
}

export function buildLoadedMessages(records: ChatMessage[]): LoadedMessage[] {
  const out: LoadedMessage[] = [];
  let turn = 0;
  let pendingAssistantIdx = -1;
  for (const rec of records) {
    if (rec.role === "system") continue;
    if (rec.role === "user") {
      out.push(userLoadedMessage(rec.content));
      pendingAssistantIdx = -1;
      continue;
    }
    if (rec.role === "assistant") {
      turn++;
      const segments: LoadedSegment[] = [];
      if (rec.reasoning_content) segments.push({ kind: "reasoning", text: rec.reasoning_content });
      if (typeof rec.content === "string" && rec.content)
        segments.push({ kind: "text", text: rec.content });
      if (rec.tool_calls) {
        for (let i = 0; i < rec.tool_calls.length; i++) {
          const tc = rec.tool_calls[i];
          if (!tc) continue;
          segments.push({
            kind: "tool",
            callId: tc.id ?? `tc-r-${turn}-${i}`,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
        }
      }
      out.push({ kind: "assistant", turn, segments, pending: false });
      pendingAssistantIdx = out.length - 1;
      continue;
    }
    if (rec.role === "tool") {
      if (pendingAssistantIdx < 0) continue;
      const host = out[pendingAssistantIdx];
      if (host?.kind !== "assistant") continue;
      const callId = rec.tool_call_id;
      if (!callId) continue;
      const seg = host.segments.find((s) => s.kind === "tool" && s.callId === callId);
      if (seg && seg.kind === "tool") {
        seg.result = typeof rec.content === "string" ? rec.content : "";
        seg.ok = !/error|failed/i.test(seg.result.slice(0, 200));
      }
    }
  }
  return elideLoadedMessages(out);
}

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 7) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-3)}`;
}

function collectWebSearchApiKeyPrefixes(): {
  metaso?: string;
  tavily?: string;
  perplexity?: string;
  exa?: string;
  ollama?: string;
  brave?: string;
} {
  return {
    metaso: maskApiKey(loadMetasoApiKey()),
    tavily: maskApiKey(loadTavilyApiKey()),
    perplexity: maskApiKey(loadPerplexityApiKey()),
    exa: maskApiKey(loadExaApiKey()),
    ollama: maskApiKey(loadOllamaApiKey()),
    brave: maskApiKey(loadBraveApiKey()),
  };
}

let oauthGen = 0;
let pendingOAuth: OAuthFlow | null = null;
/** Last OAuth flow failure message — surfaced in the status bar's OpenAI auth
 *  chip until the next successful sign-in clears it. */
let lastOAuthError: string | null = null;

let antigravityOAuthGen = 0;
let pendingAntigravityOAuth: OAuthFlow | null = null;
/** Last Antigravity OAuth flow failure — surfaced in the status bar's Gemini
 *  auth chip until the next successful sign-in clears it. */
let lastAntigravityOAuthError: string | null = null;

/** Resolve the Google OAuth token and managed Code Assist project for Gemini requests.
 *  The first request completes eligibility/onboarding and persists the account catalog. */
async function resolveGeminiAuth(): Promise<{ accessToken: string; projectId: string } | null> {
  const accessToken = await resolveAntigravityToken(defaultConfigPath());
  if (!accessToken) return null;
  const creds = readConfig().antigravityOAuth;
  let projectId = creds?.projectId;
  if (!projectId) {
    projectId = await onboardAntigravity(accessToken);
  }
  if (creds && (!creds.projectId || !creds.models?.length)) {
    const models = (await fetchAntigravityModels(accessToken, projectId)).map(({ id }) => id);
    saveAntigravityOAuth({ ...creds, projectId, models });
  }
  return { accessToken, projectId };
}

async function refreshAntigravityModels(tab: Tab): Promise<void> {
  try {
    const auth = await resolveGeminiAuth();
    if (!auth) throw new Error("Sign in to Google Antigravity before refreshing models");
    const creds = readConfig().antigravityOAuth;
    if (!creds) throw new Error("Antigravity credentials disappeared during model refresh");
    const models = (await fetchAntigravityModels(auth.accessToken, auth.projectId)).map(
      ({ id }) => id,
    );
    saveAntigravityOAuth({ ...creds, projectId: auth.projectId, models });
    lastAntigravityOAuthError = null;
    emitSettings(tab);
  } catch (err) {
    const message = `Antigravity model refresh failed: ${(err as Error).message}`;
    lastAntigravityOAuthError = message;
    emit({ type: "$error", message }, tab.id);
    emitSettings(tab);
  }
}

/** Endpoint + auth state for a model id — drives the status bar's API chip.
 *  DeepSeek models report the DeepSeek endpoint; gpt-* models the OpenAI one
 *  plus auth source (OAuth sign-in > static key > none). Exported for tests. */
export function modelEndpointFor(model: string, path?: string): ModelEndpointInfo {
  if (providerForModel(model) === "ollama") {
    const oep = loadOllamaEndpoint(path);
    return {
      provider: "ollama",
      baseUrl: oep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL,
    };
  }
  if (providerForModel(model) === "gemini") {
    const oep = loadEndpointForModel(model, path);
    const oauth = readConfig(path).antigravityOAuth;
    return {
      provider: "gemini",
      baseUrl: oep.baseUrl ?? DEFAULT_GEMINI_CHAT_URL,
      antigravityAuth: oauth?.accessToken ? "oauth" : "none",
      antigravityAccount: oauth?.account,
    };
  }
  if (providerForModel(model) !== "openai") {
    return {
      provider: "deepseek",
      // Mirrors the client's default (src/client.ts) when nothing is configured.
      baseUrl: loadEndpoint(path).baseUrl ?? "https://api.deepseek.com",
    };
  }
  const oep = loadEndpointForModel(model, path);
  const oauth = readConfig(path).openaiOAuth;
  return {
    provider: "openai",
    baseUrl: oep.baseUrl ?? "https://api.openai.com/v1",
    openaiAuth: oauth?.accessToken ? "oauth" : oep.apiKey ? "apiKey" : "none",
    oauthAccount: oauth?.account,
  };
}

function emitSettings(tab: Tab): void {
  const oauth = readConfig().openaiOAuth;
  const antigravityOAuth = readConfig().antigravityOAuth;
  const ep = loadEndpoint();
  const editMode = loadEditMode();
  if (tab.toolset) applyPlanMode(tab.toolset.tools, editMode);
  const recent = loadRecentWorkspaces().filter((p) => p !== tab.rootDir);
  emit(
    {
      type: "$settings",
      reasoningEffort: tab.currentReasoningEffort,
      editMode,
      budgetUsd: tab.runtime?.loop.budgetUsd ?? null,
      contextTokens: tab.ctxMaxOverride ?? null,
      baseUrl: ep.baseUrl,
      apiKeyPrefix: ep.apiKey ? `${ep.apiKey.slice(0, 6)}…${ep.apiKey.slice(-3)}` : undefined,
      workspaceDir: tab.rootDir,
      recentWorkspaces: recent,
      model: tab.currentModel,
      ollamaBaseUrl: readConfig().ollamaBaseUrl,
      editor: loadEditor(),
      webSearchEngine: readWebSearchEngine(),
      webSearchEndpoint: readConfig().webSearchEndpoint,
      webSearchApiKeys: collectWebSearchApiKeyPrefixes(),
      subagentModels: loadSubagentModels(),
      showSystemEvents: loadShowSystemEvents(),
      statusBar: readConfig().statusBar,
      modelEndpoint: modelEndpointFor(tab.currentModel),
      openaiOAuth: {
        signedIn: !!oauth?.accessToken,
        account: oauth?.account,
        flowError: lastOAuthError ?? undefined,
      },
      antigravityOAuth: {
        signedIn:
          !!antigravityOAuth?.accessToken &&
          antigravityOAuth.clientId === ANTIGRAVITY_OAUTH_CLIENT_ID,
        account: antigravityOAuth?.account,
        models: antigravityOAuth?.models,
        flowError:
          lastAntigravityOAuthError ??
          (antigravityOAuth?.accessToken &&
          antigravityOAuth.clientId !== ANTIGRAVITY_OAUTH_CLIENT_ID
            ? "Google authentication changed. Sign in again to enable Gemini free-tier quota."
            : undefined),
      },
      version: VERSION,
    },
    tab.id,
  );
  emitTabDiagnostic(tab, "settings.emitted", {
    model: tab.currentModel,
    provider: providerForModel(tab.currentModel),
    modelEndpoint: modelEndpointFor(tab.currentModel),
    editMode,
    budgetConfigured: tab.runtime?.loop.budgetUsd !== undefined,
    oauthSignedIn: !!oauth?.accessToken,
  });
  void emitCodexQuota(tab);
  void emitOllamaQuota(tab);
}

/** Account plan for a cloud Ollama endpoint — `POST {origin}/api/me` with the
 *  same Bearer key. Undefined on any failure (proxy, local daemon, down):
 *  an unknown plan means "no filtering", never a hidden model list. */
export async function fetchOllamaPlan(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const resp = await fetch(`${new URL(baseUrl).origin}/api/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { Plan?: unknown };
    return typeof data.Plan === "string" && data.Plan.length > 0 ? data.Plan : undefined;
  } catch {
    return undefined;
  }
}

export type OllamaProbeResult = "ok" | "gated" | "error";

/** Whether an upstream chat response marks the model as subscription-gated.
 *  Ollama's 403 variants: "requires a subscription" and "requires both a
 *  Pro, Max, or Team plan ..." — both share the "upgrade for access" tail. */
export function isSubscriptionGatedResponse(status: number, bodyText: string): boolean {
  return (
    status === 403 &&
    (bodyText.includes("requires a subscription") || bodyText.includes("upgrade for access"))
  );
}

/** Minimal chat probe — 1-token completion; 403 = gated, 429 gets one retry.
 *  Timeout is long: cold big models are slow to first token, and a timeout
 *  leaves the model unmapped (re-probed on every refresh). */
export async function probeOllamaModel(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<OllamaProbeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return "error";
    }
    if (resp.ok) return "ok";
    if (resp.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const body = await resp.text().catch(() => "");
    return isSubscriptionGatedResponse(resp.status, body) ? "gated" : "error";
  }
  return "error";
}

/** Parse a native `/api/show` payload for a vision encoder: non-empty
 *  `projector_info`, or any `model_info` key under `vision.`. */
export function showPayloadIsVision(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  const projector = rec.projector_info;
  if (typeof projector === "object" && projector !== null && Object.keys(projector).length > 0) {
    return true;
  }
  const modelInfo = rec.model_info;
  if (typeof modelInfo === "object" && modelInfo !== null) {
    for (const key of Object.keys(modelInfo as Record<string, unknown>)) {
      if (key.startsWith("vision.")) return true;
    }
  }
  return false;
}

/** A 1×1 transparent PNG data URL — the smallest payload that exercises a
 *  model's vision tower through the OpenAI-compat `/v1/chat/completions`. */
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Probe whether `model` accepts image parts by POSTing one user message
 *  with a tiny data-URL image to the OpenAI-compat chat endpoint: 2xx ⇒
 *  vision-capable, 400 ⇒ text-only, else indeterminate (`undefined`). */
export async function probeOllamaVision(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<boolean | undefined> {
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
            ],
          },
        ],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return true;
    if (resp.status === 400) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** One `/api/show` fetch for vision + context window; undefined when both
 *  /api/show and the image probe fail (vision is determinate when answered). */
export async function fetchOllamaShowInfo(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<{ vision?: boolean; contextTokens?: number } | undefined> {
  const origin = deriveNativeOllamaOrigin(baseUrl);
  try {
    const show = await fetch(`${origin}/api/show?model=${encodeURIComponent(model)}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (show.ok) {
      const data = (await show.json().catch(() => undefined)) as unknown;
      const contextTokens = showPayloadContextLength(data);
      return {
        vision: showPayloadIsVision(data),
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      };
    }
    // 404 / 405 on /api/show — cloud gateway likely; fall through to the probe.
    if (show.status !== 404 && show.status !== 405) return undefined;
  } catch {
    return undefined;
  }
  const vision = await probeOllamaVision(baseUrl, model, apiKey, timeoutMs);
  return vision === undefined ? undefined : { vision };
}

export async function detectOllamaVision(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<boolean | undefined> {
  return (await fetchOllamaShowInfo(baseUrl, model, apiKey, timeoutMs))?.vision;
}

/** Batch size that stays under the cloud's parallel-burst rate limit (19
 *  concurrent probes 429'd ~half of them; 6 with a 429 retry stays clean). */
const OLLAMA_PROBE_BATCH = 6;

/** App-global snapshot of the fetched Ollama catalog — endpoint + key are
 *  global config, so the catalog is fetched once and shared across every tab
 *  (previously each tab fetched and cached its own copy). */
export interface OllamaCatalogSnapshot {
  models: string[];
  /** Subset of `models` confirmed vision-capable (raw ids, e.g. `llava`). */
  visionModels?: string[];
  plan?: string;
  hiddenCount?: number;
  error?: string;
  fetchedAt: number;
}

/** Reuse the cached catalog for this long on non-force refreshes — rapid
 *  model-menu opens / tab effects hit the cache instead of the network. */
const OLLAMA_CATALOG_TTL_MS = 60_000;

let ollamaCatalogCache: OllamaCatalogSnapshot | null = null;
let ollamaCatalogInflight: Promise<OllamaCatalogSnapshot> | null = null;

/** Prefixed vision set (`ollama/<id>`) built from the last fetched catalog.
 *  Empty set when the catalog is unavailable — image capability then falls
 *  back to the static allowlist (no Ollama model is treated as vision). */
export function ollamaVisionModelIds(): ReadonlySet<string> {
  const snap = ollamaCatalogCache;
  if (!snap?.visionModels) return new Set();
  return new Set(snap.visionModels.map((id) => `ollama/${id}`));
}

/** Test-only: reset the module-level catalog cache between tests. */
export function resetOllamaCatalogCacheForTest(): void {
  ollamaCatalogCache = null;
  ollamaCatalogInflight = null;
}

/** Broadcast the current catalog to every tab — emitted without a tabId so the
 *  frontend routes it into app-global state (all tabs share one list). */
function emitOllamaCatalog(snap: OllamaCatalogSnapshot): void {
  emit({
    type: "$ollama_models",
    models: snap.models,
    ...(snap.visionModels !== undefined ? { visionModels: snap.visionModels } : {}),
    ...(snap.error !== undefined ? { error: snap.error } : {}),
    ...(snap.plan !== undefined ? { plan: snap.plan } : {}),
    ...(snap.hiddenCount !== undefined ? { hiddenCount: snap.hiddenCount } : {}),
  });
}

/** Fetch the Ollama catalog — `GET {base}/models` on the resolved endpoint;
 *  cloud keys' plan (POST /api/me) gates probing; errors ship as `error`.
 *  The optional `tab` only feeds diagnostics — the result is tab-independent. */
async function fetchOllamaCatalog(tab?: Tab): Promise<OllamaCatalogSnapshot> {
  const ep = loadOllamaEndpoint();
  const base = ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL;
  const diag = (
    event: string,
    details?: Record<string, unknown>,
    level: DesktopDiagnosticEvent["level"] = "debug",
  ): void => {
    emitDiagnostic(
      event,
      { ...(tab ? tabDiagnosticState(tab) : {}), ...details },
      { tabId: tab?.id, level },
    );
  };
  try {
    const resp = await fetch(`${base}/models`, {
      method: "GET",
      headers: ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const status = resp.status;
      diag("ollama.models_fetch.failed", { status });
      return {
        models: [],
        error:
          status === 401 || status === 403
            ? "Ollama API key rejected"
            : `Ollama endpoint returned HTTP ${status}`,
        fetchedAt: Date.now(),
      };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const models = (data?.data ?? [])
      .map((m) => (typeof m.id === "string" && m.id.length > 0 ? m.id : undefined))
      .filter((id): id is string => id !== undefined)
      .sort();
    diag("ollama.models_fetch.ok", { count: models.length });

    const gated = new Set<string>();
    const apiKey = ep.apiKey;
    // Plan is re-checked every refresh (one cheap request) so the verdict
    // scope matches the current plan; learned verdicts persist in
    // `~/.reasonix/ollama-model-map.json`, keyed by plan + endpoint + key hash.
    const plan = apiKey ? await fetchOllamaPlan(base, apiKey) : undefined;
    if (plan && apiKey) {
      const path = ollamaVerdictsPath();
      const store = loadOllamaVerdicts(path);
      const scope = scopeKeyFor(base, apiKey);
      const { known, unknown } = partitionByVerdicts(models, store, plan, scope, Date.now());
      for (const [model, verdict] of known) {
        if (verdict.result === "gated") gated.add(model);
      }
      if (unknown.length > 0) {
        for (let i = 0; i < unknown.length; i += OLLAMA_PROBE_BATCH) {
          const batch = unknown.slice(i, i + OLLAMA_PROBE_BATCH);
          const results = await Promise.allSettled(
            batch.map((m) => probeOllamaModel(base, m, apiKey)),
          );
          results.forEach((r, j) => {
            const model = batch[j]!;
            if (r.status === "fulfilled" && (r.value === "ok" || r.value === "gated")) {
              setVerdict(store, plan, scope, model, r.value, Date.now());
              if (r.value === "gated") gated.add(model);
            }
            // Probe errors stay unmapped — retried next refresh, so a
            // transient failure can never permanently hide a model.
          });
        }
        try {
          saveOllamaVerdicts(store, path);
        } catch (err) {
          diag(
            "ollama.verdicts.save_failed",
            { message: err instanceof Error ? err.message : String(err) },
            "warn",
          );
        }
        diag("ollama.probe.done", {
          total: unknown.length,
          cached: known.size,
          gated: gated.size,
        });
      }
      diag("ollama.plan.resolved", { plan });
    }
    const visible = gated.size > 0 ? models.filter((m) => !gated.has(m)) : models;
    // Vision capability is independent of tier gating: probe every visible
    // model once (native /api/show with image-probe fallback) and persist the
    // result on the existing verdict entry when a plan/scope is available.
    // Keyless local daemons have no scope — the set still lives on the
    // snapshot so the UI can enable image upload for vision models.
    const vision = new Set<string>();
    if (visible.length > 0) {
      const visionPath = ollamaVerdictsPath();
      const visionStore = loadOllamaVerdicts(visionPath);
      const visionScope = plan && apiKey ? scopeKeyFor(base, apiKey) : undefined;
      const cached = visionScope
        ? visionModelsFor(visible, visionStore, plan!, visionScope, Date.now())
        : new Set<string>();
      const toProbe = visible.filter((m) => !cached.has(m));
      let visionPersisted = false;
      for (const m of toProbe) {
        const info = await fetchOllamaShowInfo(base, m, apiKey ?? "");
        if (info?.vision === true) vision.add(m);
        if (info !== undefined && visionScope && plan) {
          // Re-read the cached entry if present so we don't clobber a tier
          // verdict that a concurrent pass wrote; then stamp vision + window.
          const existing = verdictFor(visionStore, plan, visionScope, m, Date.now());
          setVerdict(
            visionStore,
            plan,
            visionScope,
            m,
            existing?.result ?? "ok",
            existing?.at ?? Date.now(),
            info.vision,
            info.contextTokens,
          );
          visionPersisted = true;
        }
      }
      for (const m of cached) vision.add(m);
      if (visionPersisted) {
        try {
          saveOllamaVerdicts(visionStore, visionPath);
        } catch (err) {
          diag(
            "ollama.vision.save_failed",
            { message: err instanceof Error ? err.message : String(err) },
            "warn",
          );
        }
      }
      diag("ollama.vision.done", { total: visible.length, vision: vision.size });
    }
    return {
      models: visible,
      visionModels: vision.size > 0 ? [...vision].sort() : undefined,
      plan,
      hiddenCount: gated.size > 0 ? gated.size : undefined,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diag("ollama.models_fetch.error", { message });
    return { models: [], error: `Ollama unreachable: ${message}`, fetchedAt: Date.now() };
  }
}

/** Refresh (or reuse) the app-global Ollama catalog and broadcast it to every
 *  tab. Concurrent calls collapse onto one in-flight fetch; non-force calls
 *  reuse a fresh cache (< TTL). Errors broadcast but are never cached. */
export async function refreshOllamaModels(
  force: boolean,
  tab?: Tab,
): Promise<OllamaCatalogSnapshot> {
  if (ollamaCatalogInflight) return ollamaCatalogInflight;
  const cached = ollamaCatalogCache;
  if (!force && cached && !cached.error && Date.now() - cached.fetchedAt < OLLAMA_CATALOG_TTL_MS) {
    emitOllamaCatalog(cached);
    return cached;
  }
  const inflight = fetchOllamaCatalog(tab)
    .then((snap) => {
      if (!snap.error) ollamaCatalogCache = snap;
      emitOllamaCatalog(snap);
      return snap;
    })
    .finally(() => {
      ollamaCatalogInflight = null;
    });
  ollamaCatalogInflight = inflight;
  return inflight;
}

async function emitBalance(tab: Tab): Promise<void> {
  if (!tab.runtime) {
    emitTabDiagnostic(tab, "balance.skipped", { reason: "runtime-not-ready" });
    return;
  }
  emitTabDiagnostic(tab, "balance.fetch.started");
  const bal = await tab.runtime.loop.client.getBalance().catch((err) => {
    emitDiagnosticError("balance.fetch.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    return null;
  });
  if (!bal) return;
  const primary = pickPrimaryBalance(bal.balance_infos);
  if (!primary) {
    emitTabDiagnostic(tab, "balance.fetch.empty", { balances: bal.balance_infos.length }, "warn");
    return;
  }
  const balanceInfos = bal.balance_infos.map((info) => ({
    currency: info.currency,
    total: Number(info.total_balance),
    granted: info.granted_balance ? Number(info.granted_balance) : undefined,
    toppedUp: info.topped_up_balance ? Number(info.topped_up_balance) : undefined,
  }));
  emit(
    {
      type: "$balance",
      currency: primary.currency,
      total: Number(primary.total_balance),
      isAvailable: bal.is_available,
      balanceInfos,
    },
    tab.id,
  );
  emitTabDiagnostic(tab, "balance.fetch.succeeded", {
    currency: primary.currency,
    isAvailable: bal.is_available,
    balances: balanceInfos.length,
  });
}

/** Last API-reported five-hour / weekly usage — the delta to the next fetch is
 *  percent points consumed since (each $turn_complete refetches). The five-hour
 *  window has ~33× better resolution; weekly covers plans that report only weekly. */
let lastCodexFiveHourUsedPct: number | null = null;
let lastCodexWeeklyUsedPct: number | null = null;

/** Weekly Codex quota for the signed-in ChatGPT plan — OpenAI-model tabs only.
 *  OAuth HTTP fetch only (no codex CLI dependency). */
async function emitCodexQuota(tab: Tab): Promise<void> {
  if (providerForModel(tab.currentModel) !== "openai") {
    emitTabDiagnostic(tab, "quota.skipped", { reason: "non-openai-provider" });
    return;
  }

  emitTabDiagnostic(tab, "quota.fetch.started");
  const oauthResult = await fetchCodexQuotaViaOAuth(10_000).catch((err) => ({
    quota: null,
    reason: (err as Error).message,
  }));
  const quota = oauthResult.quota;
  const reason = oauthResult.reason;

  if (quota) {
    let turnUsedPct: number | null = null;
    const fiveHourUsedPct = quota.fiveHour?.usedPercent ?? null;
    const weeklyUsedPct = quota.weekly?.usedPercent ?? null;
    // Prefer the five-hour window; weekly covers plans that report only weekly.
    const usedPct = fiveHourUsedPct !== null ? fiveHourUsedPct : weeklyUsedPct;
    const previousBaseline =
      fiveHourUsedPct !== null ? lastCodexFiveHourUsedPct : lastCodexWeeklyUsedPct;
    const rollover = previousBaseline !== null && usedPct !== null && usedPct < previousBaseline;
    if (usedPct !== null) {
      // Rollover (window reset) makes the delta go backwards — report no
      // turn cost for this fetch and adopt the new baseline.
      if (previousBaseline !== null && usedPct >= previousBaseline) {
        turnUsedPct = usedPct - previousBaseline;
      }
      if (fiveHourUsedPct !== null) lastCodexFiveHourUsedPct = fiveHourUsedPct;
      else lastCodexWeeklyUsedPct = weeklyUsedPct;
    }
    emitTabDiagnostic(tab, "quota.fetch.succeeded", {
      plan: quota.plan,
      fiveHour: quota.fiveHour,
      weekly: quota.weekly,
      previousUsedPct: previousBaseline,
      currentUsedPct: usedPct,
      rollover,
      turnUsedPct,
    });
    emit({ type: "$codex_quota", quota: { ...quota, turnUsedPct } }, tab.id);
    return;
  }
  emitTabDiagnostic(tab, "quota.fetch.failed", { reason }, "error");
  emit({ type: "$codex_quota", quota: null, ...(reason ? { reason } : {}) }, tab.id);
}

/** Ollama cloud usage — `GET {origin}/api/usage` with the chat key. The API
 *  reports `limits.session` (5 h) and `limits.weekly` (7 d) usage as fractions
 *  of the plan's limit (the absolute cap is not exposed). Undefined on failure. */
export async function fetchOllamaUsage(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<{ session?: number; weekly?: number } | undefined> {
  try {
    const resp = await fetch(`${new URL(baseUrl).origin}/api/usage`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as {
      limits?: { session?: { usage?: unknown }; weekly?: { usage?: unknown } };
    };
    const session = data.limits?.session?.usage;
    const weekly = data.limits?.weekly?.usage;
    if (typeof session !== "number" && typeof weekly !== "number") return undefined;
    return {
      ...(typeof session === "number" ? { session } : {}),
      ...(typeof weekly === "number" ? { weekly } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Last API-reported Ollama session usage % — the delta to the next fetch is
 *  the percent points of the session window consumed since (each
 *  $turn_complete refetches; the window resets every 5 h). */
let lastOllamaSessionUsagePct: number | null = null;

/** Cloud Ollama usage for the signed-in account — Ollama-provider tabs with a
 *  key only. Local daemons have no usage endpoint; the fetch mirrors the
 *  Codex quota fetch and scales the API's fraction to percent. */
async function emitOllamaQuota(tab: Tab): Promise<void> {
  const ep = loadOllamaEndpoint();
  const apiKey = ep.apiKey;
  if (providerForModel(tab.currentModel) !== "ollama" || !apiKey) {
    emitTabDiagnostic(tab, "quota.skipped", {
      reason: !apiKey ? "ollama-no-api-key" : "non-ollama-provider",
    });
    return;
  }
  emitTabDiagnostic(tab, "quota.fetch.started");
  const usage = await fetchOllamaUsage(ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL, apiKey);
  if (!usage) {
    emitTabDiagnostic(tab, "quota.fetch.failed", { reason: "usage-unavailable" }, "error");
    emit({ type: "$ollama_quota", quota: null, reason: "usage-unavailable" }, tab.id);
    return;
  }
  const sessionWindow =
    usage.session !== undefined
      ? { usagePct: usage.session * 100, remainingPct: Math.max(0, 100 - usage.session * 100) }
      : null;
  const weeklyWindow =
    usage.weekly !== undefined
      ? { usagePct: usage.weekly * 100, remainingPct: Math.max(0, 100 - usage.weekly * 100) }
      : null;
  let turnUsedPct: number | null = null;
  const sessionPct = sessionWindow?.usagePct ?? null;
  const previous = lastOllamaSessionUsagePct;
  if (sessionPct !== null) {
    // Rollover (session window reset) makes the delta go backwards — report
    // no turn cost for this fetch and adopt the new baseline.
    if (previous !== null && sessionPct >= previous) turnUsedPct = sessionPct - previous;
    lastOllamaSessionUsagePct = sessionPct;
  }
  emitTabDiagnostic(tab, "quota.fetch.succeeded", {
    session: usage.session,
    weekly: usage.weekly,
    previousSessionPct: previous,
    currentSessionPct: sessionPct,
    turnUsedPct,
  });
  emit(
    {
      type: "$ollama_quota",
      quota: { session: sessionWindow, weekly: weeklyWindow, turnUsedPct, fetchedAt: Date.now() },
    },
    tab.id,
  );
}

function emitSessions(tab: Tab): void {
  emitTabDiagnostic(tab, "sessions.list.started");
  try {
    const items = listSessionsForWorkspace(tab.rootDir).map((s) => ({
      name: s.name,
      messageCount: s.messageCount,
      mtime: s.mtime.toISOString(),
      summary: s.meta.summary,
      workspaceStatus: s.workspaceStatus,
    }));
    emit({ type: "$sessions", items }, tab.id);
    emitTabDiagnostic(tab, "sessions.list.completed", { count: items.length });
  } catch (err) {
    emitDiagnosticError("sessions.list.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    emit({ type: "$error", message: `session_list failed: ${(err as Error).message}` }, tab.id);
  }
}

function loadSessionIntoTab(
  tab: Tab,
  name: string,
  actions: {
    abortTurn: (tab: Tab) => void;
    cancelPendingGates: (tab: Tab) => void;
    persistOpenTabs: () => void;
  },
): void {
  emitTabDiagnostic(tab, "session.load.started", { name });
  const records = loadSessionMessages(name);
  const backfilledWorkspace = patchSessionWorkspaceIfMissing(name, tab.rootDir);
  const meta = loadSessionMeta(name);
  // Only set switching flag when there's a live turn to abort —
  // otherwise the flag stays true and suppresses the first turn's events (#1217).
  if (tab.aborter) tab.switching = true;
  actions.abortTurn(tab);
  actions.cancelPendingGates(tab);
  tab.currentSession = name;
  actions.persistOpenTabs();
  // Rebind model + effort to the conversation's stored pair before the
  // runtime rebuild, so the loop is constructed with the right model.
  restoreSessionModelPrefs(tab, meta);
  if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
  const loadedMessages = buildLoadedMessages(records);
  if (loadedMessages.length === 0) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(sessionPath(name)).size;
    } catch {
      void 0; /* file may not exist */
    }
    emitTabDiagnostic(
      tab,
      "session.load.empty",
      { name, sizeBytes, records: records.length },
      "warn",
    );
    process.stderr.write(
      `session_load: "${name}" returned 0 messages (file size=${sizeBytes}B) — empty or unreadable jsonl\n`,
    );
    emit({ type: "$session_empty", name, sizeBytes }, tab.id);
  }
  emit(
    {
      type: "$session_loaded",
      name,
      messages: loadedMessages,
      carryover: {
        totalCostUsd: meta.totalCostUsd ?? 0,
        cacheHitTokens: meta.cacheHitTokens ?? 0,
        cacheMissTokens: meta.cacheMissTokens ?? 0,
        totalCompletionTokens: meta.totalCompletionTokens ?? 0,
      },
    },
    tab.id,
  );
  emitCtxBreakdown(tab);
  emitSettings(tab);
  if (backfilledWorkspace) emitSessions(tab);
  emitTabDiagnostic(tab, "session.load.completed", {
    name,
    records: records.length,
    loadedMessages: loadedMessages.length,
    backfilledWorkspace,
    carryover: {
      totalCostUsd: meta.totalCostUsd ?? 0,
      cacheHitTokens: meta.cacheHitTokens ?? 0,
      cacheMissTokens: meta.cacheMissTokens ?? 0,
      totalCompletionTokens: meta.totalCompletionTokens ?? 0,
    },
  });
}

function summarizeMcpSpec(raw: string): McpSpecInfo {
  try {
    const parsed = parseMcpSpec(raw);
    if (parsed.transport === "stdio") {
      const argv = [parsed.command, ...parsed.args].join(" ");
      return {
        raw,
        name: parsed.name,
        transport: "stdio",
        summary: `stdio · ${argv}`,
        status: "configured",
      };
    }
    return {
      raw,
      name: parsed.name,
      transport: parsed.transport,
      summary: `${parsed.transport} · ${parsed.url}`,
      status: "configured",
    };
  } catch (err) {
    return {
      raw,
      name: null,
      transport: "stdio",
      summary: raw,
      parseError: (err as Error).message,
      status: "failed",
      statusReason: (err as Error).message,
    };
  }
}

function emitMcpSpecs(tab: Tab): void {
  const cfg = readConfig();
  const specs = (cfg.mcp ?? []).map((raw) => {
    const base = summarizeMcpSpec(raw);
    const live = tab.mcpStatuses.get(raw);
    if (!live) return base;
    return { ...base, status: live.kind, statusReason: live.reason, toolCount: live.toolCount };
  });
  const bridged = specs.length > 0 && specs.every((s) => s.status === "connected");
  emit({ type: "$mcp_specs", specs, bridged }, tab.id);
  emitTabDiagnostic(tab, "mcp.specs.emitted", {
    configured: specs.length,
    connected: specs.filter((spec) => spec.status === "connected").length,
    bridged,
  });
}

function emitMemory(tab: Tab): void {
  try {
    const entries = collectMemoryEntriesForWorkspace(tab.rootDir);
    emit({ type: "$memory", entries }, tab.id);
    emitTabDiagnostic(tab, "memory.list.completed", { count: entries.length });
  } catch (err) {
    emitDiagnosticError("memory.list.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    emit({ type: "$error", message: `memory_get failed: ${(err as Error).message}` }, tab.id);
  }
}

function countTokensForMeter(text: string): number {
  try {
    return countTokensBounded(text);
  } catch {
    return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length * 0.3));
  }
}

/** Reserved (system + tool specs) tokens per loop prefix. Keyed by prefix
 *  identity so emitCtxBreakdown stays O(1); length guards cover in-place
 *  addTool/removeTool (MCP hot-bridge). */
const reservedTokenCache = new WeakMap<
  object,
  { sys: number; sysLen: number; tools: number; toolsLen: number }
>();

// reserved = system prompt + tool specs, constant for the tab's lifetime once
// the loop is built. logTokens is refreshed during turns so Desktop doesn't
// show a fake zero while the streaming call is still waiting on usage metadata.
function emitCtxBreakdown(tab: Tab): void {
  if (!tab.runtime) return;
  const prefix = tab.runtime.loop.prefix;
  const toolSpecs = prefix.toolSpecs;
  let cached = reservedTokenCache.get(prefix);
  if (!cached || cached.sysLen !== prefix.system.length || cached.toolsLen !== toolSpecs.length) {
    cached = {
      sys: countTokensForMeter(prefix.system),
      sysLen: prefix.system.length,
      tools: countTokensForMeter(JSON.stringify(toolSpecs)),
      toolsLen: toolSpecs.length,
    };
    reservedTokenCache.set(prefix, cached);
  }
  const sys = cached.sys;
  const tools = cached.tools;
  let logTokens = 0;
  try {
    logTokens = tab.runtime.loop.getCurrentLogTokens();
  } catch {
    for (const msg of tab.runtime.loop.log.toMessages()) {
      logTokens += countTokensForMeter(typeof msg.content === "string" ? msg.content : "");
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        logTokens += countTokensForMeter(JSON.stringify(msg.tool_calls));
      }
    }
  }
  // ctxMax drives the panel meter's denominator + compaction-limit ticks —
  // keep it in sync with the loop's context cap (resolveContextTokens + the
  // verdict-aware override, so Ollama tabs show the same cap the loop enforces).
  const ctxMax = resolveContextTokens(tab.currentModel, tabCtxMaxOverride(tab));
  emitTabDiagnostic(tab, "context.breakdown", {
    reservedTokens: sys + tools,
    logTokens,
    ctxMax,
  });
  emit(
    {
      type: "$ctx_breakdown",
      reservedTokens: sys + tools,
      logTokens,
      ctxMax,
    },
    tab.id,
  );
}

function emitSkills(tab: Tab): void {
  try {
    const store = new SkillStore({
      projectRoot: tab.rootDir,
      customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
      subagentModels: loadSubagentModels(),
    });
    const items = store.list().map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      path: s.path,
      runAs: s.runAs,
      model: s.model,
    }));
    emit({ type: "$skills", items }, tab.id);
    emitTabDiagnostic(tab, "skills.list.completed", { count: items.length });
  } catch (err) {
    emitDiagnosticError("skills.list.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    emit({ type: "$error", message: `skills_get failed: ${(err as Error).message}` }, tab.id);
  }
}

interface RuntimeState {
  loop: CacheFirstLoop;
  eventizer: Eventizer;
  ctx: {
    model: string;
    prefixHash: string;
    reasoningEffort: import("../../config.js").ReasoningEffort;
  };
}

type SymbolEntry = { name: string; path: string; line: number; kind: string };

interface Tab {
  readonly id: string;
  rootDir: string;
  currentSession: string;
  currentModel: string;
  /** Per-tab reasoning effort — restored from the session's meta on load so a config reset doesn't flip it back to the global default. */
  currentReasoningEffort: import("../../config.js").ReasoningEffort;
  budgetUsd: number | undefined;
  /** User-configured context-window cap (tokens); undefined = per-model default (300K). */
  ctxMaxOverride: number | undefined;
  /** null while the tab is bootstrapping — see `initTabToolset`. UI gates input on `$ready`, which only fires once this is set. */
  toolset: Awaited<ReturnType<typeof buildCodeToolset>> | null;
  /** Empty while bootstrapping; populated together with `toolset`. */
  system: string;
  runtime: RuntimeState | null;
  aborter: AbortController | null;
  fileIndex: FileWithStats[] | null;
  fileIndexBuilding: Promise<FileWithStats[]> | null;
  fileIndexBuiltAt: number;
  symbolIndex: SymbolEntry[] | null;
  symbolBuilding: Promise<SymbolEntry[]> | null;
  recentMentions: string[];
  /** Pause-gate ids waiting on this tab — abort uses these to free stranded plan_checkpoint / plan_revision / shell-confirm callers. */
  pendingGateIds: Set<number>;
  /** Step ids already marked complete in the in-flight plan — also tells UI when a plan is "active". */
  completedStepIds: Set<string>;
  /** Total steps in the in-flight plan (0 = no active plan / steps not provided). */
  planTotalSteps: number;
  mcpRuntime: McpRuntime | null;
  mcpStatuses: Map<string, { kind: McpSpecStatus; reason?: string; toolCount?: number }>;
  /** True while a session switch is in progress — prevents stale events from the old turn. */
  switching: boolean;
  hooks: ResolvedHook[];
}

function tabDiagnosticState(tab: Tab): Record<string, unknown> {
  let credentialAvailable: boolean | null = null;
  try {
    credentialAvailable = tabHasCredential(tab);
  } catch {
    credentialAvailable = null;
  }
  const mcpStatusCounts: Record<string, number> = {};
  for (const status of tab.mcpStatuses.values()) {
    mcpStatusCounts[status.kind] = (mcpStatusCounts[status.kind] ?? 0) + 1;
  }
  const stats = tab.runtime?.loop.stats.summary() ?? null;
  let logEntries: number | null = null;
  if (tab.runtime) {
    try {
      logEntries = tab.runtime.loop.log.length;
    } catch {
      logEntries = null;
    }
  }
  return {
    tabId: tab.id,
    workspaceDirChars: tab.rootDir.length,
    session: tab.currentSession || null,
    model: tab.currentModel,
    provider: providerForModel(tab.currentModel),
    reasoningEffort: tab.currentReasoningEffort,
    credentialAvailable,
    toolsetReady: tab.toolset !== null,
    runtimeReady: tab.runtime !== null,
    busy: tab.aborter !== null,
    switching: tab.switching,
    pendingGateCount: tab.pendingGateIds.size,
    plan: { totalSteps: tab.planTotalSteps, completedSteps: tab.completedStepIds.size },
    mcp: { configured: mcpStatusCounts, runtimeReady: tab.mcpRuntime !== null },
    indexes: {
      fileReady: tab.fileIndex !== null,
      fileBuilding: tab.fileIndexBuilding !== null,
      symbolReady: tab.symbolIndex !== null,
      symbolBuilding: tab.symbolBuilding !== null,
    },
    hooks: tab.hooks.length,
    logEntries,
    turn: tab.runtime?.loop.currentTurn ?? null,
    stats,
  };
}

function emitTabDiagnostic(
  tab: Tab,
  event: string,
  details?: Record<string, unknown>,
  level: DesktopDiagnosticEvent["level"] = "debug",
): void {
  emitDiagnostic(
    event,
    { ...tabDiagnosticState(tab), ...details },
    {
      tabId: tab.id,
      level,
    },
  );
}

let tabCounter = 0;
function nextTabId(): string {
  tabCounter++;
  return `t${tabCounter}`;
}

function mintSessionFor(rootDir: string, prefs?: ModelPrefs): string {
  // Seconds precision — a 12-digit (minute) timestamp would mint the same
  // name for two new_chats in the same minute, silently resurrecting the
  // previous conversation's jsonl in the "new" chat.
  const name = `desktop-${timestampSuffix(14)}-${tabCounter}`;
  try {
    patchSessionMeta(name, prefs ? { workspace: rootDir, ...prefs } : { workspace: rootDir });
  } catch (err) {
    // session meta is for filtering only — failure shouldn't block chat, but LOG
    emitDiagnosticError("session.meta.patch.failed", err, {
      details: { session: name, workspaceDirChars: rootDir.length },
    });
    process.stderr.write(`reasonix: session meta patch failed — ${messageOf(err)}\n`);
  }
  return name;
}

/** The user changed the model/effort enum in the desktop UI — persist the new
 *  pair into the open conversation's meta so a resume (even after a reinstall
 *  wiped the config) restores it. */
function persistSessionModelPrefs(tab: Tab): void {
  if (!tab.currentSession) return;
  try {
    patchSessionMeta(tab.currentSession, {
      model: tab.currentModel,
      reasoningEffort: tab.currentReasoningEffort,
    });
  } catch (err) {
    emitDiagnosticError("session.model-prefs.persist.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    /* meta is best-effort — failure shouldn't block the settings change, but LOG */
    process.stderr.write(`reasonix: session model prefs persist failed — ${messageOf(err)}\n`);
  }
}

/** Record the conversation's model/effort on its first turn — but never
 *  overwrite what's already stored: only an explicit UI change
 *  (settings_save) or a freshly minted session writes after that. */
function stampSessionModelPrefs(tab: Tab): void {
  if (!tab.currentSession) return;
  try {
    const meta = loadSessionMeta(tab.currentSession);
    if (meta.model !== undefined && meta.reasoningEffort !== undefined) return;
    patchSessionMeta(tab.currentSession, {
      model: meta.model ?? tab.currentModel,
      reasoningEffort: meta.reasoningEffort ?? tab.currentReasoningEffort,
    });
  } catch (err) {
    emitDiagnosticError("session.model-prefs.stamp.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    /* meta is best-effort — but LOG so the failure isn't silent */
    process.stderr.write(`reasonix: session model prefs stamp failed — ${messageOf(err)}\n`);
  }
}

/** Rebind the tab's model + effort to the conversation's stored pair — a
 *  reinstall wiped the global config, but the conversation comes back on the
 *  model it was using. Sessions without stored prefs keep the tab's pair. */
function restoreSessionModelPrefs(tab: Tab, meta: SessionMeta): void {
  const prefs = resolveSessionModelPrefs(meta, {
    model: tab.currentModel,
    reasoningEffort: tab.currentReasoningEffort,
  });
  if (prefs.model !== tab.currentModel) {
    tab.currentModel = prefs.model;
    // The system prompt embeds the model id — refresh it when the model
    // changes so tool guidance matches the restored model.
    if (tab.toolset) {
      tab.system = codeSystemPrompt(tab.rootDir, {
        hasSemanticSearch: tab.toolset.semantic.enabled,
        modelId: tab.currentModel,
      });
      syncVisionTool(tab);
    }
  }
  tab.currentReasoningEffort = prefs.reasoningEffort;
}

/** The toolset is built once per tab — keep `see_image` registered iff the
 *  current model accepts images (vision models only; the schema is dead
 *  weight for text models). Model switches and session restores must sync. */
function syncVisionTool(tab: Tab): void {
  if (!tab.toolset) return;
  const tools = tab.toolset.tools;
  if (modelAcceptsImages(tab.currentModel, ollamaVisionModelIds())) {
    if (!tools.has("see_image")) registerSeeImageTool(tools, { rootDir: tab.rootDir });
  } else {
    tools.unregister("see_image");
  }
}

/** Provider-specific "not configured yet" message for a model id — keeps a
 *  gemini tab from being told to paste a DeepSeek key. Shared by the
 *  user_input and skill_run setup gates (deepseek is the fallback provider). */
function notConfiguredMessage(model: string): string {
  switch (providerForModel(model)) {
    case "openai":
      return "Not configured yet — add an OpenAI key or sign in with ChatGPT (Settings → OpenAI) first.";
    case "ollama":
      return "Not configured yet — set an Ollama base URL / key and pick an Ollama model (Settings → Models).";
    case "gemini":
      return "Not configured yet — sign in to Google Antigravity (Settings → Google) to use Gemini models.";
    default:
      return "Not configured yet — paste your DeepSeek API key first.";
  }
}

/** Whether the tab's CURRENT model can be run now — the strict per-turn gate.
 *  gpt needs an OpenAI key/OAuth; deepseek needs its key; local Ollama is
 *  keyless but cloud Ollama needs ollamaApiKey. */
export function tabCurrentModelUsable(tab: Tab): boolean {
  if (providerForModel(tab.currentModel) === "openai") {
    const ep = loadEndpointForModel(tab.currentModel);
    if (ep.apiKey) return true;
    return !!readConfig().openaiOAuth?.accessToken;
  }
  // Local Ollama omits the Authorization header; a cloud endpoint (default
  // https://ollama.com/v1) needs ollamaApiKey — a missing key is a per-turn 401.
  if (providerForModel(tab.currentModel) === "ollama") {
    const ep = loadOllamaEndpoint();
    if (ep.apiKey) return true;
    return isLocalOllamaEndpoint(ep.baseUrl);
  }
  if (providerForModel(tab.currentModel) === "gemini") {
    return !!readConfig().antigravityOAuth?.accessToken;
  }
  return !!loadApiKey();
}

/** True for the keyless local Ollama daemon (localhost / 127.0.0.1 / ::1);
 *  cloud endpoints are NOT keyless. */
function isLocalOllamaEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true; // no endpoint resolved → treat as local
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Setup/readiness gate: usable if the current model's provider has a
 *  credential, OR if ANY alternative provider is configured. Keeps a
 *  ChatGPT/Ollama-only install from being soft-locked behind a DeepSeek key. */
export function tabHasCredential(tab: Tab): boolean {
  return tabCurrentModelUsable(tab) || anyProviderConfigured();
}

/** Re-emit the setup/ready gate for a tab after a credential or model change —
 *  `$ready` when the tab is now usable, `$needs_setup` when it regressed. */
function emitTabGate(tab: Tab): void {
  if (tabHasCredential(tab)) emit({ type: "$ready" }, tab.id);
  else emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
}

/** Effective ctxMaxOverride for a tab: Ollama tabs use the server's learned /api/show
 *  window (verdict store) when fresh, else the user `contextTokens` setting — every ctxMax
 *  consumer (loop, meter, settings changes) must resolve the same value. */
function tabCtxMaxOverride(tab: Tab): number | undefined {
  if (providerForModel(tab.currentModel) !== "ollama") return tab.ctxMaxOverride;
  return (
    contextTokensForModel(
      loadOllamaVerdicts(ollamaVerdictsPath()),
      tab.currentModel.replace(/^ollama\//, ""),
      Date.now(),
    ) ?? tab.ctxMaxOverride
  );
}

function buildRuntimeFor(tab: Tab): RuntimeState {
  if (!tab.toolset) throw new Error("buildRuntimeFor called before initTabToolset finished");
  const toolset = tab.toolset;
  applyPlanMode(toolset.tools, loadEditMode());
  const ep = loadEndpointForModel(tab.currentModel);
  const provider = providerForModel(tab.currentModel);
  const isOpenAI = isOpenAIStandardEndpoint(tab.currentModel);
  const log = createLogger("desktop");
  if (isOpenAI) {
    const keyStatus = ep.apiKey ? "static key present, " : "no static key, ";
    log.debug(
      `model ${tab.currentModel} → OpenAI; ${keyStatus}Codex backend transport enabled (plan quota)`,
    );
  } else if (provider === "ollama") {
    log.debug(
      `model ${tab.currentModel} → Ollama; endpoint ${ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL}`,
    );
  } else if (provider === "gemini") {
    log.debug(
      `model ${tab.currentModel} → Gemini; endpoint ${ep.baseUrl ?? DEFAULT_GEMINI_CHAT_URL} (Antigravity quota)`,
    );
  } else {
    log.debug(`model ${tab.currentModel} → DeepSeek; endpoint ${ep.baseUrl ?? "default"}`);
  }
  const client = new DeepSeekClient({
    apiKey: ep.apiKey,
    baseUrl: ep.baseUrl,
    // Local Ollama is keyless — the client omits the Authorization header.
    allowMissingKey: provider === "ollama",
    // OAuth tokens refresh per request — fallback for when the Codex backend
    // transport declines (no OAuth creds or token refresh failed). Without
    // OAuth, the static API key is used and requests bill to platform credits.
    apiKeyResolver: isOpenAI ? () => resolveOpenAIToken() : undefined,
    // Primary path: when OAuth creds exist, route through the ChatGPT Codex
    // backend so requests consume plan quota (free), not platform credits.
    transportResolver: isOpenAI ? () => resolveCodexTransport() : undefined,
    // Gemini models authenticate via Google Antigravity OAuth (Starter quota).
    geminiAuthResolver: provider === "gemini" ? () => resolveGeminiAuth() : undefined,
  });
  const prefix = new ImmutablePrefix({ system: tab.system, toolSpecs: toolset.tools.specs() });
  const reasoningEffort = tab.currentReasoningEffort;
  // Ollama tabs calibrate compaction against the server's real window when one
  // has been learned from /api/show (verdict store); the user `contextTokens`
  // override (clamped ≥300K) is the fallback, then the per-model default.
  const ctxMaxOverride = tabCtxMaxOverride(tab);
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools: toolset.tools,
    model: tab.currentModel,
    budgetUsd: tab.budgetUsd,
    ctxMaxOverride,
    session: tab.currentSession,
    reasoningEffort,
    maxIterPerTurn: loadMaxIterPerTurn(),
    maxOutputTokens: loadMaxOutputTokens(),
    // Live thunk (not a snapshot) so a mid-session Shift+Tab / /mode flip
    // stops the iteration cap from pausing the turn in yolo.
    getEditMode: () => loadEditMode(),
    hooks: tab.hooks,
    hookCwd: tab.rootDir,
    onPreCompaction: () => toolset.jobs.cancelAll(),
  });
  const eventizer = new Eventizer();
  const ctx = { model: tab.currentModel, prefixHash: prefix.fingerprint, reasoningEffort };
  return { loop, eventizer, ctx };
}

const TS_EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+\*?\s*(\w+)/;

/** TTL on the in-memory file index — without this, files deleted / renamed since the last @ popup still show up as candidates. 10s balances "fresh enough for typical edit-then-mention flows" against "don't re-scan 5000 files on every keystroke". */
const FILE_INDEX_TTL_MS = 10_000;

async function getFileIndexFor(tab: Tab): Promise<FileWithStats[]> {
  const fresh = tab.fileIndex && Date.now() - tab.fileIndexBuiltAt < FILE_INDEX_TTL_MS;
  if (fresh) return tab.fileIndex as FileWithStats[];
  if (tab.fileIndexBuilding) return tab.fileIndexBuilding;
  tab.fileIndexBuilding = listFilesWithStatsAsync(tab.rootDir, { maxResults: 5000 })
    .then((res) => {
      tab.fileIndex = res;
      tab.fileIndexBuiltAt = Date.now();
      tab.fileIndexBuilding = null;
      return res;
    })
    .catch((err) => {
      tab.fileIndexBuilding = null;
      throw err;
    });
  return tab.fileIndexBuilding;
}

async function getSymbolIndexFor(tab: Tab): Promise<SymbolEntry[]> {
  if (tab.symbolIndex) return tab.symbolIndex;
  if (tab.symbolBuilding) return tab.symbolBuilding;
  tab.symbolBuilding = (async () => {
    const files = await getFileIndexFor(tab);
    const sourceExts = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
    const candidates = files.filter((f) => sourceExts.test(f.path)).slice(0, 1500);
    const out: SymbolEntry[] = [];
    const PARALLEL = 16;
    for (let i = 0; i < candidates.length; i += PARALLEL) {
      const batch = candidates.slice(i, i + PARALLEL);
      await Promise.all(
        batch.map(async (entry) => {
          const abs = isAbsolute(entry.path) ? entry.path : join(tab.rootDir, entry.path);
          try {
            const text = await readFile(abs, "utf8");
            const lines = text.split(/\r?\n/);
            for (let li = 0; li < lines.length; li++) {
              const line = lines[li]!;
              if (!line.startsWith("export ")) continue;
              const m = TS_EXPORT_RE.exec(line);
              if (m) out.push({ kind: m[1]!, name: m[2]!, path: entry.path, line: li + 1 });
            }
          } catch (err) {
            emitDiagnosticError("symbol-index.file.failed", err, {
              tabId: tab.id,
              details: { pathChars: entry.path.length, ...tabDiagnosticState(tab) },
            });
            // unreadable / binary — skip, but LOG
            process.stderr.write(`reasonix: symbol index parse failed — ${messageOf(err)}\n`);
          }
        }),
      );
    }
    tab.symbolIndex = out;
    tab.symbolBuilding = null;
    return out;
  })().catch((err) => {
    tab.symbolBuilding = null;
    throw err;
  });
  return tab.symbolBuilding;
}

function rankSymbols(syms: readonly SymbolEntry[], q: string, limit: number): string[] {
  const needle = q.toLowerCase();
  const scored: { entry: SymbolEntry; score: number }[] = [];
  for (const s of syms) {
    const lower = s.name.toLowerCase();
    let score: number;
    if (lower === needle) score = 0;
    else if (lower.startsWith(needle)) score = 100;
    else if (lower.includes(needle)) score = 500 + lower.indexOf(needle);
    else continue;
    scored.push({ entry: s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((s) => `${s.entry.path}:${s.entry.line}`);
}

function pushMentionRecent(tab: Tab, path: string): void {
  const MAX = 20;
  const idx = tab.recentMentions.indexOf(path);
  if (idx >= 0) tab.recentMentions.splice(idx, 1);
  tab.recentMentions.unshift(path);
  if (tab.recentMentions.length > MAX) tab.recentMentions.length = MAX;
}

/** The desktop sidecar is a long-running daemon — Tauri spawns this Node process once per app launch and pipes JSON over stdin/stdout. Without these handlers, any orphaned promise rejection (e.g. from an aborted turn whose cleanup races a session-switch — #1074) crashes the process with exit code 1, which the Tauri host surfaces as "reasonix exited (code 1)" and a full reconnect cycle. Log loudly so we can find the underlying bug, but don't take the daemon down. */
export function installDesktopCrashGuards(
  stderr: { write: (s: string) => unknown } = process.stderr,
): void {
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const message = redactDesktopDiagnosticMessage(
      err.stack ?? err.message,
      Number.POSITIVE_INFINITY,
    );
    stderr.write(`[desktop] unhandledRejection: ${message}\n`);
  });
  process.on("uncaughtException", (err) => {
    const message = redactDesktopDiagnosticMessage(
      err.stack ?? err.message,
      Number.POSITIVE_INFINITY,
    );
    stderr.write(`[desktop] uncaughtException: ${message}\n`);
  });
}

export async function desktopCommand(opts: DesktopOptions): Promise<void> {
  loadDotenv();
  const log = createLogger("desktop");
  log.info(`Reasonix desktop daemon starting (${opts.model ?? "default model"})`);
  // Tauri spawns the bundled Node from the GUI process, which never runs the
  // user's shell init (`.bashrc` / `.zshrc` / profile). Probe the login shell
  // once so nvm / asdf / fnm / volta / mise PATH entries reach `run_command`
  // children too (#1252). No-op on Windows — system PATH already covers GUI apps.
  const augmented = augmentProcessPath();
  if (augmented.added.length > 0) {
    log.debug(`augmented PATH with ${augmented.added.length} login-shell entries`);
  }
  installDesktopCrashGuards();

  const tabs = new Map<string, Tab>();
  const tabContext = new AsyncLocalStorage<string>();
  // Frontend-reported focused tab — persisted so a restart reopens on it (#1244).
  let lastActiveTabId = "";

  function activeRunningTab(): Tab | undefined {
    const id = tabContext.getStore();
    return id ? tabs.get(id) : undefined;
  }

  let first: Tab;

  /** Synchronous tab construction — no I/O. All cheap, disk-only events (`$settings`, `$sessions`, `$memory`, `$skills`, `$mcp_specs`) can fire against this immediately. The heavy bits (`buildCodeToolset`, MCP probes, runtime construction) happen in `initTabToolset` so the UI shell paints without waiting for them. */
  function createTabSkeleton(initialDir?: string, restoreId?: string): Tab {
    const dir = resolve(initialDir ?? opts.dir ?? loadWorkspaceDir() ?? process.cwd());
    pushRecentWorkspace(dir);
    const model = opts.model || loadModel() || DEFAULT_MODEL;
    // Restored tabs keep their persisted id so a backend restart doesn't
    // re-mint t1..tN over the frontend's still-open tabs. Bump the counter
    // past the restored id so freshly opened tabs never collide with it.
    const id = restoreId ?? nextTabId();
    const idMatch = /^t(\d+)$/.exec(id);
    if (idMatch) tabCounter = Math.max(tabCounter, Number(idMatch[1]));
    const tab: Tab = {
      id,
      rootDir: dir,
      currentSession: "",
      currentModel: model,
      currentReasoningEffort: loadReasoningEffort(),
      budgetUsd: opts.budgetUsd,
      ctxMaxOverride: loadContextTokens(),
      toolset: null,
      system: "",
      runtime: null,
      aborter: null,
      fileIndex: null,
      fileIndexBuilding: null,
      fileIndexBuiltAt: 0,
      symbolIndex: null,
      symbolBuilding: null,
      recentMentions: [],
      pendingGateIds: new Set<number>(),
      completedStepIds: new Set<string>(),
      planTotalSteps: 0,
      mcpRuntime: null,
      mcpStatuses: new Map(),
      switching: false,
      hooks: loadHooks({ projectRoot: dir }),
    };
    tab.currentSession = mintSessionFor(dir, {
      model: tab.currentModel,
      reasoningEffort: tab.currentReasoningEffort,
    });
    tabs.set(tab.id, tab);
    emitTabDiagnostic(tab, "tab.created", { active: false }, "info");
    return tab;
  }

  /** Builds the toolset / system prompt / runtime / MCP bridge for a freshly-created skeleton. Reads `tab.currentModel` at call time so model changes during the wait are honored. */
  function subagentSinkFor(tab: Tab) {
    return {
      current: (ev: SubagentEvent): void => {
        const progress = projectSubagentEvent(ev);
        const runtime = tab.runtime;
        if (!progress || !runtime) return;
        emitKernelEvent(
          runtime.eventizer.emitSubagentProgress(
            ev.parentTurn ?? runtime.loop.currentTurn,
            progress,
          ),
          tab.id,
        );
      },
    };
  }

  async function initTabToolset(tab: Tab): Promise<void> {
    emitTabDiagnostic(tab, "tab.bootstrap.started", undefined, "info");
    const toolset = await buildCodeToolset({
      rootDir: tab.rootDir,
      onSkillInstalled: () => emitSkills(tab),
      onJobsChanged: () => emitJobs(),
      subagentSink: subagentSinkFor(tab),
      visionEnabled: modelAcceptsImages(tab.currentModel, ollamaVisionModelIds()),
    });
    tab.toolset = toolset;
    tab.system = codeSystemPrompt(tab.rootDir, {
      hasSemanticSearch: toolset.semantic.enabled,
      modelId: tab.currentModel,
    });
    if (tabCurrentModelUsable(tab)) {
      bridgeEndpointEnv();
      tab.runtime = buildRuntimeFor(tab);
      emitTabDiagnostic(tab, "tab.runtime.ready", undefined, "info");
      void bridgeTabMcp(tab);
    } else {
      emitTabDiagnostic(tab, "tab.runtime.waiting-for-credential", undefined, "warn");
    }
    emitTabDiagnostic(
      tab,
      "tab.bootstrap.completed",
      {
        toolCount: toolset.tools.specs().length,
        semanticEnabled: toolset.semantic.enabled,
      },
      "info",
    );
  }

  function bridgeTabMcp(tab: Tab): Promise<void> {
    if (!tab.runtime || !tab.toolset) {
      emitTabDiagnostic(tab, "mcp.bridge.skipped", { reason: "runtime-or-toolset-not-ready" });
      return Promise.resolve();
    }
    emitTabDiagnostic(tab, "mcp.bridge.started", {
      configured: (readConfig().mcp ?? []).length,
    });
    if (tab.mcpRuntime) {
      // Already constructed — reload so new/removed specs settle without restart.
      return tab.mcpRuntime
        .reloadFromConfig(tab.runtime.loop)
        .then(() => {
          emitTabDiagnostic(tab, "mcp.bridge.completed", { mode: "reload" });
          emitMcpSpecs(tab);
        })
        .catch((err) => {
          emitDiagnosticError("mcp.bridge.failed", err, {
            tabId: tab.id,
            details: { mode: "reload", ...tabDiagnosticState(tab) },
          });
          emit({ type: "$error", message: `mcp reload failed: ${(err as Error).message}` }, tab.id);
        });
    }
    const requested = (readConfig().mcp ?? []).length;
    if (requested === 0) {
      emitTabDiagnostic(tab, "mcp.bridge.skipped", { reason: "no-configured-servers" });
      return Promise.resolve();
    }
    const runtime = createMcpRuntime({
      getTools: () => {
        if (!tab.toolset) throw new Error("toolset gone");
        return tab.toolset.tools;
      },
      getMcpPrefix: () => undefined,
      getRequestedCount: () => requested,
      getWorkspaceDir: () => tab.rootDir,
      progressSink: { current: null },
    });
    tab.mcpRuntime = runtime;
    runtime.setLifecycleSink((notice) => {
      if (notice.kind === "slow") {
        emitTabDiagnostic(
          tab,
          "mcp.lifecycle",
          {
            notice: "slow",
            name: notice.serverName,
            p95Ms: notice.p95Ms,
            sampleSize: notice.sampleSize,
          },
          "warn",
        );
        return;
      }
      const cfg = readConfig().mcp ?? [];
      const target = cfg.find((raw) => {
        try {
          return parseMcpSpec(raw).name === notice.name;
        } catch {
          return false;
        }
      });
      if (!target) {
        emitTabDiagnostic(
          tab,
          "mcp.lifecycle.unmatched",
          {
            notice: notice.kind,
            name: notice.name,
          },
          "warn",
        );
        return;
      }
      emitTabDiagnostic(
        tab,
        "mcp.lifecycle",
        {
          notice: notice.kind,
          name: notice.name,
          ...(notice.kind === "connected"
            ? {
                tools: notice.tools,
                resources: notice.resources,
                prompts: notice.prompts,
                ms: notice.ms,
              }
            : {}),
          ...(notice.kind === "failed" || notice.kind === "warn" ? { reason: notice.reason } : {}),
        },
        notice.kind === "failed" ? "error" : "debug",
      );
      if (notice.kind === "handshake") {
        tab.mcpStatuses.set(target, { kind: "handshake" });
      } else if (notice.kind === "connected") {
        tab.mcpStatuses.set(target, { kind: "connected", toolCount: notice.tools });
      } else if (notice.kind === "failed") {
        tab.mcpStatuses.set(target, { kind: "failed", reason: notice.reason });
      } else if (notice.kind === "disabled") {
        tab.mcpStatuses.set(target, { kind: "disabled" });
      }
      emitMcpSpecs(tab);
    });
    return runtime
      .reloadFromConfig(tab.runtime.loop)
      .then((result) => {
        emitTabDiagnostic(tab, "mcp.bridge.completed", {
          mode: "initial",
          added: result.added.length,
          removed: result.removed.length,
          failed: result.failed.length,
          summaries: result.summaries.length,
        });
      })
      .catch((err) => {
        emitDiagnosticError("mcp.bridge.failed", err, {
          tabId: tab.id,
          details: { mode: "initial", ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp bridge failed: ${(err as Error).message}` }, tab.id);
      });
  }

  /** Snapshot of every open tab — workspace dir, loaded session and focus, in tab order. Persisted after open/close/switch so a restart restores the full tab set and each conversation (issues #933, #1244). */
  function persistOpenTabs(): void {
    try {
      saveDesktopOpenTabs(
        Array.from(tabs.values()).map((t) => ({
          dir: t.rootDir,
          id: t.id,
          session: t.currentSession || undefined,
          active: t.id === lastActiveTabId,
        })),
      );
    } catch (err) {
      emitDiagnosticError("tabs.persist.failed", err, {
        details: { tabCount: tabs.size, activeTabId: lastActiveTabId },
      });
      // best-effort — disk / perms shouldn't break tab management, but LOG
      process.stderr.write(`reasonix: open tabs persist failed — ${messageOf(err)}\n`);
    }
  }

  async function closeTab(tab: Tab): Promise<void> {
    emitTabDiagnostic(tab, "tab.close.started", undefined, "info");
    abortTurn(tab);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch (err) {
      emitDiagnosticError("tab.jobs.shutdown.failed", err, {
        tabId: tab.id,
        details: tabDiagnosticState(tab),
      });
      // shutdown errors aren't actionable here — but LOG
      process.stderr.write(`reasonix: tab job shutdown failed — ${messageOf(err)}\n`);
    }
    if (tab.mcpRuntime) {
      try {
        // closeAll's loop iterates every MCP client sequentially with no
        // per-client timeout — one hung streamable-http close can stall
        // the whole tab close.  Race the entire batch against 5 s so
        // $tab_closed still fires.
        const DEADLINE = 5000;
        await Promise.race([
          tab.mcpRuntime.closeAll(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out after 5 s")), DEADLINE),
          ),
        ]);
      } catch (err) {
        emitDiagnosticError("tab.mcp.shutdown.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        // MCP shutdown errors aren't actionable here either — but LOG
        process.stderr.write(`reasonix: tab MCP closeAll failed — ${messageOf(err)}\n`);
      }
    }
    tabs.delete(tab.id);
    if (first && first.id === tab.id) {
      const next = tabs.values().next().value;
      if (next) first = next;
    }
    persistOpenTabs();
    emitTabDiagnostic(tab, "tab.close.completed", undefined, "info");
    emit({ type: "$tab_closed" }, tab.id);
  }

  async function runTurn(tab: Tab, text: string, images?: TurnImage[]): Promise<void> {
    emitTabDiagnostic(
      tab,
      "turn.start.requested",
      {
        textChars: text.length,
        imageCount: images?.length ?? 0,
      },
      "info",
    );
    if (!tab.runtime) {
      emitTabDiagnostic(tab, "turn.start.rejected", { reason: "runtime-not-ready" }, "error");
      return;
    }
    if (!tabCurrentModelUsable(tab)) {
      emitTabDiagnostic(tab, "turn.start.rejected", { reason: "credential-unavailable" }, "error");
      const provider = providerForModel(tab.currentModel);
      const message =
        provider === "openai"
          ? `No OpenAI credential for ${tab.currentModel} — add an OpenAI key or sign in with ChatGPT (Settings → OpenAI).`
          : provider === "ollama"
            ? `No Ollama endpoint configured for ${tab.currentModel} — set a base URL / key (Settings → Models → Ollama).`
            : provider === "gemini"
              ? "Not signed in to Google Antigravity — sign in from Settings to use Gemini models."
              : "No API key configured — paste your DeepSeek API key first.";
      emit({ type: "$error", message }, tab.id);
      return;
    }
    const rt = tab.runtime;
    // Only vision-capable models accept image content parts — DeepSeek 400s
    // otherwise. The UI hides the affordance for non-vision models; this is
    // the hard gate so a stale or forged request can't reach the API.
    if (
      images &&
      images.length > 0 &&
      !modelAcceptsImages(tab.currentModel, ollamaVisionModelIds())
    ) {
      emitTabDiagnostic(
        tab,
        "turn.start.rejected",
        {
          reason: "images-require-vision-model",
          imageCount: images.length,
        },
        "error",
      );
      emit(
        {
          type: "$error",
          message:
            "Images require a vision-capable model (gpt-* or deepseek-v4-flash-vision-exp) — switch models to attach images.",
        },
        tab.id,
      );
      return;
    }
    // First turn of a fresh conversation records the model/effort it runs
    // with; a later resume restores them even after a reinstall wiped the
    // config. Never overwrites an existing stored pair (see stampSessionModelPrefs).
    stampSessionModelPrefs(tab);
    tab.aborter = new AbortController();
    emitTabDiagnostic(
      tab,
      "turn.started",
      {
        textChars: text.length,
        imageCount: images?.length ?? 0,
      },
      "info",
    );
    let lastAssistantText = "";
    if (tab.currentSession) {
      const existing = loadSessionMeta(tab.currentSession).summary;
      if (!existing || !existing.trim()) {
        const summary = flattenText(text).slice(0, 60);
        if (summary) {
          try {
            patchSessionMeta(tab.currentSession, { summary });
          } catch (err) {
            // meta is for display only — failure shouldn't block the turn, but LOG
            process.stderr.write(
              `reasonix: session meta summary patch failed — ${messageOf(err)}\n`,
            );
          }
        }
      }
    }
    if (tab.hooks.some((h) => h.event === "UserPromptSubmit")) {
      const report = await runHooks({
        hooks: tab.hooks,
        payload: { event: "UserPromptSubmit", cwd: tab.rootDir, prompt: text },
      });
      for (const o of report.outcomes) {
        if (o.decision === "pass") continue;
        emit({ type: "$error", message: formatHookOutcomeMessage(o) }, tab.id);
      }
      if (report.blocked) {
        tab.aborter = null;
        emit({ type: "$turn_complete" }, tab.id);
        return;
      }
    }
    await tabContext.run(tab.id, async () => {
      // Drive the turn generator manually instead of `for await`: an abort
      // can land while the generator is suspended inside an await (the
      // compaction fold is deliberately non-interruptible and can hold it
      // for minutes). A plain for-await only notices the abort when the
      // next event arrives, so Send now / Stop during a fold never reached
      // $turn_complete and the queued-sends drain never ran. raceLoopStep
      // resolves `null` the moment the aborter fires instead.
      const gen = rt.loop.step(text, images);
      let aborted = false;
      let lastTurn = -1;
      let sawAssistantFinal = false;
      let openCompactionId: string | undefined;
      try {
        let emittedTurnContext = false;
        while (true) {
          const next = await raceLoopStep(gen, tab.aborter?.signal);
          if (next === null) {
            aborted = true;
            break;
          }
          if (next.done) break;
          const ev = next.value;
          emitDiagnostic(
            "turn.loop.event",
            {
              role: ev.role,
              turn: ev.turn,
              contentChars: ev.content?.length ?? 0,
              toolName: ev.toolName ?? null,
            },
            { tabId: tab.id },
          );
          lastTurn = ev.turn;
          if (!emittedTurnContext) {
            emittedTurnContext = true;
            emitCtxBreakdown(tab);
          }
          if (ev.role === "assistant_final") {
            sawAssistantFinal = true;
            if (ev.content) lastAssistantText = ev.content;
          }
          for (const kev of rt.eventizer.consume(ev, rt.ctx)) emitKernelEvent(kev, tab.id);
          if (ev.role === "assistant_final" || ev.role === "tool") {
            emitCtxBreakdown(tab);
          }
          // Memory tools mutate disk state behind the loop's back — the UI
          // panel won't know until we re-emit. Without this the right-hand
          // panel only updates on tab reopen.
          if (ev.role === "tool" && (ev.toolName === "remember" || ev.toolName === "forget")) {
            emitMemory(tab);
          }
          if (ev.role === "compaction_start" && ev.compactionId) {
            openCompactionId = ev.compactionId;
          }
          if (ev.role === "compaction_end") openCompactionId = undefined;
        }
      } catch (err) {
        emit({ type: "$error", message: (err as Error).message }, tab.id);
      } finally {
        if (aborted) {
          // Close the suspended generator so its finallys (per-turn abort
          // state reset) run as soon as the pending await settles — the
          // fold is non-interruptible, so this must NOT be awaited here.
          // The loop itself reassigns _turnAbort fresh on the next step(),
          // so the deferred reset can't clobber the next turn's signal.
          void gen.return(undefined).catch(() => undefined);
        }
        tab.aborter = null;
        emitTabDiagnostic(
          tab,
          "turn.finished",
          {
            aborted,
            lastTurn,
            sawAssistantFinal,
            lastAssistantChars: lastAssistantText.length,
          },
          aborted ? "warn" : "info",
        );
        // If a session switch happened while this turn was running,
        // suppress stale events to avoid UI state corruption (#1217).
        if (!tab.switching) {
          if (aborted && lastTurn >= 0 && !sawAssistantFinal) {
            // The loop's own abort path never ran (the generator was
            // closed mid-await), so settle the still-pending assistant
            // card here — $turn_complete alone leaves it spinning.
            emit(rt.eventizer.emitAbortedFinal(lastTurn), tab.id);
          }
          if (aborted && openCompactionId && lastTurn >= 0) {
            // Same for a running compaction card: compaction_end was
            // never yielded. Report the interruption — the detached fold
            // keeps running and its merge-at-commit preserves anything
            // the next turn appends.
            emit(
              rt.eventizer.emitCompactionFinished(openCompactionId, {
                turn: lastTurn,
                folded: false,
                beforeMessages: 0,
                afterMessages: 0,
                summaryChars: 0,
                error: "aborted by user",
              }),
              tab.id,
            );
          }
          emit({ type: "$turn_complete" }, tab.id);
          emitTabDiagnostic(
            tab,
            "turn.complete.emitted",
            {
              planProgress: { completed: tab.completedStepIds.size, total: tab.planTotalSteps },
            },
            "info",
          );
          if (tab.planTotalSteps > 0 && tab.completedStepIds.size >= tab.planTotalSteps) {
            tab.completedStepIds.clear();
            tab.planTotalSteps = 0;
            emit({ type: "$plan_cleared" }, tab.id);
          }
          emitSessions(tab);
          void emitBalance(tab);
          void emitCodexQuota(tab);
          void emitOllamaQuota(tab);
          if (tab.hooks.some((h) => h.event === "Stop")) {
            const stopReport = await runHooks({
              hooks: tab.hooks,
              payload: {
                event: "Stop",
                cwd: tab.rootDir,
                lastAssistantText,
                turn: rt.loop.stats.summary().turns,
              },
            });
            for (const o of stopReport.outcomes) {
              if (o.decision === "pass") continue;
              emit({ type: "$error", message: formatHookOutcomeMessage(o) }, tab.id);
            }
          }
        }
        tab.switching = false;
      }
    });
  }

  async function switchWorkspace(tab: Tab, nextDir: string): Promise<void> {
    const target = resolve(nextDir);
    emitTabDiagnostic(tab, "workspace.switch.started", { targetChars: target.length }, "info");
    if (target === tab.rootDir) {
      emitTabDiagnostic(tab, "workspace.switch.skipped", { reason: "same-workspace" });
      emitSettings(tab);
      return;
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      emitTabDiagnostic(
        tab,
        "workspace.switch.rejected",
        { targetChars: target.length, reason: "not-a-directory" },
        "error",
      );
      emit({ type: "$error", message: `Workspace not found: ${target}` }, tab.id);
      emitSettings(tab);
      return;
    }
    abortTurn(tab);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch (err) {
      emitDiagnosticError("workspace.jobs.shutdown.failed", err, {
        tabId: tab.id,
        details: { targetChars: target.length, ...tabDiagnosticState(tab) },
      });
      // shutdown errors aren't actionable here — but LOG
      process.stderr.write(`reasonix: tab job shutdown failed — ${messageOf(err)}\n`);
    }
    tab.rootDir = target;
    saveWorkspaceDir(target);
    pushRecentWorkspace(target);
    tab.fileIndex = null;
    tab.fileIndexBuilding = null;
    tab.fileIndexBuiltAt = 0;
    tab.symbolIndex = null;
    tab.symbolBuilding = null;
    tab.recentMentions.length = 0;
    tab.hooks = loadHooks({ projectRoot: target });
    tab.currentSession = mintSessionFor(target);
    tab.toolset = await buildCodeToolset({
      rootDir: target,
      onSkillInstalled: () => emitSkills(tab),
      onJobsChanged: () => emitJobs(),
      subagentSink: subagentSinkFor(tab),
      visionEnabled: modelAcceptsImages(tab.currentModel, ollamaVisionModelIds()),
    });
    tab.system = codeSystemPrompt(target, {
      hasSemanticSearch: tab.toolset.semantic.enabled,
      modelId: tab.currentModel,
    });
    if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
    emitSessions(tab);
    emitSettings(tab);
    emitSkills(tab);
    persistOpenTabs();
    emitTabDiagnostic(tab, "workspace.switch.completed", { targetChars: target.length }, "info");
  }

  function forgetGate(id: number): Tab | undefined {
    for (const t of tabs.values()) {
      if (t.pendingGateIds.delete(id)) return t;
    }
    return undefined;
  }

  function abortTurn(tab: Tab, opts: LoopAbortOptions = {}): void {
    tab.aborter?.abort();
    tab.runtime?.loop.abort(opts);
  }

  function cancelConversation(tab: Tab, opts: LoopAbortOptions = {}): void {
    abortTurn(tab, opts);
    cancelPendingGates(tab);
    void tab.toolset?.jobs
      .shutdown(1500)
      .catch((err) => {
        emitDiagnosticError("conversation.jobs.shutdown.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        process.stderr.write(`reasonix: conversation job shutdown failed — ${messageOf(err)}\n`);
      })
      .finally(() => emitJobs());
  }

  function tabSessionLabel(tab: Tab): string {
    if (tab.currentSession) {
      try {
        const summary = loadSessionMeta(tab.currentSession).summary?.trim();
        if (summary) return summary;
      } catch (err) {
        emitDiagnosticError("session.meta.load.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        // session file unreadable — fall through to workspace basename, but LOG
        process.stderr.write(`reasonix: session meta load failed — ${messageOf(err)}\n`);
      }
    }
    return tab.rootDir.split(/[\\/]/).filter(Boolean).pop() ?? tab.rootDir;
  }

  function emitJobs(): void {
    const items: JobInfo[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      const label = tabSessionLabel(t);
      for (const j of reg.list()) {
        items.push({
          id: j.id,
          tabId: t.id,
          sessionLabel: label,
          command: j.command,
          pid: j.pid,
          running: j.running,
          exitCode: j.exitCode,
          startedAt: j.startedAt,
          outputTail: tailLines(j.output, 8),
          spawnError: j.spawnError,
        });
      }
    }
    items.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
    emit({ type: "$jobs", items });
  }

  async function stopJob(jobId: number): Promise<boolean> {
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      const hit = reg.list().find((j) => j.id === jobId);
      if (!hit) continue;
      await reg.stop(jobId);
      return true;
    }
    return false;
  }

  async function stopAllJobs(): Promise<void> {
    const ops: Promise<unknown>[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      for (const j of reg.list()) {
        if (j.running) ops.push(reg.stop(j.id));
      }
    }
    await Promise.allSettled(ops);
  }

  function cancelPendingGates(tab: Tab): void {
    const hadActivePlan = tab.planTotalSteps > 0 || tab.completedStepIds.size > 0;
    const ids = [...tab.pendingGateIds];
    tab.pendingGateIds.clear();
    for (const id of ids) pauseGate.cancel(id);
    if (hadActivePlan) {
      tab.completedStepIds.clear();
      tab.planTotalSteps = 0;
      emit({ type: "$plan_cleared" }, tab.id);
    }
  }

  // `first` is the fallback tab for legacy tabId-less RPC messages. We
  // assign it lazily below so saved-tabs restore (issue #933) can choose
  // the boot dir before construction, and rotate `first` to the next
  // surviving tab when its source closes.
  let shuttingDown = false;
  /** 60s quota poll — assigned below after tab restore, cleared on shutdown. */
  let quotaTimer: ReturnType<typeof setInterval> | undefined = undefined;
  async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (quotaTimer) clearInterval(quotaTimer);
    await Promise.allSettled(
      [...tabs.values()].map((t) => t.toolset?.jobs.shutdown(1500) ?? Promise.resolve()),
    );
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    void gracefulShutdown();
  });
  process.on("SIGINT", () => {
    void gracefulShutdown();
  });

  pauseGate.on((req) => {
    const tab = activeRunningTab();
    const tabId = tab?.id;
    if (tab) tab.pendingGateIds.add(req.id);
    // Shared auto-resolve policy (e.g. plan_checkpoint in auto/yolo) — must
    // still run BEFORE we emit any UI event, otherwise the surface flickers
    // a card that we'd immediately tear down.
    const auto = autoResolveVerdict(req, loadEditMode());
    if (auto?.kind === "instant") {
      // plan_checkpoint specifically needs the step-completed signal to flow
      // through so the rail progress ticks. Emit it before resolving.
      if (req.kind === "plan_checkpoint") {
        const payload = req.payload as {
          stepId: string;
          title?: string;
          result: string;
          notes?: string;
        };
        if (tab) tab.completedStepIds.add(payload.stepId);
        emit(
          {
            type: "$step_completed",
            stepId: payload.stepId,
            title: payload.title,
            result: payload.result,
            notes: payload.notes,
          },
          tabId,
        );
      }
      // plan_proposed auto-approved in yolo — clear any prior plan state and
      // track step count so $step_completed progress-to-clear still works.
      if (req.kind === "plan_proposed") {
        const payload = req.payload as { plan: string; steps?: { id: string }[]; summary?: string };
        if (tab) {
          tab.completedStepIds.clear();
          tab.planTotalSteps = payload.steps?.length ?? 0;
        }
      }
      if (tab) tab.pendingGateIds.delete(req.id);
      pauseGate.resolve(req.id, auto.verdict);
      return;
    }
    // YOLO interactive gates: surface the picker so a watching user can override
    // the default. Keep a backend timer as the source of eventual resolution;
    // the frontend mirrors it for visible countdown feedback and resolves first
    // when the user picks manually.
    const countdownMs = auto?.kind === "countdown" ? auto.ms : undefined;
    if (auto?.kind === "countdown") {
      setTimeout(() => {
        forgetGate(req.id);
        pauseGate.resolve(req.id, auto.verdict);
      }, auto.ms);
    }
    if (req.kind === "run_command" || req.kind === "run_background") {
      const payload = req.payload as {
        command?: string;
        cwd?: string;
        timeoutSec?: number;
        waitSec?: number;
      };
      emit(
        {
          type: "$confirm_required",
          id: req.id,
          kind: req.kind,
          command: payload.command ?? "",
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload,
          }),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "path_access") {
      const payload = req.payload as {
        path: string;
        intent: "read" | "write";
        toolName: string;
        sandboxRoot: string;
        allowPrefix: string;
      };
      emit(
        {
          type: "$path_access_required",
          id: req.id,
          path: payload.path,
          intent: payload.intent,
          toolName: payload.toolName,
          sandboxRoot: payload.sandboxRoot,
          allowPrefix: payload.allowPrefix,
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload,
          }),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "choice") {
      const payload = req.payload as {
        question: string;
        options: ChoiceOption[];
        allowCustom: boolean;
      };
      emit(
        {
          type: "$choice_required",
          id: req.id,
          question: payload.question,
          options: payload.options,
          allowCustom: payload.allowCustom,
          ...(countdownMs !== undefined ? { countdownMs } : {}),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_proposed") {
      const payload = req.payload as { plan: string; steps?: PlanStep[]; summary?: string };
      if (tab) {
        tab.completedStepIds.clear();
        tab.planTotalSteps = payload.steps?.length ?? 0;
      }
      emit(
        {
          type: "$plan_required",
          id: req.id,
          plan: payload.plan,
          steps: payload.steps,
          summary: payload.summary,
          ...(countdownMs !== undefined ? { countdownMs } : {}),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_checkpoint") {
      const payload = req.payload as {
        stepId: string;
        title?: string;
        result: string;
        notes?: string;
      };
      if (tab) {
        tab.completedStepIds.add(payload.stepId);
      }
      emit(
        {
          type: "$step_completed",
          stepId: payload.stepId,
          title: payload.title,
          result: payload.result,
          notes: payload.notes,
        },
        tabId,
      );
      emit(
        {
          type: "$checkpoint_required",
          id: req.id,
          stepId: payload.stepId,
          title: payload.title,
          result: payload.result,
          notes: payload.notes,
          completed: tab?.completedStepIds.size ?? 0,
          total: tab?.planTotalSteps ?? 0,
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_revision") {
      const payload = req.payload as {
        reason: string;
        remainingSteps: PlanStep[];
        summary?: string;
      };
      emit(
        {
          type: "$revision_required",
          id: req.id,
          reason: payload.reason,
          remainingSteps: payload.remainingSteps,
          summary: payload.summary,
          ...(countdownMs !== undefined ? { countdownMs } : {}),
        },
        tabId,
      );
      return;
    }
    // Unknown PauseKind — `never` makes a new kind without a handler a compile
    // error; the runtime cancel is the last-mile defense so the agent loop
    // doesn't hang waiting on a request no one will resolve.
    const exhaustive: never = req.kind;
    process.stderr.write(
      `[desktop] no handler for pause kind "${String(exhaustive)}" — auto-cancelling gate id=${req.id}\n`,
    );
    if (tab) tab.pendingGateIds.delete(req.id);
    pauseGate.cancel(req.id);
  });

  // Fast-path: emit disk-only events immediately so the UI shell renders
  // before the toolset finishes building. Heavy work (semantic bootstrap,
  // MCP probes, runtime construction) runs in initTabToolset which fires
  // `$ready` when it completes — until then `state.ready` keeps the
  // composer disabled, so users can't send a message before the runtime
  // exists. emitBalance was already fire-and-forget.
  function bootstrapTab(
    initialDir?: string,
    restore?: { id?: string; session?: string; active?: boolean },
  ): Tab {
    const tab = createTabSkeleton(initialDir, restore?.id);
    emitTabDiagnostic(
      tab,
      "tab.bootstrap.requested",
      {
        restoredId: restore?.id ?? null,
        restoredSession: restore?.session ?? null,
        active: restore?.active ?? false,
      },
      "info",
    );
    // Reopen the conversation the tab had, if its jsonl is still readable.
    let restoredMessages: LoadedMessage[] | undefined;
    if (restore?.session) {
      try {
        if (existsSync(sessionPath(restore.session))) {
          const msgs = buildLoadedMessages(loadSessionMessages(restore.session));
          if (msgs.length > 0) {
            tab.currentSession = restore.session;
            // Restore the conversation's stored model/effort so the system
            // prompt + runtime (built by initTabToolset) use them.
            restoreSessionModelPrefs(tab, loadSessionMeta(tab.currentSession));
            restoredMessages = msgs;
          }
        }
      } catch (err) {
        // unreadable jsonl — fall back to the freshly minted session, but LOG
        emitDiagnosticError("session.restore.failed", err, {
          tabId: tab.id,
          details: { requestedSession: restore.session, ...tabDiagnosticState(tab) },
        });
        process.stderr.write(`reasonix: session load for resync failed — ${messageOf(err)}\n`);
      }
    }
    emitTabDiagnostic(tab, "tab.bootstrap.session-state", {
      restored: restoredMessages !== undefined,
      restoredMessages: restoredMessages?.length ?? 0,
    });
    emit({ type: "$tab_opened", workspaceDir: tab.rootDir, active: restore?.active }, tab.id);
    emitSessions(tab);
    emitSettings(tab);
    emitMcpSpecs(tab);
    emitSkills(tab);
    emitMemory(tab);
    if (restoredMessages) {
      const meta = loadSessionMeta(tab.currentSession);
      emit(
        {
          type: "$session_loaded",
          name: tab.currentSession,
          messages: restoredMessages,
          carryover: {
            totalCostUsd: meta.totalCostUsd ?? 0,
            cacheHitTokens: meta.cacheHitTokens ?? 0,
            cacheMissTokens: meta.cacheMissTokens ?? 0,
            totalCompletionTokens: meta.totalCompletionTokens ?? 0,
          },
        },
        tab.id,
      );
    }
    if (!tabHasCredential(tab)) {
      emitTabDiagnostic(tab, "tab.setup.required", { reason: "credential-unavailable" }, "warn");
      emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
    }
    void emitBalance(tab);
    void initTabToolset(tab)
      .then(() => {
        if (tabHasCredential(tab)) {
          emitTabDiagnostic(tab, "tab.ready", undefined, "info");
          emit({ type: "$ready" }, tab.id);
        } else {
          emitTabDiagnostic(tab, "tab.ready.skipped", { reason: "credential-unavailable" }, "warn");
        }
        emitCtxBreakdown(tab);
      })
      .catch((err) => {
        emitDiagnosticError("tab.bootstrap.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        emit({ type: "$error", message: `init failed: ${(err as Error).message}` }, tab.id);
      });
    return tab;
  }

  // Restore the full tab set from the previous session — workspace dir,
  // loaded session and focused tab (issues #933, #1244). Missing dirs
  // are silently skipped — a deleted workspace shouldn't break boot.
  const savedTabs = loadDesktopOpenTabs().filter((t) => {
    try {
      return existsSync(t.dir) && statSync(t.dir).isDirectory();
    } catch {
      return false;
    }
  });
  // When launched with --dir, find the matching saved tab so the user's
  // previous session is restored automatically.
  const startupDir = opts.dir;
  const startupTab = startupDir
    ? savedTabs.find((t) => resolve(t.dir) === resolve(startupDir))
    : savedTabs[0];
  first = bootstrapTab(opts.dir ?? savedTabs[0]?.dir, startupTab);
  const restored: Tab[] = [first];
  for (const t of savedTabs.slice(1)) restored.push(bootstrapTab(t.dir, t));
  // Mirror the persisted focus so the next persist round-trips it.
  const activeIdx = savedTabs.findIndex((t) => t.active);
  lastActiveTabId = ((activeIdx >= 0 ? restored[activeIdx] : first) ?? first).id;
  persistOpenTabs();
  // Account-wide quotas change underneath us (other devices, window resets) —
  // poll so the statusbar chips are never stale. Skipped mid-turn so the
  // $turn_complete fetch stays the authoritative turn-cost measurement.
  let quotaPolling = false;
  quotaTimer = setInterval(() => {
    if (quotaPolling) return;
    for (const t of tabs.values()) {
      if (t.aborter) {
        emitTabDiagnostic(t, "quota.poll.skipped", { reason: "turn-in-progress" });
        return;
      }
    }
    const tab = tabs.get(lastActiveTabId);
    if (!tab) {
      emitDiagnostic("quota.poll.skipped", {
        reason: "active-tab-not-found",
        activeTabId: lastActiveTabId,
      });
      return;
    }
    emitTabDiagnostic(tab, "quota.poll.started", { intervalMs: 60_000 });
    quotaPolling = true;
    void Promise.allSettled([emitCodexQuota(tab), emitOllamaQuota(tab)]).finally(() => {
      quotaPolling = false;
      emitTabDiagnostic(tab, "quota.poll.completed");
    });
  }, 60_000);

  const rl = createInterface({ input: stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: InMessage;
    try {
      msg = JSON.parse(trimmed) as InMessage;
    } catch (err) {
      emitDiagnosticError("rpc.stdin.invalid-json", err, {
        details: { inputChars: trimmed.length, previewChars: Math.min(trimmed.length, 80) },
      });
      emit({ type: "$error", message: `bad json on stdin: ${trimmed.slice(0, 80)}` });
      return;
    }
    emitDiagnostic("rpc.command.received", {
      command: msg.cmd,
      tabId: "tabId" in msg ? (msg.tabId ?? null) : null,
    });

    if (msg.cmd === "tab_open") {
      try {
        // A user-opened tab takes focus.
        const opened = bootstrapTab(msg.workspaceDir, { active: true });
        lastActiveTabId = opened.id;
        persistOpenTabs();
      } catch (err) {
        emitDiagnosticError("tab.open.failed", err);
        emit({ type: "$error", message: `tab_open failed: ${(err as Error).message}` });
      }
      return;
    }
    if (msg.cmd === "tab_activate") {
      const activated = tabs.get(msg.tabId);
      if (activated) {
        emitTabDiagnostic(
          activated,
          "tab.activated",
          { previousActiveTabId: lastActiveTabId },
          "info",
        );
        lastActiveTabId = msg.tabId;
        persistOpenTabs();
        // Refetch immediately — the tab may have sat idle for hours, and
        // the statusbar must show the current quota the moment it's shown.
        void emitCodexQuota(activated);
        void emitOllamaQuota(activated);
      } else {
        emitDiagnostic(
          "tab.activate.failed",
          { tabId: msg.tabId },
          {
            level: "error",
            message: "tab activation requested for an unknown tab",
          },
        );
      }
      return;
    }
    if (msg.cmd === "confirm_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "choice_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "plan_response") {
      const tab = forgetGate(msg.id);
      if (tab && msg.response.type === "cancel") {
        tab.completedStepIds.clear();
        tab.planTotalSteps = 0;
        emit({ type: "$plan_cleared" }, tab.id);
      }
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "checkpoint_response") {
      const tab = forgetGate(msg.id);
      if (tab && msg.response.type === "stop") {
        tab.completedStepIds.clear();
        tab.planTotalSteps = 0;
        emit({ type: "$plan_cleared" }, tab.id);
      }
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "revision_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "setup_save_key") {
      const key = msg.key.trim();
      if (!isPlausibleKey(key)) {
        emit({
          type: "$error",
          message: "Key looks too short — paste the full token (16+ chars, no spaces).",
        });
        return;
      }
      try {
        saveApiKey(key);
        bridgeEndpointEnv();
        for (const tab of tabs.values()) {
          // Skeleton tabs still mid-bootstrap pick up the new key inside
          // initTabToolset's tail when buildCodeToolset settles — don't
          // try to construct a runtime against a null toolset here.
          if (!tab.toolset) {
            emitSettings(tab);
            void emitBalance(tab);
            continue;
          }
          tab.runtime = buildRuntimeFor(tab);
          emit({ type: "$ready" }, tab.id);
          emitSettings(tab);
          void emitBalance(tab);
        }
      } catch (err) {
        emit({ type: "$error", message: `saveApiKey failed: ${(err as Error).message}` });
      }
      return;
    }

    if (msg.cmd === "desktop_resync") {
      // WebView reloads (DevTools F5, host-side respawn) leave the Node child
      // alive but the React app starts blank. Re-fire the bootstrap events
      // so it can rehydrate without restarting the agent.
      for (const t of tabs.values()) {
        emit(
          { type: "$tab_opened", workspaceDir: t.rootDir, active: t.id === lastActiveTabId },
          t.id,
        );
        emitSessions(t);
        emitSettings(t);
        emitMcpSpecs(t);
        emitSkills(t);
        emitMemory(t);
        if (!tabHasCredential(t)) emit({ type: "$needs_setup", reason: "no_api_key" }, t.id);
        else if (t.toolset) emit({ type: "$ready" }, t.id);
        void emitBalance(t);
        // Re-emit session_loaded so the resumed session's messages and
        // usage stats (cost, tokens, cache%) are restored on the frontend.
        // Marked `resync` so the frontend can ignore the echo when it's
        // mid-turn — the live transcript is newer than the disk snapshot.
        if (t.currentSession) {
          try {
            const msgs = buildLoadedMessages(loadSessionMessages(t.currentSession));
            const meta = loadSessionMeta(t.currentSession);
            emit(
              {
                type: "$session_loaded",
                name: t.currentSession,
                messages: msgs,
                carryover: {
                  totalCostUsd: meta.totalCostUsd ?? 0,
                  cacheHitTokens: meta.cacheHitTokens ?? 0,
                  cacheMissTokens: meta.cacheMissTokens ?? 0,
                  totalCompletionTokens: meta.totalCompletionTokens ?? 0,
                },
                resync: true,
              },
              t.id,
            );
          } catch (err) {
            emitDiagnosticError("session.resync.failed", err, {
              tabId: t.id,
              details: tabDiagnosticState(t),
            });
            // unreadable jsonl — skip re-emit, but LOG
            process.stderr.write(`reasonix: session load for resync failed — ${messageOf(err)}\n`);
          }
        }
        emitCtxBreakdown(t);
      }
      // Authoritative tab set at the END of the burst — the frontend prunes
      // tabs this list doesn't contain (ghosts left by an older backend
      // generation whose ids were re-minted after a restart).
      emit({
        type: "$tabs_snapshot",
        tabs: Array.from(tabs.values()).map((t) => ({
          id: t.id,
          workspaceDir: t.rootDir,
          active: t.id === lastActiveTabId,
        })),
      });
      // Auto-refresh the Ollama catalog once per launch/WebView reload — the
      // catalog is app-global (endpoint + key are global config), so a single
      // fetch broadcasts to every tab. Unconditional: even a tab on a
      // DeepSeek/OpenAI model benefits when a local Ollama daemon is up, and a
      // failure only surfaces on the Models settings page (the composer hides
      // the error unless the tab's model is an Ollama model).
      void refreshOllamaModels(true);
      return;
    }
    if (msg.cmd === "jobs_list") {
      emitJobs();
      return;
    }
    if (msg.cmd === "jobs_stop") {
      void stopJob(msg.jobId).finally(() => emitJobs());
      return;
    }
    if (msg.cmd === "jobs_stop_all") {
      void stopAllJobs().finally(() => emitJobs());
      return;
    }

    const tab = msg.tabId ? tabs.get(msg.tabId) : first;
    if (!tab) {
      emitDiagnostic(
        "rpc.dispatch.unknown-tab",
        { tabId: msg.tabId ?? null, command: msg.cmd },
        { level: "error", message: "command dropped because the tab is unknown" },
      );
      if (msg.cmd === "tab_close" && msg.tabId) {
        // Ghost tab — id no longer known backend-side (re-minted after a
        // restart, or already closed). Ack the close so the frontend removes
        // it immediately instead of leaving a zombie until the next resync.
        emit({ type: "$tab_closed" }, msg.tabId);
        return;
      }
      // Unknown tabId — the renderer's per-tab router drops the event
      // silently. Surface to stderr instead so it's at least visible when
      // the desktop is launched from a terminal.
      process.stderr.write(
        `rpc dispatch: unknown tabId=${msg.tabId} for cmd=${msg.cmd} — dropping\n`,
      );
      return;
    }

    if (msg.cmd === "abort") {
      emitTabDiagnostic(tab, "rpc.command.abort", undefined, "info");
      cancelConversation(tab, desktopUserAbortLoopOptions());
      return;
    }
    if (msg.cmd === "cancel_tool") {
      emitTabDiagnostic(tab, "rpc.command.cancel-tool", undefined, "info");
      tab.runtime?.loop.cancelCurrentTool("User stopped the running command (desktop Stop button)");
      return;
    }
    if (msg.cmd === "tab_close") {
      closeTab(tab).catch((err) => {
        emitDiagnosticError("tab.close.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        process.stderr.write(`reasonix: closeTab rejected — ${messageOf(err)}\n`);
      });
      return;
    }
    if (msg.cmd === "mcp_specs_get") {
      emitMcpSpecs(tab);
      return;
    }
    if (msg.cmd === "mcp_specs_add") {
      const spec = msg.spec.trim();
      if (!spec) {
        emit({ type: "$error", message: "mcp_specs_add: spec is empty" }, tab.id);
        return;
      }
      try {
        parseMcpSpec(spec);
      } catch (err) {
        emit({ type: "$error", message: `mcp_specs_add: ${(err as Error).message}` }, tab.id);
        return;
      }
      try {
        const cfg = readConfig();
        const list = cfg.mcp ?? [];
        if (!list.includes(spec)) {
          cfg.mcp = [...list, spec];
          writeConfig(cfg);
        }
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emitDiagnosticError("mcp.spec.add.failed", err, {
          tabId: tab.id,
          details: { specChars: spec.length, ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp_specs_add: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mcp_specs_remove") {
      try {
        const cfg = readConfig();
        const list = cfg.mcp ?? [];
        if (list.includes(msg.spec)) {
          cfg.mcp = list.filter((s) => s !== msg.spec);
          writeConfig(cfg);
        }
        tab.mcpStatuses.delete(msg.spec);
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emitDiagnosticError("mcp.spec.remove.failed", err, {
          tabId: tab.id,
          details: { specChars: msg.spec.length, ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp_specs_remove: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "skills_get") {
      emitSkills(tab);
      return;
    }
    if (msg.cmd === "skill_run") {
      if (!tab.runtime) {
        emit({ type: "$error", message: notConfiguredMessage(tab.currentModel) }, tab.id);
        return;
      }
      try {
        const store = new SkillStore({
          projectRoot: tab.rootDir,
          customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
        });
        const found = store.read(msg.name);
        if (!found) {
          emit({ type: "$error", message: `skill not found: ${msg.name}` }, tab.id);
          return;
        }
        const extra = msg.args?.trim() ?? "";
        const header = `# Skill: ${found.name}${found.description ? `\n> ${found.description}` : ""}`;
        const argsLine = extra ? `\n\nArguments: ${extra}` : "";
        const payload = `${header}\n\n${found.body}${argsLine}`;
        void runTurn(tab, payload);
      } catch (err) {
        emit({ type: "$error", message: `skill_run: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "session_list") {
      emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_delete") {
      deleteSession(msg.name);
      emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_clear") {
      for (const s of listSessionsForWorkspace(tab.rootDir)) deleteSession(s.name);
      emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_rename") {
      try {
        const trimmed = normalizeSessionTitle(msg.title);
        patchSessionMeta(msg.name, { summary: trimmed || undefined });
        emitSessions(tab);
      } catch (err) {
        emit(
          { type: "$error", message: `session_rename failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_import") {
      try {
        const result = importExternalSession({
          source: msg.source,
          path: msg.path,
          name: msg.name,
          workspace: tab.rootDir,
        });
        emitSessions(tab);
        loadSessionIntoTab(tab, result.name, {
          abortTurn,
          cancelPendingGates,
          persistOpenTabs,
        });
      } catch (err) {
        emit(
          { type: "$error", message: `session_import failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_import_scan") {
      try {
        emit({ type: "$session_import_sources", apps: discoverExternalSessionApps() }, tab.id);
      } catch (err) {
        emit(
          { type: "$error", message: `session_import_scan failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_import_bulk") {
      try {
        const result = importExternalSessions({
          sources: msg.sources,
          workspace: tab.rootDir,
        });
        emitSessions(tab);
        emit(
          {
            type: "$session_import_result",
            imported: result.imported,
            skipped: result.skipped,
            failed: result.failed,
          },
          tab.id,
        );
        if (result.latestName) {
          loadSessionIntoTab(tab, result.latestName, {
            abortTurn,
            cancelPendingGates,
            persistOpenTabs,
          });
        }
      } catch (err) {
        emit(
          { type: "$error", message: `session_import_bulk failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_load") {
      try {
        loadSessionIntoTab(tab, msg.name, {
          abortTurn,
          cancelPendingGates,
          persistOpenTabs,
        });
      } catch (err) {
        emitDiagnosticError("session.load.failed", err, {
          tabId: tab.id,
          details: { requestedSession: msg.name, ...tabDiagnosticState(tab) },
        });
        process.stderr.write(`session_load: "${msg.name}" threw — ${(err as Error).message}\n`);
        emit({ type: "$error", message: `session_load failed: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_read") {
      try {
        const detail = readMemoryEntryDetail({ path: msg.path }, tab.rootDir);
        emit({ type: "$memory_detail", detail }, tab.id);
      } catch (err) {
        emit({ type: "$error", message: `memory_read failed: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_write") {
      try {
        writeMemoryEntry(
          {
            scope: msg.scope,
            name: msg.name,
            description: msg.description,
            body: msg.body,
            ...(msg.type ? { type: msg.type } : {}),
            ...(msg.priority ? { priority: msg.priority } : {}),
          },
          tab.rootDir,
        );
        emitMemory(tab);
        emit(
          { type: "$memory_result", ok: true, message: `saved ${msg.scope}/${msg.name}` },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$memory_result", ok: false, message: (err as Error).message }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_delete") {
      try {
        const ok = deleteMemoryEntry(msg.path, tab.rootDir);
        emitMemory(tab);
        emit(
          {
            type: "$memory_result",
            ok,
            message: ok ? "memory deleted" : "memory not found",
          },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$memory_result", ok: false, message: (err as Error).message }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_export") {
      try {
        const bundle = exportMemories(tab.rootDir);
        emit({ type: "$memory_export", text: JSON.stringify(bundle, null, 2) }, tab.id);
      } catch (err) {
        emit(
          { type: "$error", message: `memory_export failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "memory_import") {
      try {
        const result = importMemories(JSON.parse(msg.json), tab.rootDir);
        emitMemory(tab);
        const skipped = result.skipped.length > 0 ? ` (skipped ${result.skipped.length})` : "";
        emit(
          {
            type: "$memory_result",
            ok: true,
            message: `imported ${result.imported} memory${result.imported === 1 ? "" : "ies"}${skipped}`,
          },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$memory_result", ok: false, message: (err as Error).message }, tab.id);
      }
      return;
    }
    if (msg.cmd === "new_chat") {
      emitTabDiagnostic(tab, "session.new-chat.started", undefined, "info");
      // Only set switching flag when there's a live turn to abort —
      // otherwise the flag stays true and suppresses the first turn's events (#1217).
      if (tab.aborter) tab.switching = true;
      abortTurn(tab);
      cancelPendingGates(tab);
      tab.currentSession = mintSessionFor(tab.rootDir, {
        model: tab.currentModel,
        reasoningEffort: tab.currentReasoningEffort,
      });
      persistOpenTabs();
      if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
      emitSessions(tab);
      emitTabDiagnostic(tab, "session.new-chat.completed", undefined, "info");
      return;
    }
    if (msg.cmd === "oauth_begin") {
      oauthGen++;
      if (pendingOAuth) pendingOAuth.cancel();
      const gen = oauthGen;
      void beginOAuthFlow()
        .then((flow) => {
          pendingOAuth = flow;
          emit({ type: "oauth_begin_result", url: flow.url }, tab.id);
          void flow.done
            .then(async (creds) => {
              if (gen !== oauthGen) return; // superseded by a newer begin/signout
              pendingOAuth = null;
              const account = (await oauthAccount(creds.accessToken)) ?? creds.account;
              saveOpenAIOAuth({ ...creds, account });
              lastOAuthError = null;
              // The runtime snapshots the credential source at build time —
              // build (or rebuild) now-credentialed tabs so a fresh sign-in
              // takes effect (and clears the needs-setup screen) without a
              // model flip. A tab that booted un-credentialed has a null
              // runtime — it must be built here, not just rebuilt.
              for (const t of tabs.values()) {
                if (t.toolset && tabHasCredential(t)) {
                  t.runtime = buildRuntimeFor(t);
                  emit({ type: "$ready" }, t.id);
                }
              }
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== oauthGen) return;
              pendingOAuth = null;
              lastOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastOAuthError = err.message;
          emit({ type: "$error", message: `oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "oauth_cancel") {
      oauthGen++;
      if (pendingOAuth) {
        pendingOAuth.cancel();
        pendingOAuth = null;
      }
      return;
    }
    if (msg.cmd === "oauth_signout") {
      oauthGen++;
      lastOAuthError = null;
      if (pendingOAuth) {
        pendingOAuth.cancel();
        pendingOAuth = null;
      }
      void signOutOpenAI()
        .then(() => emitSettings(tab))
        .catch((err: Error) => {
          emit({ type: "$error", message: `oauth_signout failed: ${err.message}` }, tab.id);
        });
      return;
    }
    if (msg.cmd === "gemini_oauth_begin") {
      antigravityOAuthGen++;
      if (pendingAntigravityOAuth) pendingAntigravityOAuth.cancel();
      const gen = antigravityOAuthGen;
      void beginAntigravityOAuthFlow()
        .then((flow) => {
          pendingAntigravityOAuth = flow;
          emit({ type: "gemini_oauth_begin_result", url: flow.url }, tab.id);
          void flow.done
            .then(async (creds) => {
              if (gen !== antigravityOAuthGen) return; // superseded by a newer begin/signout
              pendingAntigravityOAuth = null;
              const account = (await antigravityAccount(creds.accessToken)) ?? creds.account;
              const projectId = await onboardAntigravity(creds.accessToken);
              const onboarded = {
                ...creds,
                clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
                account,
                projectId,
              };
              saveAntigravityOAuth(onboarded);
              const models = (await fetchAntigravityModels(creds.accessToken, projectId)).map(
                ({ id }) => id,
              );
              saveAntigravityOAuth({ ...onboarded, models });
              lastAntigravityOAuthError = null;
              // Build (or rebuild) now-credentialed tabs so a fresh sign-in
              // takes effect (and clears the needs-setup screen) without a
              // model flip. A tab that booted un-credentialed has a null
              // runtime — it must be built here, not just rebuilt.
              for (const t of tabs.values()) {
                if (t.toolset && tabHasCredential(t)) {
                  t.runtime = buildRuntimeFor(t);
                  emit({ type: "$ready" }, t.id);
                }
              }
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== antigravityOAuthGen) return;
              pendingAntigravityOAuth = null;
              lastAntigravityOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastAntigravityOAuthError = err.message;
          emit({ type: "$error", message: `gemini_oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "gemini_oauth_cancel") {
      antigravityOAuthGen++;
      if (pendingAntigravityOAuth) {
        pendingAntigravityOAuth.cancel();
        pendingAntigravityOAuth = null;
      }
      return;
    }
    if (msg.cmd === "gemini_oauth_signout") {
      antigravityOAuthGen++;
      lastAntigravityOAuthError = null;
      if (pendingAntigravityOAuth) {
        pendingAntigravityOAuth.cancel();
        pendingAntigravityOAuth = null;
      }
      void signOutAntigravity()
        .then(() => emitSettings(tab))
        .catch((err: Error) => {
          emit({ type: "$error", message: `gemini_oauth_signout failed: ${err.message}` }, tab.id);
        });
      return;
    }
    if (msg.cmd === "setup_save_openai_key") {
      const key = msg.key.trim();
      if (!isPlausibleKey(key)) {
        emit(
          {
            type: "$error",
            message: "Key looks too short — paste the full token (16+ chars, no spaces).",
          },
          tab.id,
        );
        return;
      }
      try {
        saveOpenAIApiKey(key);
        // A fresh OpenAI key also unblocks ChatGPT-only installs whose tab still
        // defaults to a DeepSeek model — build (or rebuild) every now-credentialed
        // tab ready. A tab that booted un-credentialed has a null runtime — it
        // must be built here, not just rebuilt.
        for (const t of tabs.values()) {
          if (t.toolset && tabHasCredential(t)) {
            t.runtime = buildRuntimeFor(t);
            emit({ type: "$ready" }, t.id);
          }
        }
        emitSettings(tab);
      } catch (err) {
        emit(
          { type: "$error", message: `saveOpenAIApiKey failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "settings_get") {
      emitSettings(tab);
      return;
    }
    if (msg.cmd === "codex_quota_get") {
      void emitCodexQuota(tab);
      return;
    }
    if (msg.cmd === "ollama_quota_get") {
      void emitOllamaQuota(tab);
      return;
    }
    if (msg.cmd === "ollama_models_list") {
      // `force` (manual refresh button) refetches; plain calls reuse the
      // app-global cache within its TTL so tab effects don't hammer the
      // endpoint. The broadcast is tabId-less — every tab shares the result.
      void refreshOllamaModels(!!msg.force, tab);
      return;
    }
    if (msg.cmd === "antigravity_models_refresh") {
      void refreshAntigravityModels(tab);
      return;
    }
    if (msg.cmd === "settings_save") {
      try {
        if (msg.reasoningEffort !== undefined && isReasoningEffort(msg.reasoningEffort)) {
          saveReasoningEffort(msg.reasoningEffort);
          tab.currentReasoningEffort = msg.reasoningEffort;
          tab.runtime?.loop.configure({ reasoningEffort: msg.reasoningEffort });
          persistSessionModelPrefs(tab);
        }
        if (msg.editMode !== undefined) {
          saveEditMode(msg.editMode);
          if (tab.toolset) applyPlanMode(tab.toolset.tools, msg.editMode);
        }
        if (msg.budgetUsd !== undefined) {
          tab.budgetUsd = msg.budgetUsd ?? undefined;
          tab.runtime?.loop.setBudget(msg.budgetUsd);
        }
        if (msg.contextTokens !== undefined) {
          saveContextTokens(msg.contextTokens);
          const next = loadContextTokens();
          tab.ctxMaxOverride = next;
          // Re-resolve verdict-aware so an Ollama tab keeps its learned window
          // while the new user value stays the fallback (matches boot logic).
          tab.runtime?.loop.configure({ ctxMaxOverride: tabCtxMaxOverride(tab) ?? null });
          emitCtxBreakdown(tab);
          emitSettings(tab);
        }
        if (msg.baseUrl !== undefined) saveBaseUrl(msg.baseUrl);
        if (msg.workspaceDir !== undefined) {
          void switchWorkspace(tab, msg.workspaceDir);
          return;
        }
        if (msg.editor !== undefined) saveEditor(msg.editor);
        if (msg.showSystemEvents !== undefined) saveShowSystemEvents(msg.showSystemEvents);
        if (msg.ollamaBaseUrl !== undefined) {
          const cfg = readConfig();
          cfg.ollamaBaseUrl = msg.ollamaBaseUrl?.trim() || undefined;
          writeConfig(cfg);
        }
        if (
          msg.webSearchEngine !== undefined ||
          msg.webSearchEndpoint !== undefined ||
          msg.metasoApiKey !== undefined ||
          msg.baiduApiKey !== undefined ||
          msg.tavilyApiKey !== undefined ||
          msg.perplexityApiKey !== undefined ||
          msg.exaApiKey !== undefined ||
          msg.ollamaApiKey !== undefined ||
          msg.braveApiKey !== undefined
        ) {
          const cfg = readConfig();
          if (msg.webSearchEngine !== undefined) cfg.webSearchEngine = msg.webSearchEngine;
          if (msg.webSearchEndpoint !== undefined) {
            cfg.webSearchEndpoint = msg.webSearchEndpoint?.trim() || undefined;
          }
          if (msg.metasoApiKey !== undefined) {
            cfg.metasoApiKey = msg.metasoApiKey?.trim() || undefined;
          }
          if (msg.baiduApiKey !== undefined) {
            cfg.baiduApiKey = msg.baiduApiKey?.trim() || undefined;
          }
          if (msg.tavilyApiKey !== undefined) {
            cfg.tavilyApiKey = msg.tavilyApiKey?.trim() || undefined;
          }
          if (msg.perplexityApiKey !== undefined) {
            cfg.perplexityApiKey = msg.perplexityApiKey?.trim() || undefined;
          }
          if (msg.exaApiKey !== undefined) {
            cfg.exaApiKey = msg.exaApiKey?.trim() || undefined;
          }
          if (msg.ollamaApiKey !== undefined) {
            cfg.ollamaApiKey = msg.ollamaApiKey?.trim() || undefined;
          }
          if (msg.braveApiKey !== undefined) {
            cfg.braveApiKey = msg.braveApiKey?.trim() || undefined;
          }
          writeConfig(cfg);
        }
        if (msg.subagentModels !== undefined) {
          saveSubagentModels(msg.subagentModels);
          emitSkills(tab);
        }
        if (msg.model !== undefined) {
          const next = msg.model.trim();
          if (next) {
            tab.currentModel = next;
            saveModel(next);
            persistSessionModelPrefs(tab);
            if (tab.toolset) {
              tab.system = codeSystemPrompt(tab.rootDir, {
                hasSemanticSearch: tab.toolset.semantic.enabled,
                modelId: tab.currentModel,
              });
              syncVisionTool(tab);
              // Build even when the tab had no runtime (e.g. a gated welcome
              // tab that just picked an Ollama model) — only if the new model
              // is actually usable, else drop a stale runtime.
              if (tabCurrentModelUsable(tab)) tab.runtime = buildRuntimeFor(tab);
              else tab.runtime = null;
            }
          }
        }
        emitSettings(tab);
        emitTabGate(tab);
      } catch (err) {
        emit(
          { type: "$error", message: `settings_save failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "mention_query") {
      const nonce = msg.nonce;
      const query = msg.query;
      const parsed = parseAtQuery(query);
      // Empty query → list workspace root's top-level entries (tree
      // style). Without this, bare `@` floods with all 5000 files; the
      // TUI's @+Tab pattern already shows the tree top.
      const treeWalk = parsed.trailingSlash || query.length === 0;
      if (treeWalk) {
        void listDirectory(tab.rootDir, parsed.dir)
          .then((entries) => {
            const results = entries.map((e) => (e.isDir ? `${e.path}/` : e.path));
            emit({ type: "$mention_results", nonce, query, results }, tab.id);
          })
          .catch((err) => {
            emit(
              { type: "$error", message: `mention_query (dir) failed: ${(err as Error).message}` },
              tab.id,
            );
            emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
          });
        return;
      }
      const wantSymbols = query.length >= 2 && !query.includes("/");
      void (async () => {
        try {
          const files = await getFileIndexFor(tab);
          const fileResults = rankPickerCandidates(files, query, {
            limit: wantSymbols ? 19 : 25,
            recentlyUsed: tab.recentMentions,
          });
          let symResults: string[] = [];
          if (wantSymbols) {
            const syms = await getSymbolIndexFor(tab);
            symResults = rankSymbols(syms, query, 6);
          }
          emit(
            { type: "$mention_results", nonce, query, results: [...symResults, ...fileResults] },
            tab.id,
          );
        } catch (err) {
          emit(
            { type: "$error", message: `mention_query failed: ${(err as Error).message}` },
            tab.id,
          );
          emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
        }
      })();
      return;
    }
    if (msg.cmd === "mention_picked") {
      pushMentionRecent(tab, msg.path);
      return;
    }
    if (msg.cmd === "mention_preview") {
      const nonce = msg.nonce;
      const rel = msg.path;
      const abs = isAbsolute(rel) ? rel : join(tab.rootDir, rel);
      const safeAbs = resolve(abs);
      const safeRoot = resolve(tab.rootDir);
      if (!safeAbs.startsWith(safeRoot)) {
        emit({ type: "$mention_preview", nonce, path: rel, head: "", totalLines: 0 }, tab.id);
        return;
      }
      void readFile(safeAbs, "utf8")
        .then((text) => {
          const lines = text.split(/\r?\n/);
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const head = lines.slice(0, 12).join("\n");
          emit(
            { type: "$mention_preview", nonce, path: rel, head, totalLines: lines.length },
            tab.id,
          );
        })
        .catch(() => {
          emit({ type: "$mention_preview", nonce, path: rel, head: "", totalLines: 0 }, tab.id);
        });
      return;
    }
    if (msg.cmd === "compact_history") {
      if (!tab.runtime) return;
      // Folding while a turn is mid-flight races the tool dispatch: the fold's
      // wholesale log replacement can clobber a tool result that lands while
      // the summary call runs, orphaning it so the model never sees the read —
      // and the UI's "task complete" toast fires while the loop is still
      // working. Refuse while busy (same gate as prompt injection below).
      if (tab.aborter) {
        emit(
          {
            type: "$error",
            message: "Session is busy — wait for the current turn to finish before compacting.",
          },
          tab.id,
        );
        return;
      }
      // A cancelled turn's fold can still be running in the background even
      // though no turn is in flight (its summary is non-interruptible, and the
      // host closes the generator fire-and-forget). That fold owns the loop's
      // _compacting lock — starting a /compact now would overlap it and one of
      // the two finallys would prematurely release the shared lock mid-rewrite.
      // Refuse rather than race; the in-flight fold clears the lock itself.
      const rt = tab.runtime;
      if (rt.loop.isCompacting) {
        emit(
          {
            type: "$error",
            message:
              "A compaction is already running — wait for it to finish before compacting again.",
          },
          tab.id,
        );
        return;
      }
      // Compaction card lifecycle — routed through the SAME LoopEvent stream as
      // tool / reasoning / shell actions: the loop yields compaction_start →
      // compaction_end (plus session.compacted when the fold commits) and the
      // eventizer converts them, so user /compact renders the identical card
      // shape and records the identical kernel events as auto folds.
      void (async () => {
        try {
          for await (const ev of rt.loop.compactHistoryWithEvents()) {
            for (const kev of rt.eventizer.consume(ev, rt.ctx)) emitKernelEvent(kev, tab.id);
          }
          emitCtxBreakdown(tab);
        } catch (err) {
          emit({ type: "$error", message: `/compact failed: ${(err as Error).message}` }, tab.id);
        }
      })();
      return;
    }
    if (msg.cmd === "retry") {
      if (!tab.runtime) return;
      // Retry truncates the log outside the turn stream — record the
      // replacement in the kernel event log (session.retracted) so replaying
      // the events sidecar yields the truncated conversation, same as
      // session.compacted after a fold.
      const before = tab.runtime.loop.log.length;
      const prev = tab.runtime.loop.retryLastUser();
      if (prev) {
        emit({ type: "$retry_result", text: prev }, tab.id);
        emit(
          tab.runtime.eventizer.emitSessionRetracted(
            tab.runtime.loop.currentTurn,
            "retry",
            before,
            tab.runtime.loop.log.length,
            tab.runtime.loop.log.entries,
          ),
          tab.id,
        );
      }
      return;
    }

    if (msg.cmd === "btw") {
      if (!tab.runtime) return;
      const question = msg.text.trim();
      if (!question) return;
      void (async () => {
        try {
          const reply = await tab.runtime!.loop.client.chat({
            model: tab.currentModel,
            messages: [
              {
                role: "system",
                content:
                  "You are answering a side question that is unrelated to the current coding conversation. Answer concisely (1-3 sentences) in plain prose. Do not call tools, do not ask clarifying questions, and do not reference any prior turns.",
              },
              { role: "user", content: question },
            ],
          });
          const answer =
            (typeof reply.content === "string" ? reply.content.trim() : "") || "(no answer)";
          emit({ type: "$btw_result", question, answer }, tab.id);
        } catch (err) {
          emit({ type: "$error", message: `/btw failed: ${(err as Error).message}` }, tab.id);
        }
      })();
      return;
    }
    if (msg.cmd === "user_input") {
      if (!tab.runtime) {
        emit({ type: "$error", message: notConfiguredMessage(tab.currentModel) }, tab.id);
        return;
      }
      void (async () => {
        let text = msg.text;
        let attachments = msg.images ? [...msg.images] : [];
        // Vision-capable models accept image parts — auto-parse `@path`
        // mentions of local images into vision attachments so typing or
        // picking an image path just works. Other models never get image
        // parts (runTurn gates).
        if (modelAcceptsImages(tab.currentModel, ollamaVisionModelIds())) {
          const converted = await extractImageMentions(text, tab.rootDir);
          if (converted.attachments.length > 0) {
            text = converted.text;
            attachments = [...attachments, ...converted.attachments];
          }
        }
        let images: TurnImage[] | undefined;
        if (attachments.length > 0) {
          try {
            images = await resolveUserImages(attachments);
          } catch (err) {
            emit(
              { type: "$error", message: `Image attach failed: ${(err as Error).message}` },
              tab.id,
            );
            return;
          }
        }
        void runTurn(tab, text, images);
      })();
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      void gracefulShutdown();
      resolve();
    });
  });
}
