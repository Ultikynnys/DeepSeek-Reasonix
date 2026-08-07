/** One file per checkpoint (not jsonl) so delete/restore is cheap and a corrupt snapshot only loses itself. */

import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { listFilesWithStatsSync } from "../at-mentions.js";
import { readJsonFileSilently } from "../core/json-file.js";
import { fmtRelativeTime } from "../core/relative-time.js";
import { reasonixHome } from "../reasonix-home.js";

/** One file's state at the time of snapshot. `content === null` → didn't exist. */
export interface CheckpointFile {
  path: string;
  content: string | null;
  /** mtime + size at snapshot time — incremental turn snapshots skip unchanged files. */
  mtimeMs?: number;
  size?: number;
  /** Set when content is base64-encoded binary (NUL-sniffed at snapshot). */
  encoding?: "base64";
}

export interface Checkpoint {
  id: string;
  /** User-given name, or `auto-<reason>` for system-created snapshots. */
  name: string;
  /** Absolute workspace root the snapshot belongs to. */
  rootDir: string;
  createdAt: number;
  source: "manual" | "auto-session-start" | "auto-pre-restore";
  files: CheckpointFile[];
  /** Total bytes of file content captured (sum of `content?.length`). */
  bytes: number;
}

export interface CheckpointMeta {
  id: string;
  name: string;
  createdAt: number;
  source: Checkpoint["source"];
  fileCount: number;
  bytes: number;
}

/** Sanitize a directory path into a safe filesystem name for the store. */
function sanitizeRoot(rootDir: string): string {
  return resolve(rootDir)
    .replace(/[\\/:]+/g, "_")
    .replace(/^_+/, "");
}

function storeRoot(rootDir: string): string {
  return join(reasonixHome(), "sessions", sanitizeRoot(rootDir), "checkpoints");
}

function indexPath(rootDir: string): string {
  return join(storeRoot(rootDir), "index.json");
}

function snapshotPath(rootDir: string, id: string): string {
  return join(storeRoot(rootDir), `${id}.json`);
}

/** Load the index of checkpoint metadata for a workspace. Empty when missing. */
export function listCheckpoints(rootDir: string): CheckpointMeta[] {
  const path = indexPath(rootDir);
  const parsed = readJsonFileSilently(path, (v): v is CheckpointMeta[] => Array.isArray(v));
  if (!parsed) return [];
  // Defensive: filter out malformed entries rather than throwing on
  // a single bad row. A stale entry is annoying; a thrown listCheckpoints
  // would break /checkpoint list entirely.
  return parsed.filter(
    (m): m is CheckpointMeta =>
      typeof m === "object" &&
      m !== null &&
      typeof m.id === "string" &&
      typeof m.name === "string" &&
      typeof m.createdAt === "number" &&
      typeof m.source === "string" &&
      typeof m.fileCount === "number" &&
      typeof m.bytes === "number",
  );
}

function writeIndex(rootDir: string, items: CheckpointMeta[]): void {
  const path = indexPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(items, null, 2), "utf8");
}

/** Read a single checkpoint by id. Returns null when missing or corrupt. */
export function loadCheckpoint(rootDir: string, id: string): Checkpoint | null {
  return readJsonFileSilently(
    snapshotPath(rootDir, id),
    (v): v is Checkpoint => !!v && typeof v === "object" && Array.isArray((v as Checkpoint).files),
  );
}

/** Fold `srcId` into `dstId` (dst wins on overlap — it's newer), then delete
 *  srcId. Evicted turn snapshots merge into the survivor so reconstruction
 *  stays self-sufficient. */
export function mergeCheckpointInto(rootDir: string, srcId: string, dstId: string): boolean {
  const src = loadCheckpoint(rootDir, srcId);
  const dst = loadCheckpoint(rootDir, dstId);
  if (!src || !dst) return false;
  const byPath = new Map<string, CheckpointFile>();
  for (const f of src.files) byPath.set(f.path, f);
  for (const f of dst.files) byPath.set(f.path, f);
  const files = [...byPath.values()];
  let bytes = 0;
  for (const f of files) bytes += f.content?.length ?? 0;
  writeFileSync(snapshotPath(rootDir, dstId), JSON.stringify({ ...dst, files, bytes }), "utf8");
  const items = listCheckpoints(rootDir);
  const next = items.map((m) => (m.id === dstId ? { ...m, fileCount: files.length, bytes } : m));
  if (next.length === items.length) writeIndex(rootDir, next);
  return deleteCheckpoint(rootDir, srcId);
}

