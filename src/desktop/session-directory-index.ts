import { constants, type BigIntStats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const READ_BUFFER_BYTES = 64 * 1024;
const MAX_SESSION_FILES = 10_000;
const MAX_SESSION_BYTES = 1024 * 1024 * 1024;

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

  constructor(
    private readonly directory: () => string,
    private readonly loadMeta: (name: string) => M,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
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
  }

  private async refresh(generation: number): Promise<readonly SessionDirectoryRecord<M>[]> {
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
    if (files.length > MAX_SESSION_FILES) {
      throw new Error(`session directory exceeds ${MAX_SESSION_FILES} files`);
    }
    const next = new Map<string, SessionDirectoryRecord<M>>();
    for (const file of files) {
      const path = join(this.directory(), file);
      const name = file.slice(0, -".jsonl".length);
      try {
        const current = await this.readRecord(path, name, this.records.get(path));
        next.set(path, current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    this.publish(generation, next);
    return [...next.values()];
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
      const meta =
        previous &&
        ((previous.metaIdentity === null && nextMetaIdentity === null) ||
          (previous.metaIdentity &&
            nextMetaIdentity &&
            unchanged(previous.metaIdentity, nextMetaIdentity)))
          ? previous.meta
          : this.loadMeta(name);
      if (previous && unchanged(previous.identity, fileIdentity)) {
        return { ...previous, meta, metaIdentity: nextMetaIdentity };
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
