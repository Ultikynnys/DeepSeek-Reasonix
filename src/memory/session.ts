/** Folder-per-session storage under `~/.reasonix/sessions/<name>/` — minting is lazy, listings skip empty folders, legacy flat sessions migrate on boot. */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix as posixPath, win32 as win32Path } from "node:path";
import { DAY_MS, messageOf, sortSessionsDescending } from "@reasonix/core-utils";
import { type ReasoningEffort, isReasoningEffort } from "../config.js";
import { atomicWriteSync, tmpSiblingPath } from "../core/atomic-write.js";
import { readJsonFileSilently } from "../core/json-file.js";
import { appendJsonlLine, parseJsonl } from "../core/jsonl.js";
import { SessionDirectoryIndex } from "../desktop/session-directory-index.js";
import { reasonixHome } from "../reasonix-home.js";
import type { CacheDiagnosticEntry } from "../telemetry/cache-diagnostics.js";
import type { SessionProviderCost } from "../telemetry/stats.js";
import type { ChatMessage } from "../types.js";
import {
  SESSION_MESSAGES_FILENAME,
  sanitizeName,
  sessionDir,
  sessionEventsPath,
  sessionMessagesPath,
  sessionMetaPath,
  sessionPlanPath,
  sessionsDir,
} from "./session-layout.js";

export {
  parseSessionTimestamp,
  sessionRecency,
  sortSessionsDescending,
} from "@reasonix/core-utils";
export {
  SESSION_META_FILENAME,
  SESSION_MESSAGES_FILENAME,
  SESSION_PLAN_FILENAME,
  SESSION_PLANS_DIRNAME,
  sanitizeName,
  sessionDir,
  sessionEventsPath,
  sessionMessagesPath,
  sessionMetaPath,
  sessionPlanPath,
  sessionPlansDir,
  sessionsDir,
} from "./session-layout.js";

/** Sidecar suffixes from the pre-folder flat layout — consumed by the migration, never written anymore. */
const LEGACY_SIDECAR_SUFFIXES = [
  ".meta.json",
  ".events.jsonl",
  ".pending.json",
  ".plan.json",
  ".jsonl.bak",
] as const;

/** Best-effort git branch sniff; returns undefined if not a git repo or git missing. */
export function detectGitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 800,
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export interface SessionInfo {
  name: string;
  path: string;
  size: number;
  messageCount: number;
  mtime: Date;
  meta: SessionMeta;
  /** Explicit last-activity stamp (meta.updatedAt) — copy-safe sort key that
   *  beats a stale filesystem mtime. Undefined when the meta predates it. */
  lastActive?: number;
  /** How this item matched a workspace-scoped list. */
  workspaceStatus?: "matched" | "legacy_missing_meta";
}

export interface SessionMeta {
  branch?: string;
  summary?: string;
  /** Epoch-ms timestamp of the last user-visible activity — written on every
   *  message append and meta patch. Drives the sidebar sort so ordering
   *  survives file copies/restores that would reset the filesystem mtime. */
  updatedAt?: number;
  totalCostUsd?: number;
  turnCount?: number;
  /** Absolute path of the workspace root the session was created/used in. */
  workspace?: string;
  /** Wallet currency at last save — used to format `totalCostUsd` in the picker without re-fetching balance. */
  balanceCurrency?: string;
  /** Per-provider cumulative costs in each provider's native unit (USD for
   *  token-priced APIs, plan-window % for quota APIs). Never converted between
   *  providers. Keyed by provider id ("deepseek" | "openai" | "ollama" | "gemini"). */
  costByProvider?: Record<string, SessionProviderCost>;
  /** Cumulative cache hit / miss tokens across the session — survives resume so /status cache% isn't 0 on a fresh boot. */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  /** Cumulative completion (output) tokens across the session. */
  totalCompletionTokens?: number;
  /** Last turn's promptTokens — lets /status render the context bar before the next turn fires. */
  lastPromptTokens?: number;
  /** Recent per-turn cache evidence. Backward-compatible: absent on sessions created before cache diagnostics. */
  cacheDiagnostics?: CacheDiagnosticEntry[];
  /** True when the session filename/summary was generated from conversation content. */
  autoTitleGenerated?: boolean;
  /** Model the conversation last ran with — restored on resume so a reinstall / config reset doesn't silently switch an ongoing conversation's model. Only the desktop UI's model enum writes this. */
  model?: string;
  /** Reasoning effort the conversation last ran with — same resume semantics as `model`. */
  reasoningEffort?: ReasoningEffort;
  /** Per-tab subagent model the conversation last ran with — same resume semantics as `model`. Only the desktop UI's subagent selector writes this. */
  subagentModel?: string;
}

