/** Pass order: scavenge → truncation → storm. Schema flatten runs at loop construction, not per-turn. */

import type { ToolCall } from "../types.js";
import { repairRepeatingToolName, scavengeToolCalls } from "./scavenge.js";
import { type IsMutating, type IsStormExempt, StormBreaker } from "./storm.js";
import {
  type ArgsSplitResult,
  repairTruncatedJson,
  splitConcatenatedJsonObjects,
} from "./truncation.js";

export { analyzeSchema, flattenSchema, nestArguments } from "./flatten.js";
export type { FlattenDecision } from "./flatten.js";
export { repairTruncatedJson, splitConcatenatedJsonObjects } from "./truncation.js";
export type { TruncationRepairResult, ArgsSplitResult } from "./truncation.js";
export { repairRepeatingToolName, scavengeToolCalls } from "./scavenge.js";
export type { ScavengeOptions, ScavengeRange, ScavengeResult } from "./scavenge.js";
export { StormBreaker } from "./storm.js";

export interface RepairReport {
  scavenged: number;
  truncationsFixed: number;
  /** Calls restored by splitting concatenated arguments (parallel-call fragments merged by the provider). */
  argsSplitCalls: number;
  stormsBroken: number;
  notes: string[];
}

export interface ToolCallRepairOptions {
  allowedToolNames: ReadonlySet<string>;
  stormWindow?: number;
  stormThreshold?: number;
  maxScavenge?: number;
  /** Mutating calls clear the storm window so a post-edit verify-read isn't seen as a repeat. */
  isMutating?: IsMutating;
  /** Cheap state-inspection calls that should never trip repeat-loop suppression. */
  isStormExempt?: IsStormExempt;
}

export class ToolCallRepair {
  private readonly storm: StormBreaker;
  private readonly opts: ToolCallRepairOptions;

  constructor(opts: ToolCallRepairOptions) {
    this.opts = opts;
    this.storm = new StormBreaker(
      opts.stormWindow ?? 6,
      opts.stormThreshold ?? 3,
      opts.isMutating,
      opts.isStormExempt,
    );
  }

  /** Called at start of every user turn — fresh intent shouldn't inherit old repetition state. */
  resetStorm(): void {
    this.storm.reset();
  }

