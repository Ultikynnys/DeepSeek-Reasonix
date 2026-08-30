import { constants, type BigIntStats } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import { tmpSiblingPath } from "../core/atomic-write.js";
import { readJsonFileSilentlyAsync } from "../core/json-file.js";

const READ_BUFFER_BYTES = 64 * 1024;
const MAX_SESSION_FILES = 100_000;
const MAX_SESSION_BYTES = 1024 * 1024 * 1024;
const PARALLEL_READS = 32;

export interface SessionFileIdentity {
  dev: string;
  ino: string;
  ctimeNs: string;
  mtimeNs: string;
  size: number;
}

export interface SessionDirectoryRecord<M> {
  name: string;
  path: string;
  identity: SessionFileIdentity;
  messageCount: number;
  endedWithNewline: boolean;
  mtime: Date;
  meta: M;
  metaIdentity: SessionFileIdentity | null;
}

export type SessionIndexCache = "hit" | "refresh" | "inflight";

function identity(stats: BigIntStats): SessionFileIdentity {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    ctimeNs: String(stats.ctimeNs),
    mtimeNs: String(stats.mtimeNs),
    size: Number(stats.size),
  };
}

function sameFile(a: SessionFileIdentity, b: SessionFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: SessionFileIdentity, b: SessionFileIdentity): boolean {
  return sameFile(a, b) && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

function metaUnchanged(a: SessionFileIdentity | null, b: SessionFileIdentity | null): boolean {
  if (a === null) return b === null;
  if (b === null) return false;
  return unchanged(a, b);
}

interface PersistedSessionIndexRecord<M> {
  name: string;
  path: string;
  identity: SessionFileIdentity;
  messageCount: number;
  endedWithNewline: boolean;
  mtimeMs: number;
  meta: M;
  metaIdentity: SessionFileIdentity | null;
}

interface PersistedSessionIndex<M> {
  version: 1;
  directory: string;
  records: PersistedSessionIndexRecord<M>[];
}

function isSessionFileIdentity(value: unknown): value is SessionFileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.dev === "string" &&
    typeof identity.ino === "string" &&
    typeof identity.ctimeNs === "string" &&
    typeof identity.mtimeNs === "string" &&
    typeof identity.size === "number"
  );
}

function isPersistedSessionIndex(value: unknown): value is PersistedSessionIndex<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const index = value as Record<string, unknown>;
  if (index.version !== 1 || typeof index.directory !== "string") return false;
  if (!Array.isArray(index.records)) return false;
  return index.records.every((record) => {
    if (typeof record !== "object" || record === null) return false;
    const entry = record as Record<string, unknown>;
    return (
      typeof entry.name === "string" &&
      typeof entry.path === "string" &&
      isSessionFileIdentity(entry.identity) &&
      typeof entry.messageCount === "number" &&
      typeof entry.endedWithNewline === "boolean" &&
      typeof entry.mtimeMs === "number" &&
      typeof entry.meta === "object" &&
      entry.meta !== null &&
      (entry.metaIdentity === null || isSessionFileIdentity(entry.metaIdentity))
    );
  });
}

async function countLines(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
): Promise<{ count: number; endedWithNewline: boolean }> {
  const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(1, length)));
  let position = start;
  let remaining = length;
  let count = 0;
  let lastByte: number | undefined;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error("session changed while it was being indexed");
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) count += 1;
    }
    lastByte = buffer[bytesRead - 1];
    position += bytesRead;
    remaining -= bytesRead;
  }
  const endedWithNewline = length > 0 && lastByte === 0x0a;
  if (length > 0 && !endedWithNewline) count += 1;
  return { count, endedWithNewline };
}

export class SessionDirectoryIndex<M> {
  private records = new Map<string, SessionDirectoryRecord<M>>();
  private inflight: {
    generation: number;
    value: Promise<readonly SessionDirectoryRecord<M>[]>;
  } | null = null;
  private generation = 0;
  private refreshedAt = 0;
  private loaded = false;
  private cacheLoaded = false;

  constructor(
    private readonly directory: () => string,
    private readonly loadMeta: (name: string) => M,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly maxFiles = MAX_SESSION_FILES,
    private readonly cacheFile?: string,
  ) {}

  load(): { value: Promise<readonly SessionDirectoryRecord<M>[]>; cache: SessionIndexCache } {
    if (this.loaded && this.refreshedAt + this.ttlMs > this.now()) {
      return { value: Promise.resolve([...this.records.values()]), cache: "hit" };
    }
    if (this.inflight?.generation === this.generation) {
      return { value: this.inflight.value, cache: "inflight" };
    }
    const generation = this.generation;
    const request = this.refresh(generation).finally(() => {
      if (this.inflight?.value === request) this.inflight = null;
    });
    this.inflight = { generation, value: request };
    return { value: request, cache: "refresh" };
  }

  invalidate(): void {
    this.generation += 1;
    this.refreshedAt = 0;
  }

  remove(name: string): void {
    this.records.delete(join(this.directory(), `${name}.jsonl`));
    this.invalidate();
    if (this.cacheFile !== undefined) void this.persistIndex(this.records);
  }

