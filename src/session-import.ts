import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  type ExternalSessionApp,
  type ExternalSessionSource,
  clipText,
  flattenText,
} from "@reasonix/core-utils";
import { readJsonlLines } from "./core/jsonl.js";
import {
  SESSION_EVENTS_SUFFIX,
  type SessionMeta,
  detectGitBranch,
  loadSessionMeta,
  normalizeWorkspace,
  patchSessionMeta,
  rewriteSession,
  sessionPath,
  sessionsDir,
} from "./memory/session.js";
import { estimateRequestTokens } from "./tokenizer.js";
import type { ChatMessage, ToolCall } from "./types.js";

export type { ExternalSessionApp, ExternalSessionSource };

export interface ImportedSession {
  messages: ChatMessage[];
  workspace?: string;
  nameHint?: string;
  summary?: string;
  model?: SessionMeta["model"];
  reasoningEffort?: SessionMeta["reasoningEffort"];
  subagentModel?: SessionMeta["subagentModel"];
}

export interface ImportExternalSessionOptions {
  source: ExternalSessionSource;
  path: string;
  name?: string;
  workspace?: string;
  summary?: string;
  force?: boolean;
}

export interface ImportExternalSessionResult {
  source: ExternalSessionSource;
  path: string;
  name: string;
  messageCount: number;
  workspace?: string;
  summary?: string;
  branch?: string;
}

export interface ImportExternalSessionsResult {
  imported: number;
  skipped: number;
  failed: number;
  latestName?: string;
}

interface ExternalSessionFile {
  source: ExternalSessionSource;
  path: string;
  mtimeMs: number;
}

interface ClaudeRecord {
  type?: unknown;
  isMeta?: unknown;
  cwd?: unknown;
  project?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

interface CodexRecord {
  type?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    cwd?: unknown;
    message?: unknown;
    content?: unknown;
  };
}

interface SessionImportSourceDefinition {
  label: string;
  root: () => string;
  parse: (path: string) => ImportedSession;
}

const SESSION_IMPORT_SOURCES: Record<ExternalSessionSource, SessionImportSourceDefinition> = {
  claude: {
    label: "Claude Code",
    root: () => join(homedir(), ".claude", "projects"),
    parse: parseClaudeSessionFile,
  },
  codex: {
    label: "Codex",
    root: () => join(homedir(), ".codex", "sessions"),
    parse: parseCodexSessionFile,
  },
  reasonix: {
    label: "Reasonix",
    root: sessionsDir,
    parse: parseReasonixSessionFile,
  },
};

export function parseExternalSessionFile(
  source: ExternalSessionSource,
  path: string,
): ImportedSession {
  if (!existsSync(path)) {
    throw new Error(`source file not found: ${path}`);
  }
  return SESSION_IMPORT_SOURCES[source].parse(path);
}

export function buildImportedSessionName(
  source: ExternalSessionSource,
  path: string,
  imported: ImportedSession,
): string {
  const stem = basename(path, extname(path));
  const hint = oneLine(imported.nameHint || imported.summary || stem, 48);
  return `${source}-${hint || stem || "session"}`;
}

export function importExternalSession(
  opts: ImportExternalSessionOptions,
): ImportExternalSessionResult {
  const imported = parseExternalSessionFile(opts.source, opts.path);
  if (imported.messages.length === 0) {
    throw new Error(`no importable chat messages found in ${opts.path}`);
  }

  const requestedName =
    opts.name?.trim() || buildImportedSessionName(opts.source, opts.path, imported);
  const name =
    opts.source === "reasonix" && !opts.force ? availableSessionName(requestedName) : requestedName;
  const outputPath = sessionPath(name);
  if (existsSync(outputPath) && !opts.force) {
    throw new Error(`target session already exists: ${name}`);
  }

  rewriteSession(name, imported.messages);

  const workspace = opts.workspace?.trim() || imported.workspace;
  const summary = opts.summary?.trim() || imported.summary;
  const branch = workspace ? detectGitBranch(workspace) : undefined;
  patchSessionMeta(name, {
    workspace,
    summary,
    branch,
    model: imported.model,
    reasoningEffort: imported.reasoningEffort,
    subagentModel: imported.subagentModel,
    importedSource: opts.source,
    importedPath: opts.path,
  });

  return {
    source: opts.source,
    path: opts.path,
    name,
    messageCount: imported.messages.length,
    workspace,
    summary,
    branch,
  };
}