  process(
    declaredCalls: ToolCall[],
    reasoningContent: string | null,
    content: string | null = null,
  ): { calls: ToolCall[]; report: RepairReport; content: string | null } {
    const report: RepairReport = {
      scavenged: 0,
      truncationsFixed: 0,
      argsSplitCalls: 0,
      stormsBroken: 0,
      notes: [],
    };

    // 0. Repair repeating tool names in declared calls (e.g. "read_fileread_file..." → "read_file").
    for (const call of declaredCalls) {
      if (call.function?.name && !this.opts.allowedToolNames.has(call.function.name)) {
        const repaired = repairRepeatingToolName(call.function.name, this.opts.allowedToolNames);
        if (repaired) {
          report.notes.push(
            `[${call.function.name}] repaired repeating tool name to '${repaired}'`,
          );
          call.function.name = repaired;
        }
      }
    }

    // 1. Scavenge — only add calls whose (name,args) signature is novel.
    // Scan both channels: reasoning (where R1 leaks JSON calls into
    // <think>) AND content (where it emits DSML markup in regular
    // turns). Joined with a newline so the scanners see the blobs as
    // independent bodies. Dedup below keeps us from inflating if the
    // same call shows up in both — first seen wins.
    const combined = [reasoningContent ?? "", content ?? ""].filter(Boolean).join("\n");
    const scavenged = scavengeToolCalls(combined || null, {
      allowedNames: this.opts.allowedToolNames,
      maxCalls: this.opts.maxScavenge ?? 4,
    });
    const seenSignatures = new Set(declaredCalls.map(signature));
    const merged = [...declaredCalls];
    for (const sc of scavenged.calls) {
      if (!seenSignatures.has(signature(sc))) {
        merged.push(sc);
        report.scavenged++;
        seenSignatures.add(signature(sc));
      }
    }
    report.notes.push(...scavenged.notes);

    // Remove only Markdown blocks that were actually recovered from the content
    // channel. Failed, fenced, or disallowed candidates remain visible prose.
    let cleanedContent = content;
    if (content && scavenged.recoveredRanges.length > 0) {
      const contentStart = reasoningContent ? reasoningContent.length + 1 : 0;
      const contentEnd = contentStart + content.length;
      const contentRanges = scavenged.recoveredRanges
        .filter((range) => range.start >= contentStart && range.end <= contentEnd)
        .map((range) => ({
          start: range.start - contentStart,
          end: range.end - contentStart,
        }))
        .sort((a, b) => b.start - a.start);
      let nextContent = content;
      for (const range of contentRanges) {
        nextContent = nextContent.slice(0, range.start) + nextContent.slice(range.end);
      }
      cleanedContent = nextContent.trim();
    }

    // 2. Argument-JSON repair. First: concatenated-args split — one tool_call
    // whose arguments carry several complete top-level JSON objects. Providers
    // merge parallel-call fragments into a single arguments string (observed on
    // ollama-served models): {"task":"a"}{"task":"b"} — every intended call dies
    // at JSON.parse with "Unexpected non-whitespace character after JSON". One
    // object per call restores the model's intent; the first object keeps the
    // declared call id, the rest get derived ids so results pair up.
    const expanded: ToolCall[] = [];
    for (const call of merged) {
      const split: ArgsSplitResult | null = splitConcatenatedJsonObjects(
        call.function?.arguments ?? "",
      );
      if (split && call.function) {
        call.function.arguments = split.parts[0]!;
        expanded.push(call);
        for (let k = 1; k < split.parts.length; k++) {
          const clone: ToolCall = {
            function: { name: call.function.name, arguments: split.parts[k]! },
          };
          if (call.type !== undefined) clone.type = call.type;
          if (call.id) clone.id = `${call.id}-split${k + 1}`;
          expanded.push(clone);
        }
        report.argsSplitCalls += split.parts.length - 1;
        const overflowNote =
          split.droppedObjects > 0 ? ` (${split.droppedObjects} more objects dropped)` : "";
        report.notes.push(
          `[${call.function.name}] split concatenated arguments into ${split.parts.length} calls${overflowNote}`,
        );
      } else {
        expanded.push(call);
      }
    }
    merged.length = 0;
    merged.push(...expanded);

    // 2b. Truncation repair on argument JSON.
    for (const call of merged) {
      const args = call.function?.arguments ?? "";
      const r = repairTruncatedJson(args);
      if (r.changed) {
        if (r.fallback) {
          // Hard fallback — all repair attempts failed. Leave the
          // original truncated args untouched so tools.ts dispatch
          // rejects them with "invalid JSON" rather than silently
          // running with {} (which would miss required params or
          // succeed with nonsense args). The JSON parse error is more
          // informative to the model than "missing required parameter".
          report.truncationsFixed++;
          report.notes.push(
            ...r.notes.map((n) => `[${call.function?.name}] ⚠️ TRUNCATION UNRECOVERABLE: ${n}`),
          );
        } else {
          call.function.arguments = r.repaired;
          report.truncationsFixed++;
          report.notes.push(...r.notes.map((n) => `[${call.function.name}] ${n}`));
        }
      }
    }

    // 3. Storm breaker.
    const filtered: ToolCall[] = [];
    for (const call of merged) {
      const verdict = this.storm.inspect(call);
      if (verdict.suppress) {
        report.stormsBroken++;
        if (verdict.reason) report.notes.push(verdict.reason);
        continue;
      }
      filtered.push(call);
    }

    return { calls: filtered, report, content: cleanedContent };
  }
}

function signature(call: ToolCall): string {
  return `${call.function?.name ?? ""}::${call.function?.arguments ?? ""}`;
}
