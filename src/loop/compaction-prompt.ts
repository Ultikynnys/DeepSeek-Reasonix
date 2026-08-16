/** Shared compaction-summary prompt helpers (fold summarizer + force-summary).
 *  Extracted here to avoid a context-manager → loop → force-summary import cycle. */

/** Extract the pinned-constraint / memory blocks from the system prompt so a
 *  fold's synthesized summary can carry them verbatim. */
export function extractPinnedConstraints(systemPrompt: string): string {
  // matchAll because the system prompt can carry multiple blocks under the same
  // prefix — e.g. global User memory + per-project User memory, or several
  // Project memory files. Single .match() would only grab the first.
  const pattern =
    /# (?:HIGH PRIORITY constraints|User memory|Project memory)[\s\S]*?(?=\n# |\n---|$)/g;
  return Array.from(systemPrompt.matchAll(pattern), (m) => m[0]).join("\n\n");
}

/** The fold summarizer's instruction — a self-contained recap that preserves the
 *  original objective, negative constraints, decisions, and open todos. */
export function buildFoldSummaryInstruction(pinnedSkillNames: string[]): string {
  const base =
    "Summarize the conversation above as one self-contained prose recap. Preserve the user's " +
    "ORIGINAL OBJECTIVE (never paraphrase away negative constraints like 'do NOT do X'), all " +
    "'do not' / 'never' / 'avoid' instructions, decisions reached, files inspected or modified, " +
    "tool results still relevant, and any open todos. Skip turn-by-turn play-by-play. " +
    "Output plain prose only — no tool calls, no markdown headings, no SEARCH/REPLACE blocks.";
  if (pinnedSkillNames.length === 0) return base;
  const list = pinnedSkillNames.map((n) => `"${n}"`).join(", ");
  return `${base} The following skill memos are pinned verbatim and appended after your summary — do NOT quote or paraphrase their bodies: ${list}.`;
}