export function discoverExternalSessionApps(workspace?: string): ExternalSessionApp[] {
  return (Object.keys(SESSION_IMPORT_SOURCES) as ExternalSessionSource[]).map((source) => {
    const definition = SESSION_IMPORT_SOURCES[source];
    const root = definition.root();
    const files = scanExternalSessionFiles(source, workspace);
    const latest = files[0];
    return {
      source,
      label: definition.label,
      root,
      available: files.length > 0,
      sessionCount: files.length,
      latestMtime: latest ? new Date(latest.mtimeMs).toISOString() : undefined,
    };
  });
}

export function importExternalSessions(opts: {
  sources: ExternalSessionSource[];
  workspace?: string;
}): ImportExternalSessionsResult {
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let latestName: string | undefined;

  const existing = importedPathKeys();
  for (const source of opts.sources) {
    const files = scanExternalSessionFiles(source, opts.workspace);
    for (const file of files) {
      const key = importKey(source, file.path);
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      try {
        const result = importExternalSession({
          source,
          path: file.path,
          workspace: opts.workspace,
        });
        existing.add(key);
        imported++;
        latestName ||= result.name;
      } catch {
        failed++;
      }
    }
  }

  return { imported, skipped, failed, latestName };
}

function defaultSessionRoot(source: ExternalSessionSource): string {
  return SESSION_IMPORT_SOURCES[source].root();
}

function scanExternalSessionFiles(
  source: ExternalSessionSource,
  destinationWorkspace?: string,
): ExternalSessionFile[] {
  const root = defaultSessionRoot(source);
  const out: ExternalSessionFile[] = [];
  collectJsonl(root, source, out);
  const destination = normalizeWorkspace(destinationWorkspace);
  const filtered =
    source === "reasonix" && destination
      ? out.filter((file) => {
          const meta = readReasonixSessionMeta(file.path);
          return !!meta.workspace && normalizeWorkspace(meta.workspace) !== destination;
        })
      : out;
  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return filtered;
}

function collectJsonl(
  dir: string,
  source: ExternalSessionSource,
  out: ExternalSessionFile[],
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectJsonl(path, source, out);
    } else if (
      stat.isFile() &&
      entry.endsWith(".jsonl") &&
      !(source === "reasonix" && entry.endsWith(SESSION_EVENTS_SUFFIX))
    ) {
      out.push({ source, path, mtimeMs: stat.mtimeMs });
    }
  }
}

function importedPathKeys(): Set<string> {
  const out = new Set<string>();
  const dir = sessionsDir();
  if (!existsSync(dir)) return out;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith(".jsonl") || file.endsWith(SESSION_EVENTS_SUFFIX)) continue;
    const name = file.replace(/\.jsonl$/, "");
    const meta = loadSessionMeta(name);
    if (meta.importedSource && meta.importedPath) {
      out.add(importKey(meta.importedSource, meta.importedPath));
    }
  }
  return out;
}

function importKey(source: ExternalSessionSource, path: string): string {
  return `${source}:${path}`;
}

function parseReasonixSessionFile(path: string): ImportedSession {
  const meta = readReasonixSessionMeta(path, true);
  if (!meta.workspace?.trim()) {
    throw new Error(`Reasonix session metadata is missing a workspace: ${path}`);
  }
  const records = readJsonlLines(path);
  if (records.length === 0) {
    throw new Error(`Reasonix session contains no readable messages: ${path}`);
  }
  if (!records.every(isChatMessage)) {
    throw new Error(`Reasonix session contains an invalid chat message: ${path}`);
  }
  const textOnlyMessages = records.flatMap(toTextOnlyMessage);
  if (textOnlyMessages.length === 0) {
    throw new Error(`Reasonix session contains no importable conversation text: ${path}`);
  }
  textOnlyMessages.push({
    role: "user",
    content:
      "Continue from here using the imported conversation as context. Do not repeat work already completed.",
  });
  const messages = enforceReasonixImportTokenLimit(textOnlyMessages);
  return {
    messages,
    workspace: meta.workspace,
    nameHint: meta.summary || basename(path, extname(path)),
    summary: meta.summary,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    subagentModel: meta.subagentModel,
  };
}