/** `sessionPath` keeps its historical name and now points at the chat transcript
 *  inside the session folder: `~/.reasonix/sessions/<name>/messages.jsonl`. */
export function sessionPath(name: string): string {
  return sessionMessagesPath(name);
}

/** Sortable timestamp `YYYYMMDDHHmm` (12 digits; 14 = seconds precision) — used as a session-name suffix. */
export function timestampSuffix(length = 12): string {
  return new Date().toISOString().replace(/[^\d]/g, "").slice(0, length);
}

/** Unique name for an in-app "new session" — strips a trailing 12/14-digit timestamp from the current name and re-stamps with seconds precision so back-to-back clicks don't collide. */
export function freshSessionName(currentName: string | undefined): string {
  const base = currentName ? currentName.replace(/-\d{12,14}$/, "") : "default";
  return `${base || "default"}-${timestampSuffix(14)}`;
}

/** First free session name for `base`: a repeated seconds-precision timestamp takes a `-1`, `-2`, … suffix instead of truncating an occupied session. */
export function firstFreeSessionName(base: string, occupied: (name: string) => boolean): string {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt - 1}`;
    if (!occupied(candidate)) return candidate;
  }
  return `${base}-10`;
}

/** Session names starting with `prefix`, newest-first by folder name. Archive
 *  folders (`__archive_`) are excluded; empty sessions count — resume prefers
 *  the newest conversation whether or not it has messages yet. */
export function findSessionsByPrefix(prefix: string): string[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          e.name.startsWith(prefix) &&
          !e.name.includes("__archive_") &&
          // Must at least have a transcript file (empty is fine); a folder
          // holding only sidecars was never minted and can't be resumed.
          existsSync(join(dir, e.name, SESSION_MESSAGES_FILENAME)),
      )
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export interface SessionPreview {
  messageCount: number;
  lastActive: Date;
}

/** Resolve launch-time session: forceNew → timestamped suffix; else latest `${name}-*` if any, else base. Preview returned only on the default branch when messages exist. */
export function resolveSession(
  sessionName: string | undefined,
  forceNew?: boolean,
  forceResume?: boolean,
): { resolved: string | undefined; preview: SessionPreview | undefined } {
  let resolved = sessionName;
  let preview: SessionPreview | undefined;

  if (sessionName && forceNew) {
    resolved = `${sessionName}-${timestampSuffix()}`;
  } else if (sessionName && !forceResume) {
    let sessionToCheck = sessionName;
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      sessionToCheck = prefixed[0]!;
    }
    const prior = loadSessionMessages(sessionToCheck);
    if (prior.length > 0) {
      resolved = sessionToCheck;
      const p = sessionPath(sessionToCheck);
      const mtime = existsSync(p) ? statSync(p).mtime : new Date();
      preview = { messageCount: prior.length, lastActive: mtime };
    }
  } else if (sessionName && forceResume) {
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      resolved = prefixed[0]!;
    }
  }

  return { resolved, preview };
}

function isChatMessage(msg: unknown): msg is ChatMessage {
  return !!msg && typeof msg === "object" && "role" in msg;
}

function parseSessionMessages(raw: string): { messages: ChatMessage[]; hadContent: boolean } {
  return { messages: parseJsonl(raw, isChatMessage), hadContent: raw.trim().length > 0 };
}

function readSessionMessages(
  path: string,
): { messages: ChatMessage[]; hadContent: boolean } | null {
  try {
    return parseSessionMessages(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Session transcript path with legacy-flat fallback: new folders store it as
 *  `messages.jsonl`; the migration keeps pre-refactor layouts readable until
 *  it runs. */
function messagesPathForRead(name: string): string {
  const p = sessionPath(name);
  if (existsSync(p)) return p;
  const legacy = legacyFlatJsonlPath(name);
  return existsSync(legacy) ? legacy : p;
}

/** Best-effort private perms on session files — no-op where chmod is unsupported. */
export function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    void 0; /* chmod not supported */
  }
}

export function loadSessionMessages(name: string): ChatMessage[] {
  const path = messagesPathForRead(name);
  if (!existsSync(path)) return [];
  const live = readSessionMessages(path);
  if (live && (live.messages.length > 0 || !live.hadContent)) return live.messages;

  const backup = readSessionMessages(sessionBackupPath(path));
  return backup?.messages ?? live?.messages ?? [];
}

/** Async variant of `loadSessionMessages` — used at launch so a multi-tab
 *  restore can read every session's jsonl concurrently instead of blocking
 *  the event loop one file at a time. */
export async function loadSessionMessagesAsync(name: string): Promise<ChatMessage[]> {
  const path = messagesPathForRead(name);
  if (!existsSync(path)) return [];
  const live = await readSessionMessagesAsync(path);
  if (live && (live.messages.length > 0 || !live.hadContent)) return live.messages;

  const backup = await readSessionMessagesAsync(sessionBackupPath(path));
  return backup?.messages ?? live?.messages ?? [];
}

async function readSessionMessagesAsync(
  path: string,
): Promise<{ messages: ChatMessage[]; hadContent: boolean } | null> {
  try {
    return parseSessionMessages(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Materialize the session folder + an (empty) transcript. Minting calls this
 *  immediately: an empty session is a REAL session — it lists like any other
 *  and nothing implicitly destroys it. */
export function ensureSessionDir(name: string): string {
  const dir = sessionDir(name);
  mkdirSync(dir, { recursive: true });
  const messages = sessionMessagesPath(name);
  if (!existsSync(messages)) {
    writeFileSync(messages, "", { flag: "w" });
    chmodPrivate(messages);
  }
  return dir;
}

export function appendSessionMessage(name: string, message: ChatMessage): void {
  const path = sessionPath(name);
  ensureSessionDir(name);
  appendJsonlLine(path, message);
  chmodPrivate(path);
  touchSessionUpdatedAt(name);
  sessionDirectoryIndex.invalidate();
}

/** Stamp `meta.updatedAt` on every append so the sidebar has an explicit, copy-safe "last activity" timestamp (falls back to mtime on failure). */
function touchSessionUpdatedAt(name: string): void {
  try {
    const p = sessionMetaPath(name);
    const cur = readJsonFileSilently(p, (v): v is SessionMeta => !!v && typeof v === "object");
    const next: SessionMeta = { ...(cur ?? {}), updatedAt: Date.now() };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next), "utf8");
    chmodPrivate(p);
  } catch {
    void 0; /* best-effort — mtime fallback keeps sorting correct */
  }
}

/** A session EXISTS iff its folder exists — empty transcripts are real
 *  sessions (a fresh "New chat" has zero messages but must list and survive).
 *  Only stray files that are not session folders at all are invisible. */
export function sessionExists(name: string): boolean {
  return existsSync(sessionDir(name)) || existsSync(legacyFlatJsonlPath(name));
}

/** Enumerate session folders — every session folder lists, empty or not. */
function listSessionDirs(): Array<{ name: string; dir: string }> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => ({ name: e.name, dir: join(dir, e.name) }));
  } catch {
    return [];
  }
}

export function listSessions(opts?: {
  workspaceFilter?: string;
  includeLegacyWorkspaceMatches?: boolean;
}): SessionInfo[] {
  const want = opts?.workspaceFilter ? normalizeWorkspace(opts.workspaceFilter) : null;
  const legacyPrefix =
    want && opts?.includeLegacyWorkspaceMatches
      ? legacySessionPrefixForWorkspace(opts.workspaceFilter!)
      : null;
  return listSessionDirs()
    .flatMap(({ name, dir }) => {
      const meta = loadSessionMeta(name);
      // Workspace pre-filter: cheap meta read first, skip the
      // (potentially multi-MB) jsonl read for sessions that don't
      // belong to the current workspace. Issue #1179.
      let workspaceStatus: SessionInfo["workspaceStatus"] | undefined;
      if (want !== null) {
        if (typeof meta.workspace === "string") {
          if (normalizeWorkspace(meta.workspace) !== want) return [];
          workspaceStatus = "matched";
        } else if (legacyPrefix && name.startsWith(legacyPrefix)) {
          workspaceStatus = "legacy_missing_meta";
        } else {
          return [];
        }
      }
      const path = messagesPathForRead(name);
      // A session folder always carries messages.jsonl when minted through
      // ensureSessionDir, but tolerate hand-made folders without one.
      let size = 0;
      let mtime = new Date(0);
      try {
        const stat = statSync(path);
        size = stat.size;
        mtime = stat.mtime;
      } catch {
        void 0; /* no transcript file — still a (zero-message) session */
      }
      const messageCount = countLines(path);
      return [
        {
          name,
          path: dir,
          size,
          messageCount,
          mtime,
          lastActive: meta.updatedAt,
          meta,
          workspaceStatus,
        },
      ];
    })
    .sort(sortSessionsDescending);
}

/** Canonical form for workspace path comparisons — Windows drive-case + separator drift between session writes (yesterday) and reads (today) used to hide sessions from the sidebar. Issue #878. */
export function normalizeWorkspace(
  p: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof p !== "string" || p.length === 0) return "";
  if (platform === "win32") {
    const resolved = win32Path.resolve(p);
    return resolved
      .replace(/\\/g, "/")
      .replace(/^([A-Z]):/i, (_, d: string) => `${d.toLowerCase()}:`);
  }
  return posixPath.resolve(p);
}

export function listSessionsForWorkspace(workspace: string): SessionInfo[] {
  return listSessions({ workspaceFilter: workspace, includeLegacyWorkspaceMatches: true });
}

const sessionDirectoryIndex = new SessionDirectoryIndex<SessionMeta>(
  sessionsDir,
  loadSessionMeta,
  undefined,
  undefined,
  undefined,
  join(reasonixHome(), "cache", "session-directory-index.json"),
);

export function listSessionsForWorkspaceAsync(workspace: string): {
  value: Promise<SessionInfo[]>;
  cache: "hit" | "refresh" | "inflight";
} {
  const request = sessionDirectoryIndex.load();
  const want = normalizeWorkspace(workspace);
  const legacyPrefix = legacySessionPrefixForWorkspace(workspace);
  return {
    cache: request.cache,
    value: request.value.then((records) =>
      records
        .flatMap((record): SessionInfo[] => {
          let workspaceStatus: SessionInfo["workspaceStatus"];
          if (typeof record.meta.workspace === "string") {
            if (normalizeWorkspace(record.meta.workspace) !== want) return [];
            workspaceStatus = "matched";
          } else if (record.name.startsWith(legacyPrefix)) {
            workspaceStatus = "legacy_missing_meta";
          } else {
            return [];
          }
          return [
            {
              name: record.name,
              path: sessionDir(record.name),
              size: record.identity.size,
              messageCount: record.messageCount,
              mtime: record.mtime,
              lastActive: record.meta.updatedAt,
              meta: record.meta,
              workspaceStatus,
            },
          ];
        })
        .sort(sortSessionsDescending),
    ),
  };
}

export function legacySessionPrefixForWorkspace(workspace: string): string {
  const normalized = normalizeWorkspace(workspace);
  const base =
    process.platform === "win32" ? win32Path.basename(normalized) : posixPath.basename(normalized);
  return `${sanitizeName(`code-${base}`)}-`;
}

export function patchSessionWorkspaceIfMissing(name: string, workspace: string): boolean {
  const meta = loadSessionMeta(name);
  if (typeof meta.workspace === "string") return false;
  const prefix = legacySessionPrefixForWorkspace(workspace);
  if (!sanitizeName(name).startsWith(prefix)) return false;
  patchSessionMeta(name, { workspace });
  return true;
}

export function loadSessionMeta(name: string): SessionMeta {
  const p = sessionMetaPath(name);
  const fresh = readJsonFileSilently(p, (v): v is SessionMeta => !!v && typeof v === "object");
  if (fresh) return fresh;
  const legacy = readJsonFileSilently(
    legacyFlatMetaPath(name),
    (v): v is SessionMeta => !!v && typeof v === "object",
  );
  return legacy ?? {};
}

export function patchSessionMeta(name: string, patch: Partial<SessionMeta>): SessionMeta {
  const cur = loadSessionMeta(name);
  // patchSessionMeta calls are user-visible activity (rename, model change,
  // cost accumulation) — keep the explicit activity stamp current.
  const next: SessionMeta = { ...cur, ...patch, updatedAt: Date.now() };
  const p = sessionMetaPath(name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next), "utf8");
  chmodPrivate(p);
  sessionDirectoryIndex.invalidate();
  return next;
}

export interface ModelPrefs {
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Explicit per-tab subagent model override. `undefined` = subagents follow
   *  the main agent's model. */
  subagentModel?: string;
}

/** Pick the conversation's stored model/effort/subagent-model triple, validated
 *  against the stored types; anything missing or malformed falls back to the
 *  caller's current defaults. Kept pure so desktop restore logic is testable. */
export function resolveSessionModelPrefs(meta: SessionMeta, fallback: ModelPrefs): ModelPrefs {
  return {
    model: typeof meta.model === "string" && meta.model.trim() ? meta.model.trim() : fallback.model,
    reasoningEffort: isReasoningEffort(meta.reasoningEffort)
      ? meta.reasoningEffort
      : fallback.reasoningEffort,
    subagentModel:
      typeof meta.subagentModel === "string" && meta.subagentModel.trim()
        ? meta.subagentModel.trim()
        : fallback.subagentModel,
  };
}

/** Renames the session folder; returns false if target already exists. */
export function renameSession(oldName: string, newName: string): boolean {
  const safeOld = sanitizeName(oldName);
  const safeNew = sanitizeName(newName);
  if (safeOld === safeNew) return false;
  const oldDir = sessionDir(oldName);
  const newDir = sessionDir(newName);
  // A legacy flat jsonl with no folder yet is renameable too.
  const legacyOld = legacyFlatJsonlPath(oldName);
  const source = existsSync(oldDir) ? oldDir : existsSync(legacyOld) ? null : undefined;
  if (source === undefined) return false;
  if (existsSync(newDir)) return false;
  try {
    if (source === null) {
      // Legacy flat: create the target folder and move the transcript in.
      ensureSessionDir(newName);
      renameSync(legacyOld, sessionPath(newName));
      for (const ext of LEGACY_SIDECAR_SUFFIXES) {
        const oldP = legacyFlatJsonlPath(oldName).replace(/\.jsonl$/, ext);
        if (existsSync(oldP)) {
          try {
            renameSync(oldP, legacyTargetForSidecar(newName, ext));
          } catch (err) {
            process.stderr.write(`reasonix: session sidecar rename failed — ${messageOf(err)}\n`);
          }
        }
      }
    } else {
      renameSync(oldDir, newDir);
    }
  } catch (err) {
    process.stderr.write(`reasonix: session rename failed — ${messageOf(err)}\n`);
    return false;
  }
  sessionDirectoryIndex.invalidate();
  return true;
}

/** Map a legacy sidecar suffix onto its folder-layout destination. */
function legacyTargetForSidecar(name: string, ext: string): string {
  if (ext === ".meta.json") return sessionMetaPath(name);
  if (ext === ".events.jsonl") return sessionEventsPath(name);
  if (ext === ".plan.json") return sessionPlanPath(name);
  if (ext === ".jsonl.bak") return `${sessionPath(name)}.bak`;
  return join(sessionDir(name), `legacy${ext}`);
}

/** Best-effort: per-folder delete errors are swallowed so partial pruning still finishes. */
export function pruneStaleSessions(daysOld = 90): string[] {
  const cutoff = Date.now() - daysOld * DAY_MS;
  const deleted: string[] = [];
  for (const s of listSessions()) {
    if (s.mtime.getTime() < cutoff) {
      if (deleteSession(s.name)) deleted.push(s.name);
    }
  }
  return deleted;
}

/** Removes the session folder (and every file in it). Also cleans up a
 *  legacy flat jsonl + sidecars if no folder exists yet. */
export function deleteSession(name: string): boolean {
  const dir = sessionDir(name);
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      const legacy = legacyFlatJsonlPath(name);
      if (!existsSync(legacy)) return false;
      unlinkSync(legacy);
      for (const ext of LEGACY_SIDECAR_SUFFIXES) {
        try {
          unlinkSync(legacyFlatJsonlPath(name).replace(/\.jsonl$/, ext));
        } catch {
          void 0; /* expected when the sidecar doesn't exist */
        }
      }
    }
    sessionDirectoryIndex.remove(name);
    return true;
  } catch {
    return false;
  }
}

/** Crash-safe rewrite: snapshot the previous live log, write a sibling tmp file, then atomically swap it in. */
export function rewriteSession(name: string, messages: ChatMessage[]): void {
  const path = sessionPath(name);
  ensureSessionDir(name);
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  const tmp = tmpSiblingPath(path);
  if (existsSync(path) && statSync(path).size > 0) {
    const backup = sessionBackupPath(path);
    copyFileSync(path, backup);
    chmodPrivate(backup);
  }
  atomicWriteSync(path, body ? `${body}\n` : "", tmp);
  touchSessionUpdatedAt(name);
  sessionDirectoryIndex.invalidate();
}

/** Rotate the live session folder to `<name>__archive_<ts>` so /new doesn't destroy history. Returns the archive name, or null if there was nothing to archive. */
export function archiveSession(name: string): string | null {
  const livePath = messagesPathForRead(name);
  if (!existsSync(livePath)) return null;
  try {
    if (statSync(livePath).size === 0) return null;
  } catch {
    return null;
  }
  // Ensure everything lives in the folder before rotating it.
  migrateSingleLegacySession(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = `${name}__archive_${timestampSuffix()}${attempt > 0 ? `_${attempt}` : ""}`;
    if (renameSession(name, target)) return target;
  }
  return null;
}

/** Byte-scan for `\n` — avoids the UTF-8 decode + regex split + per-line filter the previous implementation paid on every list. ~10× faster on multi-MB jsonls. */
function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    // appendSessionMessage always writes a trailing newline, but a
    // hand-edited file may end without one — account for the dangling line.
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
    return count;
  } catch {
    return 0;
  }
}

function sessionBackupPath(path: string): string {
  return `${path}.bak`;
}

/** Pre-refactor transcript location: `~/.reasonix/sessions/<name>.jsonl`. */
function legacyFlatJsonlPath(name: string): string {
  return join(sessionsDir(), `${sanitizeName(name)}.jsonl`);
}

function legacyFlatMetaPath(name: string): string {
  return join(sessionsDir(), `${sanitizeName(name)}.meta.json`);
}

/** Move one legacy flat session (jsonl + sidecars) into its folder. Returns the folder when a migration happened. */
function migrateSingleLegacySession(name: string): string | null {
  const legacy = legacyFlatJsonlPath(name);
  if (!existsSync(legacy)) return null;
  const dir = ensureSessionDir(name);
  try {
    renameSync(legacy, sessionPath(name));
    for (const ext of LEGACY_SIDECAR_SUFFIXES) {
      const oldP = legacyFlatJsonlPath(name).replace(/\.jsonl$/, ext);
      if (existsSync(oldP)) {
        try {
          renameSync(oldP, legacyTargetForSidecar(name, ext));
        } catch (sidecarErr) {
          // leave the sidecar flat — harmless, deleteSession still cleans it
          process.stderr.write(
            `reasonix: legacy sidecar move skipped for "${name}${ext}" — ${messageOf(sidecarErr)}\n`,
          );
        }
      }
    }
    sessionDirectoryIndex.invalidate();
    return dir;
  } catch (err) {
    process.stderr.write(`reasonix: session migration failed for "${name}" — ${messageOf(err)}\n`);
    return null;
  }
}

/** One-time migration: move legacy flat `<name>.jsonl` + sidecars into
 *  `<name>/` folders (idempotent, one readdir). Empty legacy files migrate
 *  too — an empty session is a real session. */
export function migrateLegacyFlatSessions(): { migrated: string[]; prunedEmpty: string[] } {
  const dir = sessionsDir();
  const migrated: string[] = [];
  const prunedEmpty: string[] = [];
  if (!existsSync(dir)) return { migrated, prunedEmpty };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { migrated, prunedEmpty };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") || entry.includes("__archive_")) continue;
    if (entry.endsWith(".events.jsonl")) continue;
    const name = entry.slice(0, -".jsonl".length);
    if (migrateSingleLegacySession(name)) migrated.push(name);
  }
  return { migrated, prunedEmpty };
}
