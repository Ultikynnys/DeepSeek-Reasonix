import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCommandOutputMetric,
  estimateOutputTokens,
  summarizeCommandOutputMetrics,
} from "../src/telemetry/command-output.js";
import { countTokensBounded } from "../src/tokenizer.js";

describe("command output telemetry", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-command-output-"));
    path = join(dir, "metrics.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("delegates bounded estimation to the project tokenizer", () => {
    for (const output of ["", "hello world", "x".repeat(10_000)]) {
      expect(estimateOutputTokens(output)).toBe(countTokensBounded(output));
    }
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

  it("scopes a since-windowed summary to metrics appended inside that window", () => {
    appendCommandOutputMetric(
      {
        timestamp: new Date(1_000).toISOString(),
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
        timestamp: new Date(2_000).toISOString(),
        commandFamily: "typescript",
        mode: "filtered",
        rawChars: 500,
        shownChars: 50,
        rawTokens: 100,
        shownTokens: 10,
        durationMs: 5,
        exitCode: 0,
        recoveryAvailable: false,
        recoveryComplete: null,
      },
      path,
    );
    appendCommandOutputMetric(
      {
        // Unparseable timestamps cannot be attributed to the session and are
        // excluded rather than silently re-aggregated.
        timestamp: "not-a-date",
        commandFamily: "git-status",
        mode: "passthrough",
        rawChars: 10,
        shownChars: 10,
        rawTokens: 5,
        shownTokens: 5,
        durationMs: 1,
        exitCode: 0,
        recoveryAvailable: false,
        recoveryComplete: null,
      },
      path,
    );

    // All-time (no window): every metric counts.
    expect(summarizeCommandOutputMetrics(path).commands).toBe(3);
    // Window anchored between the first and second metric: only the second.
    expect(summarizeCommandOutputMetrics(path, { since: 1_500 })).toEqual({
      commands: 1,
      rawTokens: 100,
      shownTokens: 10,
      reducedTokens: 90,
      recoveryAvailable: 0,
      byFamily: { typescript: 1 },
      byMode: { filtered: 1, degraded: 0, passthrough: 0 },
    });
    // Boundary is inclusive: a metric stamped exactly at `since` belongs.
    expect(summarizeCommandOutputMetrics(path, { since: 1_000 }).commands).toBe(2);
  });
});