function readReasonixSessionMeta(path: string, required = false): SessionMeta {
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  if (metaPath === path || !existsSync(metaPath)) {
    if (required) throw new Error(`Reasonix session metadata not found: ${metaPath}`);
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    if (required) {
      throw new Error(`Reasonix session metadata is invalid: ${metaPath}`, { cause: error });
    }
    return {};
  }
  if (!value || typeof value !== "object") {
    if (required) throw new Error(`Reasonix session metadata is invalid: ${metaPath}`);
    return {};
  }
  return value as SessionMeta;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function toTextOnlyMessage(message: ChatMessage): ChatMessage[] {
  if (message.role === "tool") return [];
  const content = textContent(message.content);
  if (message.role !== "assistant") {
    return content ? [{ role: message.role, content }] : [];
  }

  const reasoning = message.reasoning_content?.trim() || "";
  if (!reasoning) return content ? [{ role: "assistant", content }] : [];

  const sections = [`Prior reasoning/work context:\n${reasoning}`];
  if (content) sections.push(`Assistant response:\n${content}`);
  return [{ role: "assistant", content: sections.join("\n\n") }];
}

function textContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
    .join("\n\n");
}

export const REASONIX_IMPORT_MAX_TOKENS = 30_000;

const IMPORT_TRUNCATION_NOTICE: ChatMessage = {
  role: "user",
  content:
    "Import notice: older conversation messages were truncated to keep the imported context within 30,000 tokens. Continue from the remaining recent context and do not assume omitted details are still available.",
};

export function enforceReasonixImportTokenLimit(messages: ChatMessage[]): ChatMessage[] {
  if (estimateRequestTokens(messages) <= REASONIX_IMPORT_MAX_TOKENS) return messages;

  const kept: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = [IMPORT_TRUNCATION_NOTICE, messages[index]!, ...kept];
    if (estimateRequestTokens(candidate) > REASONIX_IMPORT_MAX_TOKENS) break;
    kept.unshift(messages[index]!);
  }
  const result = [IMPORT_TRUNCATION_NOTICE, ...kept];
  const finalTokens = estimateRequestTokens(result);
  if (finalTokens > REASONIX_IMPORT_MAX_TOKENS) {
    throw new Error(
      `Reasonix import token limit invariant failed: ${finalTokens} > ${REASONIX_IMPORT_MAX_TOKENS}`,
    );
  }
  return result;
}

function availableSessionName(base: string): string {
  if (!existsSync(sessionPath(base))) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(sessionPath(candidate))) return candidate;
  }
  throw new Error(`could not allocate a unique imported session name for: ${base}`);
}

function parseClaudeSessionFile(path: string): ImportedSession {
  const records = readJsonlLines(path) as ClaudeRecord[];
  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let workspace: string | undefined;
  let firstUserText: string | undefined;

  for (const record of records) {
    if (!workspace) workspace = firstString(record.cwd) || firstString(record.project);
    if (record.isMeta === true) continue;
    if (!record.message || typeof record.message !== "object") continue;
    const role = normalizeRole(record.message.role);
    if (!role) continue;

    if (role === "assistant") {
      const assistant = normalizeClaudeAssistant(record.message.content);
      for (const call of assistant.toolCalls) {
        if (call.id && call.function?.name) toolNames.set(call.id, call.function.name);
      }
      if (assistant.content || assistant.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: assistant.content || null,
          tool_calls: assistant.toolCalls.length > 0 ? assistant.toolCalls : undefined,
          reasoning_content: assistant.reasoning || undefined,
        });
      }
      continue;
    }

    const user = normalizeClaudeUser(record.message.content, toolNames);
    if (user.content) {
      messages.push({ role: "user", content: user.content });
      if (!firstUserText) firstUserText = user.content;
    }
    messages.push(...user.toolMessages);
  }

  return {
    messages,
    workspace,
    nameHint: firstUserText,
    summary: summarize(firstUserText),
  };
}

