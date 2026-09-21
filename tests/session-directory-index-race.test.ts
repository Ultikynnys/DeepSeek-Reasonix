import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Simulated live writer, appending to the session transcript mid-scan. */
const race = vi.hoisted(() => ({
  /** Absolute path whose reads should first trigger an append. */
  path: "",
  /** Bytes appended before a triggering read. */
  data: "",
  /** Trigger reads remaining (use Infinity for a writer that never settles). */
  remaining: 0,
}));

// Intercept `open` so the scan's first read of the target file appends to it.
// This deterministically reproduces a session's own running turn writing while
// the directory index scans the transcript — the race that previously surfaced
// as `session_list failed: session changed while it was being indexed`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (path, ...rest) => {
    const handle = await actual.open(path, ...rest);
    return {
      read: async (buffer, offset, length, position) => {
        if (race.remaining > 0 && String(path) === race.path) {
          race.remaining -= 1;
          await actual.appendFile(race.path, race.data);
        }
        return handle.read(buffer, offset, length, position);
      },
      stat: (options) => handle.stat(options),
      close: () => handle.close(),
    } as unknown as Awaited<ReturnType<typeof actual.open>>;
  };
  return { ...actual, open };
});

import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";

const dirs: string[] = [];

async function fixture(): Promise<string> {
  const dir = join(tmpdir(), `reasonix-session-index-race-${crypto.randomUUID()}`);
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Seed a folder-per-session fixture and return its `messages.jsonl` path. */
async function seedSession(root: string, name: string, body: string): Promise<string> {
  const sessionDir = join(root, name);
  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, "messages.jsonl");
  await writeFile(path, body);
  return path;
}

afterEach(async () => {
  race.path = "";
  race.data = "";
  race.remaining = 0;
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("SessionDirectoryIndex concurrent-write resilience", () => {
  it("does not fail the listing when a live session appends mid-scan", async () => {
    const dir = await fixture();
    const messagesPath = await seedSession(dir, "one", "a\n");
    // Append a second message the instant the index first reads the transcript.
    race.path = messagesPath;
    race.data = "b\n";
    race.remaining = 1;

    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    const records = await index.load().value;
    expect(records).toHaveLength(1);
    // The rescan picks up the appended line instead of rejecting the whole list.
    expect(records[0]?.messageCount).toBe(2);
  });

  it("records best effort when a writer never settles, still without failing", async () => {
    const dir = await fixture();
    const messagesPath = await seedSession(dir, "one", "a\n");
    // A writer that appends on every read — the scan can never settle.
    race.path = messagesPath;
    race.data = "b\n";
    race.remaining = Number.POSITIVE_INFINITY;

    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    const records = await index.load().value;
    expect(records).toHaveLength(1);
    expect(records[0]?.messageCount).toBeGreaterThanOrEqual(1);
  });
});
