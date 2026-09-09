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

type SemanticOutputFilter = (raw: string) => OutputFilterResult;

const TYPESCRIPT_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

function semanticFilterFor(argv: readonly string[]): SemanticOutputFilter | null {
  const family = classifyCommandFamily(argv);
  if (family === "vitest") {
    return hasAny(argv, ["--reporter", "--outputFile"]) ? null : filterVitest;
  }
  if (family === "typescript") {
    return (raw) => filterDiagnostics(raw, "typescript", TYPESCRIPT_DIAGNOSTIC);
  }
  if (family === "git-status") return filterGitStatus;
  const declarative = BUILTIN_DECLARATIVE_FILTERS.find((filter) =>
    declarativeFilterMatches(filter, argv),
  );
  if (!declarative) return null;
  return (raw) => {
    const applied = applyDeclarativeFilter(declarative, raw);
    return {
      commandFamily: declarative.commandFamily,
      mode: applied.changed ? "filtered" : "passthrough",
      output: applied.output,
      omitted: applied.changed || applied.truncated,
    };
  };
}

export function commandSupportsOutputFiltering(argv: readonly string[]): boolean {
  return semanticFilterFor(argv) !== null;
}

function semanticFilter(argv: readonly string[], raw: string): OutputFilterResult {
  const filter = semanticFilterFor(argv);
  return (
    filter?.(raw) ?? {
      commandFamily: classifyCommandFamily(argv),
      mode: "passthrough",
      output: raw,
      omitted: false,
    }
  );
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
  if (
    filtered.mode === "filtered" &&
    countTokensBounded(candidate) > countTokensBounded(result.output)
  ) {
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