function parseCodexSessionFile(path: string): ImportedSession {
  const records = readJsonlLines(path) as CodexRecord[];
  const messages: ChatMessage[] = [];
  const fallback: ChatMessage[] = [];
  let workspace: string | undefined;
  let firstUserText: string | undefined;

  for (const record of records) {
    if (record.type === "session_meta" || record.type === "turn_context") {
      workspace ||= firstString(record.payload?.cwd);
    }

    if (record.type === "response_item" && record.payload?.type === "message") {
      const role = normalizeRole(record.payload.role);
      if (!role) continue;
      const content = normalizeCodexMessageContent(role, record.payload.content);
      if (!content) continue;
      messages.push({ role, content });
      if (role === "user" && !firstUserText) firstUserText = content;
      continue;
    }

    if (record.type === "event_msg") {
      const eventType = firstString(record.payload?.type);
      const content = firstString(record.payload?.message);
      if (!content) continue;
      if (eventType === "user_message") {
        fallback.push({ role: "user", content });
        if (!firstUserText) firstUserText = content;
      } else if (eventType === "agent_message") {
        fallback.push({ role: "assistant", content });
      }
    }
  }

  const importedMessages = messages.length > 0 ? messages : dedupeAdjacentMessages(fallback);
  return {
    messages: importedMessages,
    workspace,
    nameHint: firstUserText,
    summary: summarize(firstUserText),
  };
}

function normalizeClaudeAssistant(content: unknown): {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
} {
  if (typeof content === "string") {
    return { content: content.trim(), toolCalls: [] };
  }
  if (!Array.isArray(content)) {
    return { content: "", toolCalls: [] };
  }

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoningParts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = firstString((item as Record<string, unknown>).type);
    if (type === "text") {
      const text = firstString((item as Record<string, unknown>).text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === "thinking") {
      const text = firstString((item as Record<string, unknown>).thinking);
      if (text) reasoningParts.push(text);
      continue;
    }
    if (type === "tool_use") {
      const name = firstString((item as Record<string, unknown>).name);
      if (!name) continue;
      toolCalls.push({
        id: firstString((item as Record<string, unknown>).id),
        type: "function",
        function: {
          name,
          arguments: safeJson((item as Record<string, unknown>).input ?? {}),
        },
      });
    }
  }

  return {
    content: joinParts(textParts),
    toolCalls,
    reasoning: joinParts(reasoningParts) || undefined,
  };
}

function normalizeClaudeUser(
  content: unknown,
  toolNames: ReadonlyMap<string, string>,
): { content: string; toolMessages: ChatMessage[] } {
  if (typeof content === "string") {
    return { content: content.trim(), toolMessages: [] };
  }
  if (!Array.isArray(content)) {
    return { content: "", toolMessages: [] };
  }

  const userText: string[] = [];
  const toolMessages: ChatMessage[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = firstString((item as Record<string, unknown>).type);
    if (type === "text") {
      const text = firstString((item as Record<string, unknown>).text);
      if (text) userText.push(text);
      continue;
    }
    if (type === "image") {
      userText.push("[image omitted]");
      continue;
    }
    if (type === "tool_result") {
      const callId = firstString((item as Record<string, unknown>).tool_use_id);
      toolMessages.push({
        role: "tool",
        content: normalizeArbitraryContent((item as Record<string, unknown>).content),
        tool_call_id: callId,
        name: callId ? toolNames.get(callId) : undefined,
      });
    }
  }

  return { content: joinParts(userText), toolMessages };
}

function normalizeCodexMessageContent(role: "user" | "assistant", content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = firstString((item as Record<string, unknown>).type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = firstString((item as Record<string, unknown>).text);
      if (!text) continue;
      if (role === "user" && looksLikeCodexBootstrapBlock(text)) continue;
      textParts.push(text);
    }
  }
  return joinParts(textParts);
}

function looksLikeCodexBootstrapBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>")
  );
}

function dedupeAdjacentMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    out.push(msg);
  }
  return out;
}

function normalizeArbitraryContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const textParts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return firstString((item as Record<string, unknown>).text);
        }
        return "";
      })
      .filter(Boolean) as string[];
    if (textParts.length > 0) return joinParts(textParts);
  }
  return safeJson(value);
}

function normalizeRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function joinParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function summarize(text: string | undefined): string | undefined {
  const flat = oneLine(text || "", 120);
  return flat || undefined;
}

function oneLine(text: string, max: number): string {
  return clipText(flattenText(text), max, "...");
}
