// Compaction step 3: ask the model which files remain relevant.
//
// Steps 1-2 (summary fold, prune unused reads) shrink the LOG, but not the
// session's file list: the desktop "Files in context" panel is derived from
// every path a tool call ever touched and nothing ever removes entries, so a
// long session's count only grows. This step runs during the fold and asks
// the model to classify every path the session touched as still relevant
// (keep) or no longer needed (drop).
//
// The drops are surfaced two ways:
//   1. FoldResult.droppedFiles — the UI drops them from the panel live.
//   2. A machine-readable marker appended to the fold's summary message, so a
//      session reload re-derives the same reduced list (and the model knows
//      which files were cleared on the next turn). The marker itself is
//      single-sourced in @reasonix/core-utils (compaction.ts) — shared with
//      the desktop panel that parses it.
//
// Pure: every function here is side-effect free so the parse and prompt logic
// are unit-testable without a client. Fail-open by design: any parse hiccup
// means "keep everything" — relevance is advisory, never a reason to abort a
// fold.

import { extractPathsFromArgs, isFilePathTool } from "@reasonix/core-utils";

/** Distinct file paths the session's tool calls have touched — the exact set the
 *  desktop "Files in context" panel tracks (read_file / write_file / edit_file /
 *  multi_edit with `path` or `edits[].path` args). */
export function collectContextFilePaths(
  messages: readonly { role: string; tool_calls?: unknown }[],
): string[] {
  const out = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls as Array<{
      function?: { name?: unknown; arguments?: string };
    }>) {
      const name = call.function?.name;
      if (typeof name !== "string" || !isFilePathTool(name)) continue;
      for (const p of extractPathsFromArgs(call.function?.arguments)) out.add(p);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export interface FileTriage {
  keep: string[];
  drop: string[];
}

/** Parses the model's JSON answer. Robust by construction: fences/prose tolerated,
 *  unknown `drop` entries ignored, unmentioned paths kept, malformed → all-keep. */
export function parseFileTriage(
  raw: string | null | undefined,
  allPaths: readonly string[],
): FileTriage {
  const keep = new Set<string>();
  const drop = new Set<string>();
  for (const p of allPaths) keep.add(p);
  if (!raw) return { keep: [...keep], drop: [] };

  let candidate = raw.trim();
  // Strip a markdown code fence if present (```json … ``` or bare ```…```).
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidate = fenced[1].trim();
  const open = candidate.indexOf("{");
  const close = candidate.lastIndexOf("}");
  if (open === -1 || close <= open) return { keep: [...keep], drop: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(open, close + 1));
  } catch {
    return { keep: [...keep], drop: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { keep: [...keep], drop: [] };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of ["keep", "drop"] as const) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string" || entry.length === 0) continue;
      if (!keep.has(entry)) continue; // unknown path — ignore
      if (key === "drop") {
        keep.delete(entry);
        drop.add(entry);
      }
    }
  }
  return { keep: [...keep], drop: [...drop] };
}

/** Instruction for the triage call — compact on purpose: the prompt ships the
 *  fresh fold summary plus the path list, NOT the folded head, so this step
 *  costs a small request instead of a second prefill of the conversation. */
export function buildFileTriageInstruction(summary: string, allPaths: readonly string[]): string {
  const list = allPaths.map((p) => `- ${p}`).join("\n");
  return `A session tracks every file its tool calls have touched in a "Files in context" panel. The conversation was just compacted into the summary below. Decide which of the listed files remain relevant to the user's ORIGINAL OBJECTIVE and the ongoing work, and which can be dropped from the panel because they were one-off reads, superseded, or no longer part of the work.

[FOLD SUMMARY]
${summary}

[FILES TO CLASSIFY]
${list}

Reply with ONLY a JSON object of the form {"keep": ["path1", ...], "drop": ["path2", ...]}. Every path listed above must appear in exactly one of the two arrays, copied exactly as written. When unsure, keep. No prose, no markdown fences.`;
}
