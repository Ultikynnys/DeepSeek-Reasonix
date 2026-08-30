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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
