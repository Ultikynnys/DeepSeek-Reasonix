import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCommandOutputMetric,
  estimateOutputTokens,
  summarizeCommandOutputMetrics,
} from "../src/telemetry/command-output.js";

describe("command output telemetry", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-command-output-"));
    path = join(dir, "metrics.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the project tokenizer and scales bounded samples", () => {
    expect(estimateOutputTokens("hello world")).toBeGreaterThan(0);
    expect(estimateOutputTokens("x".repeat(10_000))).toBeGreaterThan(
      estimateOutputTokens("x".repeat(100)),
    );
  });

  it("aggregates reductions without persisting raw output", () => {
    appendCommandOutputMetric(
      {
        timestamp: new Date(0).toISOString(),
        commandFamily: "vitest",
        mode: "filtered",
        rawChars: 1000,
        shownChars: 100,
        rawTokens: 250,
        shownTokens: 25,
        durationMs: 12,
        exitCode: 0,
        recoveryAvailable: true,
        recoveryComplete: true,
      },
      path,
    );
    appendCommandOutputMetric(
      {
        timestamp: new Date(1).toISOString(),
        commandFamily: "typescript",
        mode: "degraded",
        rawChars: 100,
        shownChars: 120,
        rawTokens: 20,
        shownTokens: 22,
        durationMs: 2,
        exitCode: 1,
        recoveryAvailable: false,
        recoveryComplete: null,
      },
      path,
    );
    expect(summarizeCommandOutputMetrics(path)).toEqual({
      commands: 2,
      rawTokens: 270,
      shownTokens: 47,
      reducedTokens: 223,
      recoveryAvailable: 1,
      byFamily: { vitest: 1, typescript: 1 },
      byMode: { filtered: 1, degraded: 1, passthrough: 0 },
    });
  });
});
