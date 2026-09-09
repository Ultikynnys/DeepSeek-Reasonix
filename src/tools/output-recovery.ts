import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, parse, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DAY_MS } from "@reasonix/core-utils";
import { atomicWriteSync, tmpSiblingPath } from "../core/atomic-write.js";
import { reasonixHome } from "../reasonix-home.js";

const RECOVERY_DIR = "output-recovery";
const DEFAULT_MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;

export interface OutputRecoveryLimits {
  maxEntryBytes?: number;
  maxEntries?: number;
  maxAgeMs?: number;
}

export interface OutputRecoveryRef {
  hash: string;
  /** Model-readable, uncompressed mirror relative to the project when possible. */
  path: string;
  gzipPath: string;
  storedBytes: number;
  totalBytes: number;
  complete: boolean;
  deduplicated: boolean;
}

export type OutputRecoveryResult =
  | { ok: true; ref: OutputRecoveryRef }
  | { ok: false; error: string; totalBytes: number; storedBytes: number };

function useHomeFallback(rootDir: string): boolean {
  if (!rootDir) return true;
  const abs = resolve(rootDir);
  return abs === parse(abs).root;
}

export function outputRecoveryDir(rootDir: string): string {
  const base = useHomeFallback(rootDir) ? reasonixHome() : join(resolve(rootDir), ".reasonix");
  return join(base, RECOVERY_DIR);
}

function displayPath(rootDir: string, absolute: string): string {
  if (useHomeFallback(rootDir)) return absolute.replaceAll("\\", "/");
  return relative(resolve(rootDir), absolute).replaceAll("\\", "/");
}

function privateWrite(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof body === "string") {
    atomicWriteSync(path, body, tmpSiblingPath(path));
    return;
  }
  const tmp = tmpSiblingPath(path);
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function artifactPaths(dir: string, hash: string): { text: string; gzip: string; meta: string } {
  return {
    text: join(dir, `${hash}.txt`),
    gzip: join(dir, `${hash}.txt.gz`),
    meta: join(dir, `${hash}.json`),
  };
}

interface RecoveryMetadata {
  version: 1;
  hash: string;
  label: string;
  createdAt: number;
  lastAccessedAt: number;
  reads: number;
  storedBytes: number;
  totalBytes: number;
  complete: boolean;
}

