import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetDiagnosticsForTests,
  closeDiagnostics,
  configureDiagnostics,
  diagnosticsFilePath,
  recordDiagnostic,
} from "../src/diagnostics.js";
import { createLogger, setLogLevel } from "../src/logging.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-diagnostics-"));
  roots.push(root);
  return root;
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  _resetDiagnosticsForTests();
  setLogLevel("info");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable diagnostics", () => {
  it("creates a private launch file and persists structured records", () => {
    const directory = tempRoot();
    configureDiagnostics({ directory, source: "test" });
    recordDiagnostic("work.completed", { durationMs: 12.3456, details: { count: 3 } });
    const path = diagnosticsFilePath();
    closeDiagnostics();

    const lines = records(path);
    expect(lines.map((line) => line.event)).toEqual([
      "diagnostics.started",
      "work.completed",
      "diagnostics.stopping",
    ]);
    expect(lines[1]).toMatchObject({ source: "test", durationMs: 12.346 });
    expect(lines[1]?.launchId).toBe(lines[0]?.launchId);
  });

  it("persists verbose logger messages even when console logging is silent", () => {
    const directory = tempRoot();
    configureDiagnostics({ directory });
    setLogLevel("silent");
    createLogger("test-component").verbose("timing detail");
    const path = diagnosticsFilePath();
    closeDiagnostics();

    expect(records(path)).toContainEqual(
      expect.objectContaining({
        event: "log.test-component",
        level: "verbose",
        message: "timing detail",
      }),
    );
  });

  it("redacts credentials from messages and details", () => {
    const directory = tempRoot();
    configureDiagnostics({ directory });
    recordDiagnostic("request.failed", {
      message: "Bearer secret-value",
      details: { endpoint: "https://example.test?api_key=secret-value" },
    });
    const path = diagnosticsFilePath();
    closeDiagnostics();
    const raw = readFileSync(path, "utf8");

    expect(raw).not.toContain("secret-value");
    expect(raw).toContain("[redacted]");
  });

  it("rotates bounded files and enforces retention", () => {
    const directory = tempRoot();
    configureDiagnostics({ directory, maxFileBytes: 600, retainedFiles: 2 });
    for (let i = 0; i < 20; i++) recordDiagnostic(`large.${i}`, { message: "x".repeat(200) });
    closeDiagnostics();

    expect(
      readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length,
    ).toBeLessThanOrEqual(2);
  });
});
