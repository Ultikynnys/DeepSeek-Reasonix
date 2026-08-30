import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";

const dirs: string[] = [];

async function fixture(): Promise<string> {
  const dir = join(tmpdir(), `reasonix-session-index-${crypto.randomUUID()}`);
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("SessionDirectoryIndex", () => {
  it("single-flights refreshes and reuses an unchanged snapshot", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "one.jsonl"), "a\nb\n");
    const loadMeta = vi.fn(() => ({ workspace: "a" }));
    const index = new SessionDirectoryIndex(() => dir, loadMeta);
    const first = index.load();
    const second = index.load();
    expect(first.cache).toBe("refresh");
    expect(second.cache).toBe("inflight");
    const [records] = await Promise.all([first.value, second.value]);
    expect(records[0]?.messageCount).toBe(2);
    expect(index.load().cache).toBe("hit");
    expect(loadMeta).toHaveBeenCalledTimes(1);
  });

  it("counts only appended bytes and fully recounts truncation", async () => {
    const dir = await fixture();
    const path = join(dir, "one.jsonl");
    await writeFile(path, "a\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    await index.load().value;
    await appendFile(path, "b\nc\n");
    index.invalidate();
    expect((await index.load().value)[0]?.messageCount).toBe(3);
    await writeFile(path, "z\n");
    index.invalidate();
    expect((await index.load().value)[0]?.messageCount).toBe(1);
  });

  it("removes deleted files and retries an explicit refresh failure", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "one.jsonl"), "a\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
    );
    expect(await index.load().value).toHaveLength(1);
    await rm(join(dir, "one.jsonl"));
    expect(await index.load().value).toHaveLength(0);
    await rm(dir, { recursive: true });
    expect(await index.load().value).toEqual([]);
  });

  it("rejects a directory that exceeds the configured file cap", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "one.jsonl"), "a\n");
    await writeFile(join(dir, "two.jsonl"), "b\n");
    await writeFile(join(dir, "three.jsonl"), "c\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
      2,
    );
    await expect(index.load().value).rejects.toThrow("session directory exceeds 2 files");
    // The failed refresh does not publish, so the next call retries the cap check.
    await expect(index.load().value).rejects.toThrow("session directory exceeds 2 files");
  });

  it("indexes a directory right at the configured file cap", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "one.jsonl"), "a\n");
    await writeFile(join(dir, "two.jsonl"), "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
      2,
    );
    expect((await index.load().value).map((record) => record.name)).toEqual(["one", "two"]);
  });

  it("persists the index to a cache file and reuses it across instances", async () => {
    const dir = await fixture();
    const cacheFile = join(dir, "index-cache.json");
    await writeFile(join(dir, "one.jsonl"), "a\nb\n");
    await writeFile(join(dir, "two.jsonl"), "x\ny\nz\n");
    const loadMeta = vi.fn(() => ({ workspace: "a" }));
    const first = new SessionDirectoryIndex(
      () => dir,
      loadMeta,
      0,
      () => 0,
      undefined,
      cacheFile,
    );
    const [one, two] = (await first.load().value).sort((a, b) => a.name.localeCompare(b.name));
    expect(one?.messageCount).toBe(2);
    expect(two?.messageCount).toBe(3);
    expect(loadMeta).toHaveBeenCalledTimes(2);
    expect(existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      version: number;
      records: Array<{ name: string; messageCount: number }>;
    };
    expect(cached.version).toBe(1);
    expect(cached.records).toHaveLength(2);

    // A fresh instance (simulating relaunch) reuses the cache: no meta reloads,
    // no recounting of unchanged files.
    const second = new SessionDirectoryIndex(
      () => dir,
      loadMeta,
      0,
      () => 0,
      undefined,
      cacheFile,
    );
    const [relaunchedOne, relaunchedTwo] = (await second.load().value).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(relaunchedOne?.messageCount).toBe(2);
    expect(relaunchedTwo?.messageCount).toBe(3);
    expect(loadMeta).toHaveBeenCalledTimes(2);
  });

  it("recounts only files that changed since the cache was written", async () => {
    const dir = await fixture();
    const cacheFile = join(dir, "index-cache.json");
    const path = join(dir, "one.jsonl");
    await writeFile(path, "a\n");
    await writeFile(join(dir, "two.jsonl"), "x\n");
    const first = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
      undefined,
      cacheFile,
    );
    await first.load().value;
    // Append to one session between instances; the other must stay cached.
    await appendFile(path, "b\nc\n");
    const second = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
      undefined,
      cacheFile,
    );
    const records = (await second.load().value).sort((a, b) => a.name.localeCompare(b.name));
    expect(records[0]?.messageCount).toBe(3);
    expect(records[1]?.messageCount).toBe(1);
  });

  it("ignores a corrupt cache file and rebuilds from disk", async () => {
    const dir = await fixture();
    const cacheFile = join(dir, "index-cache.json");
    await writeFile(join(dir, "one.jsonl"), "a\nb\n");
    await writeFile(cacheFile, "{ not json");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
      undefined,
      cacheFile,
    );
    expect((await index.load().value)[0]?.messageCount).toBe(2);
  });

  it("parallelizes reads across many files", async () => {
    const dir = await fixture();
    const count = 300;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeFile(join(dir, `session-${index}.jsonl`), "a\nb\nc\n"),
      ),
    );
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
      () => 0,
    );
    const records = await index.load().value;
    expect(records).toHaveLength(count);
    expect(records.every((record) => record.messageCount === 3)).toBe(true);
  }, 30_000);
});