export interface CreateCheckpointOptions {
  rootDir: string;
  name: string;
  source?: Checkpoint["source"];
  paths: readonly string[];
  /** Skip existing-but-unreadable files instead of recording null — restore would DELETE them. */
  skipUnreadable?: boolean;
}

/** Missing files recorded as `content: null` so restore knows to delete; ID has random suffix to avoid same-ms collision. */
export function createCheckpoint(opts: CreateCheckpointOptions): CheckpointMeta {
  const absRoot = resolve(opts.rootDir);
  const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const files: CheckpointFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const p of opts.paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const abs = resolve(absRoot, p);
    // Path-escape guard. A snapshot of `../../../etc/passwd` is not
    // something we want — refuse silently rather than abort the whole
    // checkpoint.
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) continue;
    const rel = relative(absRoot, abs).split(sep).join("/");
    if (!existsSync(abs)) {
      files.push({ path: rel, content: null });
      continue;
    }
    try {
      const st = statSync(abs);
      const buf = readFileSync(abs);
      if (buf.includes(0)) {
        // Binary — store base64 so restore round-trips exact bytes.
        files.push({
          path: rel,
          content: buf.toString("base64"),
          encoding: "base64",
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } else {
        files.push({
          path: rel,
          content: buf.toString("utf8"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
      bytes += buf.length;
    } catch {
      if (opts.skipUnreadable === true) continue;
      files.push({ path: rel, content: null });
    }
  }

  const checkpoint: Checkpoint = {
    id,
    name: opts.name,
    rootDir: absRoot,
    createdAt: Date.now(),
    source: opts.source ?? "manual",
    files,
    bytes,
  };
  const cpPath = snapshotPath(absRoot, id);
  mkdirSync(dirname(cpPath), { recursive: true });
  writeFileSync(cpPath, JSON.stringify(checkpoint), "utf8");

  const meta: CheckpointMeta = {
    id,
    name: opts.name,
    createdAt: checkpoint.createdAt,
    source: checkpoint.source,
    fileCount: files.length,
    bytes,
  };
  const items = listCheckpoints(absRoot);
  items.push(meta);
  writeIndex(absRoot, items);
  return meta;
}

/** Most-recent name wins on collision. */
export function findCheckpoint(rootDir: string, idOrName: string): CheckpointMeta | null {
  const items = listCheckpoints(rootDir);
  // Prefer exact id match, then most-recent name match.
  const byId = items.find((m) => m.id === idOrName);
  if (byId) return byId;
  const byName = [...items].reverse().find((m) => m.name === idOrName);
  return byName ?? null;
}

export interface RestoreResult {
  /** Files we wrote back to disk. */
  restored: string[];
  /** Files we removed (snapshot had `content: null`, file existed). */
  removed: string[];
  /** Files we couldn't touch (errors), with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Path-escape rechecked against live `rootDir` since snapshot's may differ (project moved). */
export function restoreCheckpoint(rootDir: string, id: string): RestoreResult {
  const cp = loadCheckpoint(rootDir, id);
  const absRoot = resolve(rootDir);
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };
  if (!cp) {
    result.skipped.push({ path: "(checkpoint)", reason: `not found: ${id}` });
    return result;
  }
  for (const f of cp.files) {
    const abs = resolve(absRoot, f.path);
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) {
      result.skipped.push({ path: f.path, reason: "path escapes rootDir" });
      continue;
    }
    try {
      if (f.content === null) {
        if (existsSync(abs)) {
          rmSync(abs);
          result.removed.push(f.path);
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
        result.restored.push(f.path);
      }
    } catch (err) {
      result.skipped.push({ path: f.path, reason: (err as Error).message });
    }
  }
  return result;
}

/** Safety valve on files collected per turn snapshot. */
export const WORKSPACE_SNAPSHOT_MAX_FILES = 1_000_000;
/** Per-file safety valve — larger files are never recorded (rewind leaves them alone). */
export const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Total content cap per snapshot. */
export const WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** Dir names skipped even in full-coverage mode (VCS internals, app-private state). */
export const WORKSPACE_SNAPSHOT_SKIP_DIRS: readonly string[] = [".git", ".reasonix"];

/** Collect workspace-relative paths for a turn snapshot — full coverage: every
 *  regular file under rootDir except .git/.reasonix and symlinks, bounded by
 *  the safety valves below. Incremental: unchanged mtime+size files skipped. */
export function collectWorkspaceSnapshotPaths(
  rootDir: string,
  opts?: { prev?: Checkpoint | null; extra?: readonly string[] },
): string[] {
  const prevFiles = new Map<string, CheckpointFile>();
  if (opts?.prev) {
    for (const f of opts.prev.files) prevFiles.set(f.path, f);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of listFilesWithStatsSync(rootDir, {
    maxResults: WORKSPACE_SNAPSHOT_MAX_FILES,
    respectGitignore: false,
    ignoreDirs: WORKSPACE_SNAPSHOT_SKIP_DIRS,
    includeDotDirs: true,
  })) {
    if (seen.has(f.path)) continue;
    const abs = join(resolve(rootDir), f.path);
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > WORKSPACE_SNAPSHOT_MAX_FILE_BYTES) continue;
    const prev = prevFiles.get(f.path);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
    total += st.size;
    if (total > WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES) break;
    seen.add(f.path);
    out.push(f.path);
  }
  for (const p of opts?.extra ?? []) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export interface WorkspaceRestoreResult {
  /** Files written back to disk. */
  restored: string[];
  /** Files removed (absent at the rewind point, existed at restore). */
  removed: string[];
  /** Files removed because they only appear in later snapshots (created during rewound turns). */
  removedCreated: string[];
  /** Files we couldn't touch (errors), with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Reconstruct the workspace as of `upToIds` (newest wins per path — snapshots
 *  are incremental), then delete files that only appear in `afterIds` — they
 *  came into existence during rewound turns. Never touches unsnapshotted ones. */
export function reconstructWorkspaceTo(
  rootDir: string,
  upToIds: readonly string[],
  afterIds: readonly string[],
): WorkspaceRestoreResult {
  const result: WorkspaceRestoreResult = {
    restored: [],
    removed: [],
    removedCreated: [],
    skipped: [],
  };
  const absRoot = resolve(rootDir);
  const state = new Map<string, CheckpointFile>();
  for (const id of [...upToIds].reverse()) {
    const cp = loadCheckpoint(rootDir, id);
    if (!cp) continue;
    for (const f of cp.files) {
      if (!state.has(f.path)) state.set(f.path, f);
    }
  }
  for (const [path, f] of state) {
    const abs = resolve(absRoot, path);
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) {
      result.skipped.push({ path, reason: "path escapes rootDir" });
      continue;
    }
    try {
      if (f.content === null) {
        if (existsSync(abs)) {
          rmSync(abs);
          result.removed.push(path);
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
        result.restored.push(path);
      }
    } catch (err) {
      result.skipped.push({ path, reason: (err as Error).message });
    }
  }
  for (const id of afterIds) {
    const cp = loadCheckpoint(rootDir, id);
    if (!cp) continue;
    for (const f of cp.files) {
      if (state.has(f.path)) continue;
      const abs = resolve(absRoot, f.path);
      if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) continue;
      try {
        if (existsSync(abs)) {
          rmSync(abs);
          result.removedCreated.push(f.path);
        }
      } catch (err) {
        result.skipped.push({ path: f.path, reason: (err as Error).message });
      }
    }
  }
  return result;
}

export function deleteCheckpoint(rootDir: string, id: string): boolean {
  const cpPath = snapshotPath(rootDir, id);
  let removed = false;
  if (existsSync(cpPath)) {
    try {
      rmSync(cpPath);
      removed = true;
    } catch {
      return false;
    }
  }
  const items = listCheckpoints(rootDir);
  const next = items.filter((m) => m.id !== id);
  if (next.length !== items.length) {
    writeIndex(rootDir, next);
    removed = true;
  }
  return removed;
}

/** Format ms-timestamp diff as human-readable relative age. */
export function fmtAgo(ms: number): string {
  return fmtRelativeTime(Math.max(0, Date.now() - ms));
}
