import { describe, expect, it } from "vitest";
import {
  applyDeclarativeFilter,
  declarativeFilterMatches,
  validateDeclarativeFilter,
} from "../src/tools/shell/declarative-filter.js";
import { BUILTIN_DECLARATIVE_FILTERS } from "../src/tools/shell/filters/builtin.js";

describe("declarative output filters", () => {
  it("validates every built-in declaration", () => {
    for (const filter of BUILTIN_DECLARATIVE_FILTERS)
      expect(() => validateDeclarativeFilter(filter)).not.toThrow();
  });

  it("matches exact executable and subcommand tokens", () => {
    const filter = BUILTIN_DECLARATIVE_FILTERS[0]!;
    expect(declarativeFilterMatches(filter, ["biome", "check", "src"])).toBe(true);
    expect(declarativeFilterMatches(filter, ["my-biome", "check", "src"])).toBe(false);
    expect(declarativeFilterMatches(filter, ["biome", "format", "src"])).toBe(false);
  });

  it("strips ANSI and known noise while retaining diagnostics", () => {
    const raw = "\u001b[31mChecked 42 files in 1s\u001b[0m\n\nsrc/a.ts:1:1 error\nFound 1 error.";
    const output = applyDeclarativeFilter(BUILTIN_DECLARATIVE_FILTERS[0]!, raw).output;
    expect(output).toContain("src/a.ts:1:1 error");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("Checked 42");
  });

  it("rejects ambiguous declarations", () => {
    expect(() =>
      validateDeclarativeFilter({ id: "bad", commandFamily: "bad", executable: ".*" }),
    ).toThrow();
    expect(() =>
      validateDeclarativeFilter({
        id: "bad",
        commandFamily: "bad",
        executable: "x",
        stripLines: [/a/],
        keepLines: [/b/],
      }),
    ).toThrow();
  });
});
