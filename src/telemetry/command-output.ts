import { join } from "node:path";
import { appendJsonlLine, readJsonlLines } from "../core/jsonl.js";
import { reasonixHome } from "../reasonix-home.js";
import { countTokensBounded } from "../tokenizer.js";
import type { OutputFilterMode } from "../tools/shell/output-filter.js";

export interface CommandOutputMetric {
  timestamp: string;
  commandFamily: string;
  mode: OutputFilterMode;
  rawChars: number;
  shownChars: number;
  rawTokens: number;
  shownTokens: number;
  durationMs: number;
  exitCode: number | null;
  recoveryAvailable: boolean;
  recoveryComplete: boolean | null;
}

export interface CommandOutputSummary {
  commands: number;
  rawTokens: number;
  shownTokens: number;
  reducedTokens: number;
  recoveryAvailable: number;
  byFamily: Record<string, number>;
  byMode: Record<OutputFilterMode, number>;
}

export function commandOutputTelemetryPath(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), "telemetry", "command-output.jsonl");
}

export function estimateOutputTokens(text: string): number {
  return countTokensBounded(text);
}

export function appendCommandOutputMetric(
  metric: CommandOutputMetric,
  path = commandOutputTelemetryPath(),
): void {
  appendJsonlLine(path, metric);
}

function isMetric(raw: unknown): raw is CommandOutputMetric {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Partial<CommandOutputMetric>;
  return (
    typeof value.commandFamily === "string" &&
    (value.mode === "filtered" || value.mode === "degraded" || value.mode === "passthrough") &&
    typeof value.rawTokens === "number" &&
    typeof value.shownTokens === "number"
  );
}

export function summarizeCommandOutputMetrics(
  path = commandOutputTelemetryPath(),
  opts: { since?: number } = {},
): CommandOutputSummary {
  const metrics = readJsonlLines(path, isMetric);
  const summary: CommandOutputSummary = {
    commands: 0,
    rawTokens: 0,
    shownTokens: 0,
    reducedTokens: 0,
    recoveryAvailable: 0,
    byFamily: {},
    byMode: { filtered: 0, degraded: 0, passthrough: 0 },
  };
  // `since` scopes the summary to one session's lifetime (epoch ms): the JSONL
  // is shared across sessions, and per-session consumers (the desktop statusbar
  // chip) must not aggregate other sessions' history. Metrics whose timestamp
  // is missing or unparseable are excluded from a scoped summary — they cannot
  // be attributed to this session, and including them would silently rebuild
  // the all-time aggregate this option exists to avoid.
  const since = opts.since;
  const inSession = (metric: CommandOutputMetric): boolean => {
    if (since === undefined) return true;
    const ts = Date.parse(metric.timestamp);
    return Number.isFinite(ts) && ts >= since;
  };
  for (const metric of metrics) {
    if (!inSession(metric)) continue;
    summary.commands++;
    summary.rawTokens += metric.rawTokens;
    summary.shownTokens += metric.shownTokens;
    summary.recoveryAvailable += metric.recoveryAvailable ? 1 : 0;
    summary.byFamily[metric.commandFamily] = (summary.byFamily[metric.commandFamily] ?? 0) + 1;
    summary.byMode[metric.mode]++;
  }
  summary.reducedTokens = Math.max(0, summary.rawTokens - summary.shownTokens);
  return summary;
}
