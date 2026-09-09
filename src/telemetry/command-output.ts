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
  if (!text) return 0;
  const maxChars = 2048;
  const sampleChars = Math.min(text.length, maxChars);
  const sampleTokens = countTokensBounded(text, maxChars);
  return text.length <= maxChars
    ? sampleTokens
    : Math.ceil((sampleTokens / Math.max(1, sampleChars)) * text.length);
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
): CommandOutputSummary {
  const metrics = readJsonlLines(path, isMetric);
  const summary: CommandOutputSummary = {
    commands: metrics.length,
    rawTokens: 0,
    shownTokens: 0,
    reducedTokens: 0,
    recoveryAvailable: 0,
    byFamily: {},
    byMode: { filtered: 0, degraded: 0, passthrough: 0 },
  };
  for (const metric of metrics) {
    summary.rawTokens += metric.rawTokens;
    summary.shownTokens += metric.shownTokens;
    summary.recoveryAvailable += metric.recoveryAvailable ? 1 : 0;
    summary.byFamily[metric.commandFamily] = (summary.byFamily[metric.commandFamily] ?? 0) + 1;
    summary.byMode[metric.mode]++;
  }
  summary.reducedTokens = Math.max(0, summary.rawTokens - summary.shownTokens);
  return summary;
}