export function cleanupOutputRecovery(rootDir: string, limits: OutputRecoveryLimits = {}): void {
  const dir = outputRecoveryDir(rootDir);
  if (!existsSync(dir)) return;
  const maxAgeMs = limits.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxEntries = Math.max(1, limits.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const cutoff = Date.now() - maxAgeMs;
  let metas: Array<{ path: string; hash: string; mtimeMs: number }> = [];
  try {
    metas = readdirSync(dir)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .map((name) => {
        const path = join(dir, name);
        return { path, hash: name.slice(0, 24), mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  for (let i = 0; i < metas.length; i++) {
    const entry = metas[i]!;
    if (entry.mtimeMs >= cutoff && i < maxEntries) continue;
    const paths = artifactPaths(dir, entry.hash);
    for (const path of [paths.text, paths.gzip, paths.meta]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Cleanup is best effort and must not block command execution.
      }
    }
  }
}

/** Bounded byte-faithful shell capture. Bytes beyond the ceiling are counted but not stored, and the reference is explicitly incomplete. */
export class OutputRecoveryCapture {
  private readonly dir: string;
  private readonly maxEntryBytes: number;
  private readonly tempPath: string;
  private fd: number | null = null;
  private storedBytes = 0;
  private observedBytes = 0;
  private failed: string | null = null;

  get totalBytes(): number {
    return this.observedBytes;
  }

  constructor(
    private readonly rootDir: string,
    limits: OutputRecoveryLimits = {},
  ) {
    this.dir = outputRecoveryDir(rootDir);
    this.maxEntryBytes = Math.max(1, limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES);
    this.tempPath = join(this.dir, `.capture-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    try {
      mkdirSync(this.dir, { recursive: true });
      this.fd = openSync(this.tempPath, "wx", 0o600);
    } catch (error) {
      this.failed = (error as Error).message;
    }
  }

  append(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.observedBytes += bytes.length;
    if (this.fd === null || this.storedBytes >= this.maxEntryBytes) return;
    const kept = bytes.subarray(0, Math.min(bytes.length, this.maxEntryBytes - this.storedBytes));
    try {
      let offset = 0;
      while (offset < kept.length) {
        const written = writeSync(this.fd, kept, offset, kept.length - offset);
        if (written <= 0) throw new Error("recovery capture write returned zero bytes");
        offset += written;
      }
      this.storedBytes += kept.length;
    } catch (error) {
      this.failed = (error as Error).message;
      this.closeAndRemove();
    }
  }

  finish(
    label: string,
    persist: boolean,
    limits: OutputRecoveryLimits = {},
  ): OutputRecoveryResult | null {
    if (!persist) {
      this.closeAndRemove();
      return null;
    }
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch (error) {
        this.failed = (error as Error).message;
      }
      this.fd = null;
    }
    if (this.failed) {
      this.removeTemp();
      return {
        ok: false,
        error: this.failed,
        totalBytes: this.observedBytes,
        storedBytes: this.storedBytes,
      };
    }
    try {
      const bytes = readFileSync(this.tempPath);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
      const paths = artifactPaths(this.dir, hash);
      const deduplicated = existsSync(paths.text) && existsSync(paths.gzip);
      if (!deduplicated) {
        privateWrite(paths.text, bytes);
        privateWrite(paths.gzip, gzipSync(bytes));
      }
      const now = Date.now();
      const metadata: RecoveryMetadata = {
        version: 1,
        hash,
        label: label.slice(0, 200),
        createdAt: now,
        lastAccessedAt: now,
        reads: 0,
        storedBytes: bytes.length,
        totalBytes: this.observedBytes,
        complete: this.observedBytes === bytes.length,
      };
      privateWrite(paths.meta, `${JSON.stringify(metadata)}\n`);
      this.removeTemp();
      cleanupOutputRecovery(this.rootDir, limits);
      return {
        ok: true,
        ref: {
          hash,
          path: displayPath(this.rootDir, paths.text),
          gzipPath: displayPath(this.rootDir, paths.gzip),
          storedBytes: bytes.length,
          totalBytes: this.observedBytes,
          complete: metadata.complete,
          deduplicated,
        },
      };
    } catch (error) {
      this.removeTemp();
      return {
        ok: false,
        error: (error as Error).message,
        totalBytes: this.observedBytes,
        storedBytes: this.storedBytes,
      };
    }
  }

  private closeAndRemove(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Removal below remains best effort.
      }
      this.fd = null;
    }
    this.removeTemp();
  }

  private removeTemp(): void {
    try {
      rmSync(this.tempPath, { force: true });
    } catch {
      // Temporary-file cleanup is best effort.
    }
  }
}

/** Called by read_file after a recovery text mirror is opened successfully. */
export function markOutputRecoveryRead(absolutePath: string): boolean {
  if (!absolutePath.endsWith(".txt")) return false;
  const dir = dirname(absolutePath);
  if (parse(dir).base !== RECOVERY_DIR) return false;
  const hash = parse(absolutePath).name;
  if (!/^[a-f0-9]{24}$/.test(hash)) return false;
  const metaPath = artifactPaths(dir, hash).meta;
  try {
    const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as RecoveryMetadata;
    metadata.reads = Math.max(0, metadata.reads ?? 0) + 1;
    metadata.lastAccessedAt = Date.now();
    privateWrite(metaPath, `${JSON.stringify(metadata)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readOutputRecoveryMetadata(path: string): RecoveryMetadata | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RecoveryMetadata;
  } catch {
    return null;
  }
}
