import { countTokensBounded } from "../../tokenizer.js";
import { applyDeclarativeFilter, declarativeFilterMatches } from "./declarative-filter.js";
import type { RunCommandResult } from "./exec.js";
import { BUILTIN_DECLARATIVE_FILTERS } from "./filters/builtin.js";
import { filterDiagnostics } from "./filters/diagnostics.js";
import { filterGitStatus } from "./filters/git-status.js";
import { filterVitest } from "./filters/vitest.js";

export type OutputFilterMode = "filtered" | "degraded" | "passthrough";

export interface OutputFilterResult {
  commandFamily: string;
  mode: OutputFilterMode;
  output: string;
  warning?: string;
  omitted: boolean;
}

export interface FilteredCommandResult {
  result: RunCommandResult;
  filter: OutputFilterResult;
}

function executable(argv: readonly string[]): string {
  return argv[0]?.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function hasAny(argv: readonly string[], prefixes: readonly string[]): boolean {
  return argv.some((arg) =>
    prefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`)),
  );
}

export function classifyCommandFamily(argv: readonly string[]): string {
  const bin = executable(argv);
  const joined = argv.join(" ");
  if (bin === "git" && argv[1] === "status") return "git-status";
  if (bin === "tsc" || (bin === "npx" && argv[1] === "tsc") || /\btypecheck\b/.test(joined)) {
    return "typescript";
  }
  if (
    bin === "vitest" ||
    (bin === "npx" && argv[1] === "vitest") ||
    /\btest(?::|\b)/.test(joined)
  ) {
    return "vitest";
  }
  if (bin === "biome" || (bin === "npx" && argv[1] === "biome") || /\blint\b/.test(joined)) {
    return "biome";
  }
  return bin || "unknown";
}

function semanticFilter(argv: readonly string[], raw: string): OutputFilterResult {
  const family = classifyCommandFamily(argv);
  if (family === "vitest") {
    if (hasAny(argv, ["--reporter", "--outputFile"])) {
      return { commandFamily: family, mode: "passthrough", output: raw, omitted: false };
    }
    return filterVitest(raw);
  }
  if (family === "typescript")
    return filterDiagnostics(
      raw,
      "typescript",
      /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/,
    );
  if (family === "git-status") return filterGitStatus(raw);
  for (const filter of BUILTIN_DECLARATIVE_FILTERS) {
    if (!declarativeFilterMatches(filter, argv)) continue;
    const applied = applyDeclarativeFilter(filter, raw);
    return {
      commandFamily: filter.commandFamily,
      mode: applied.changed ? "filtered" : "passthrough",
      output: applied.output,
      omitted: applied.changed || applied.truncated,
    };
  }
  return { commandFamily: family, mode: "passthrough", output: raw, omitted: false };
}

function estimatedTokens(text: string): number {
  if (!text) return 0;
  const sample = countTokensBounded(text);
  if (text.length <= 2048) return sample;
  return Math.ceil((sample / Math.min(text.length, 2048)) * text.length);
}

/** Includes notices in the comparison so filtering can never enlarge the model-visible body. */
export function applyOutputFilter(
  argv: readonly string[],
  result: RunCommandResult,
  enabled = true,
): FilteredCommandResult {
  if (!enabled || result.truncated) {
    return {
      result,
      filter: {
        commandFamily: classifyCommandFamily(argv),
        mode: "passthrough",
        output: result.output,
        warning: result.truncated
          ? "semantic filter skipped because raw preview was truncated"
          : undefined,
        omitted: false,
      },
    };
  }
  const filtered = semanticFilter(argv, result.output);
  const notice =
    filtered.mode === "degraded"
      ? `\n[output filter degraded: ${filtered.warning ?? "partial parse"}]`
      : filtered.mode === "filtered"
        ? "\n[output filtered; full raw output is recoverable when material was omitted]"
        : "";
  const candidate = `${filtered.output}${notice}`;
  if (filtered.mode === "filtered" && estimatedTokens(candidate) > estimatedTokens(result.output)) {
    return {
      result,
      filter: { ...filtered, mode: "passthrough", output: result.output, omitted: false },
    };
  }
  return {
    result: { ...result, output: candidate },
    filter: filtered,
  };
}