  private async refresh(generation: number): Promise<readonly SessionDirectoryRecord<M>[]> {
    await this.seedFromCache();
    let files: string[];
    try {
      files = (await readdir(this.directory(), { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.isSymbolicLink() &&
            entry.name.endsWith(".jsonl") &&
            !entry.name.endsWith(".events.jsonl"),
        )
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.publish(generation, new Map());
        return [];
      }
      throw error;
    }
    if (files.length > this.maxFiles) {
      throw new Error(`session directory exceeds ${this.maxFiles} files`);
    }
    const results: Array<SessionDirectoryRecord<M> | null> = new Array(files.length).fill(null);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_READS, files.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= files.length) return;
        const file = files[index]!;
        const path = join(this.directory(), file);
        const name = file.slice(0, -".jsonl".length);
        try {
          results[index] = await this.readRecord(path, name, this.records.get(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
    });
    await Promise.all(workers);
    const next = new Map<string, SessionDirectoryRecord<M>>();
    let changed = false;
    for (let index = 0; index < files.length; index += 1) {
      const record = results[index];
      if (record === null || record === undefined) continue;
      next.set(record.path, record);
      if (record !== this.records.get(record.path)) changed = true;
    }
    if (next.size !== this.records.size) changed = true;
    this.publish(generation, next);
    if (changed && generation === this.generation && this.cacheFile !== undefined) {
      await this.persistIndex(next);
    }
    return [...next.values()];
  }

  private async seedFromCache(): Promise<void> {
    const cacheFile = this.cacheFile;
    if (this.cacheLoaded || cacheFile === undefined) return;
    this.cacheLoaded = true;
    const cached = await readJsonFileSilentlyAsync(cacheFile, isPersistedSessionIndex);
    if (cached === null || cached.directory !== this.directory()) return;
    const seeded = new Map<string, SessionDirectoryRecord<M>>();
    for (const record of cached.records) {
      seeded.set(record.path, {
        name: record.name,
        path: record.path,
        identity: record.identity,
        messageCount: record.messageCount,
        endedWithNewline: record.endedWithNewline,
        mtime: new Date(record.mtimeMs),
        meta: record.meta as M,
        metaIdentity: record.metaIdentity,
      });
    }
    this.records = seeded;
  }

  private async persistIndex(records: Map<string, SessionDirectoryRecord<M>>): Promise<void> {
    const cacheFile = this.cacheFile;
    if (cacheFile === undefined) return;
    try {
      const body = JSON.stringify(this.serialize(records));
      await mkdir(dirname(cacheFile), { recursive: true });
      const tmp = tmpSiblingPath(cacheFile);
      try {
        await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
        try {
          await rename(tmp, cacheFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(tmp, cacheFile);
        }
      } finally {
        await rm(tmp, { force: true });
      }
    } catch (error) {
      process.stderr.write(`reasonix: session index cache write failed — ${messageOf(error)}\n`);
    }
  }

  private serialize(
    records: Map<string, SessionDirectoryRecord<M>>,
  ): PersistedSessionIndex<unknown> {
    return {
      version: 1,
      directory: this.directory(),
      records: [...records.values()].map((record) => ({
        name: record.name,
        path: record.path,
        identity: record.identity,
        messageCount: record.messageCount,
        endedWithNewline: record.endedWithNewline,
        mtimeMs: record.mtime.getTime(),
        meta: record.meta,
        metaIdentity: record.metaIdentity,
      })),
    };
  }

  private publish(generation: number, records: Map<string, SessionDirectoryRecord<M>>): void {
    if (generation !== this.generation) return;
    this.records = records;
    this.refreshedAt = this.now();
    this.loaded = true;
  }

  private async readRecord(
    path: string,
    name: string,
    previous?: SessionDirectoryRecord<M>,
  ): Promise<SessionDirectoryRecord<M>> {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const fileStats = await handle.stat({ bigint: true });
      if (!fileStats.isFile()) throw new Error(`session is not a regular file: ${name}`);
      const fileIdentity = identity(fileStats);
      if (fileIdentity.size > MAX_SESSION_BYTES) {
        throw new Error(`session exceeds ${MAX_SESSION_BYTES} bytes: ${name}`);
      }
      const metaStats = await stat(join(this.directory(), `${name}.meta.json`), {
        bigint: true,
      }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const nextMetaIdentity = metaStats ? identity(metaStats) : null;
      let meta: M;
      let metaReused = false;
      if (previous !== undefined && metaUnchanged(previous.metaIdentity, nextMetaIdentity)) {
        meta = previous.meta;
        metaReused = true;
      } else {
        meta = this.loadMeta(name);
      }
      if (previous && unchanged(previous.identity, fileIdentity)) {
        return metaReused ? previous : { ...previous, meta, metaIdentity: nextMetaIdentity };
      }
      const appendOnly =
        previous &&
        sameFile(previous.identity, fileIdentity) &&
        previous.identity.size < fileIdentity.size &&
        previous.endedWithNewline;
      const start = appendOnly ? previous.identity.size : 0;
      const counted = await countLines(handle, start, fileIdentity.size - start);
      const finalIdentity = identity(await handle.stat({ bigint: true }));
      if (!unchanged(fileIdentity, finalIdentity)) {
        throw new Error(`session changed while it was being indexed: ${name}`);
      }
      return {
        name,
        path,
        identity: fileIdentity,
        messageCount: appendOnly ? previous.messageCount + counted.count : counted.count,
        endedWithNewline: counted.endedWithNewline,
        mtime: new Date(Number(fileStats.mtimeMs)),
        meta,
        metaIdentity: nextMetaIdentity,
      };
    } finally {
      await handle.close();
    }
  }
}
