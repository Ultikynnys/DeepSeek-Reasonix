import { describe, expect, it } from "vitest";
import type { RunCommandResult } from "../src/tools/shell/exec.js";
import {
  applyOutputFilter,
  classifyCommandFamily,
  commandSupportsOutputFiltering,
} from "../src/tools/shell/output-filter.js";

function result(output: string, exitCode = 0): RunCommandResult {
  return {
    output,
    exitCode,
    timedOut: false,
    truncated: false,
    totalOutputBytes: output.length,
    durationMs: 1,
  };
}

describe("semantic shell output filters", () => {
  it("classifies parsed argv rather than raw prefixes", () => {
    expect(classifyCommandFamily(["npx", "vitest", "run"])).toBe("vitest");
    expect(classifyCommandFamily(["git", "status"])).toBe("git-status");
  });

  it("uses the same registry for filtering and raw-output preservation", () => {
    expect(commandSupportsOutputFiltering(["npx", "vitest", "run"])).toBe(true);
    expect(commandSupportsOutputFiltering(["npx", "vitest", "--reporter=junit"])).toBe(false);
    expect(commandSupportsOutputFiltering(["biome", "check", "src"])).toBe(true);
    expect(commandSupportsOutputFiltering(["node", "script.mjs"])).toBe(false);
  });

  it("compacts ANSI-colored Vitest success output", () => {
    const raw =
      "\u001b[36mRUN v2\u001b[0m\n ✓ a.test.ts (4 tests)\n\n Test Files  1 passed (1)\n      Tests  \u001b[32m4 passed (4)\u001b[0m\n Duration 1s";
    const filtered = applyOutputFilter(["npx", "vitest", "run"], result(raw));
    expect(filtered.filter.mode).toBe("filtered");
    expect(filtered.result.output).toContain("Tests 4 passed (4)");
    expect(filtered.result.output).not.toContain("RUN v2");
    expect(filtered.result.output).not.toContain("\u001b");
  });

  it("makes malformed Vitest output visibly degraded", () => {
    const raw = "runner crashed before summary";
    const filtered = applyOutputFilter(["npx", "vitest", "run"], result(raw, 1));
    expect(filtered.filter.mode).toBe("degraded");
    expect(filtered.result.output).toContain("output filter degraded");
    expect(filtered.result.output).toContain(raw);
  });

  it("honors explicit Vitest reporters", () => {
    const raw = "custom reporter output";
    const filtered = applyOutputFilter(["npx", "vitest", "--reporter=junit"], result(raw));
    expect(filtered.filter.mode).toBe("passthrough");
    expect(filtered.result.output).toBe(raw);
  });

  it("groups TypeScript diagnostics by file", () => {
    const raw = [
      "src/a.ts(2,3): error TS2322: Type 'string' is not assignable",
      "  The target type comes from a deeply nested generic declaration that repeats context.",
      "src/a.ts(8,1): error TS7006: Parameter has an implicit any type",
      "  Add an explicit parameter type to resolve this diagnostic.",
    ].join("\n");
    const filtered = applyOutputFilter(["npx", "tsc", "--noEmit"], result(raw, 2));
    expect(filtered.filter.mode).toBe("filtered");
    expect(filtered.result.output).toContain("2 typescript diagnostics");
    expect(filtered.result.output).toContain("2:3 TS2322");
  });

  it("compacts long git status but preserves conflict state", () => {
    const raw =
      "On branch main\nYou have unmerged paths.\n  (fix conflicts and run git commit)\n\nUnmerged paths:\n  both modified: src/a.ts\n";
    const filtered = applyOutputFilter(["git", "status"], result(raw, 1));
    expect(filtered.filter.mode).toBe("filtered");
    expect(filtered.result.output).toContain("conflicts");
  });

  it("skips semantic filtering when the raw preview is already truncated", () => {
    const raw = result("partial");
    raw.truncated = true;
    const filtered = applyOutputFilter(["npx", "vitest", "run"], raw);
    expect(filtered.filter.mode).toBe("passthrough");
    expect(filtered.filter.warning).toContain("raw preview was truncated");
  });
});
