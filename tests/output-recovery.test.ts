import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OutputRecoveryCapture,
  cleanupOutputRecovery,
  markOutputRecoveryRead,
  outputRecoveryDir,
  readOutputRecoveryMetadata,
} from "../src/tools/output-recovery.js";

describe("OutputRecoveryCapture", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "reasonix-output-recovery-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("stores byte-faithful text and gzip artifacts", () => {
    const capture = new OutputRecoveryCapture(rootDir);
    capture.append(Buffer.from("hello "));
    capture.append(Buffer.from("世界\n"));
    const result = capture.finish("test", true);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const textPath = resolve(rootDir, result.ref.path);
    const gzipPath = resolve(rootDir, result.ref.gzipPath);
    expect(readFileSync(textPath)).toEqual(Buffer.from("hello 世界\n"));
    expect(gunzipSync(readFileSync(gzipPath))).toEqual(Buffer.from("hello 世界\n"));
    expect(result.ref.complete).toBe(true);
  });

  it("deduplicates identical content", () => {
    const first = new OutputRecoveryCapture(rootDir);
    first.append("same");
    const a = first.finish("one", true);
    const second = new OutputRecoveryCapture(rootDir);
    second.append("same");
    const b = second.finish("two", true);
    expect(a?.ok && b?.ok).toBe(true);
    if (!a?.ok || !b?.ok) return;
    expect(b.ref.hash).toBe(a.ref.hash);
    expect(b.ref.path).toBe(a.ref.path);
    expect(b.ref.deduplicated).toBe(true);
  });

  it("marks recovery incomplete when the entry ceiling is crossed", () => {
    const capture = new OutputRecoveryCapture(rootDir, { maxEntryBytes: 4 });
    capture.append("abcdefgh");
    const result = capture.finish("limited", true);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.ref.complete).toBe(false);
    expect(result.ref.storedBytes).toBe(4);
    expect(result.ref.totalBytes).toBe(8);
    expect(readFileSync(resolve(rootDir, result.ref.path), "utf8")).toBe("abcd");
  });

  it("does not persist when recovery is unnecessary", () => {
    const capture = new OutputRecoveryCapture(rootDir);
    capture.append("short");
    expect(capture.finish("short", false)).toBeNull();
    expect(existsSync(outputRecoveryDir(rootDir))).toBe(true);
    expect(readdirSync(outputRecoveryDir(rootDir))).toHaveLength(0);
  });

  it("counts successful reads in metadata", () => {
    const capture = new OutputRecoveryCapture(rootDir);
    capture.append("read me");
    const result = capture.finish("read", true);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const textPath = resolve(rootDir, result.ref.path);
    expect(markOutputRecoveryRead(textPath)).toBe(true);
    const metadata = readOutputRecoveryMetadata(
      join(outputRecoveryDir(rootDir), `${result.ref.hash}.json`),
    );
    expect(metadata?.reads).toBe(1);
  });

  it("bounds retained entries", () => {
    for (const content of ["one", "two", "three"]) {
      const capture = new OutputRecoveryCapture(rootDir);
      capture.append(content);
      capture.finish(content, true, { maxEntries: 10 });
    }
    cleanupOutputRecovery(rootDir, { maxEntries: 2, maxAgeMs: Number.MAX_SAFE_INTEGER });
    const metas = readFileNames(outputRecoveryDir(rootDir)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(metas).toHaveLength(2);
  });
});

function readFileNames(path: string): string[] {
  return readdirSync(path);
}
