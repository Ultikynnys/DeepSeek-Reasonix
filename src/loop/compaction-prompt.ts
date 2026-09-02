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

/** The fold summarizer's instruction — a durable, structured resume briefing
 *  (backported from upstream's cache-aware compaction). */
export function buildFoldSummaryInstruction(pinnedSkillNames: string[]): string {
  const base =
    "Compact the preceding conversation into a durable resume briefing. " +
    "Write under these exact headings, omitting a heading only if it has no content:\n\n" +
    "## Standing facts & constraints\n" +
    'Everything the user stated that still governs the work — names, paths, IDs, versions, tokens, preferences, and hard "never do X" rules — in their own words. Be exhaustive; this is the durable contract, so prefer over- to under-including.\n\n' +
    "## Goal\n" +
    "The user's request and intent.\n\n" +
    "## Decisions & rationale\n" +
    "Key choices made so far and why — so they are not re-litigated or reversed.\n\n" +
    "## Files & code\n" +
    "Files read or modified, with the specific facts that matter: signatures, line locations, data shapes, and exact edits applied. Be concrete; this is what lets the agent act without re-reading everything.\n\n" +
    "## Commands & outcomes\n" +
    "Commands run (builds, tests, git) and their relevant results — what passed, what failed, and the error text that matters.\n\n" +
    "## Errors & fixes\n" +
    "Problems hit and how they were resolved (or not), so the same dead ends are not repeated.\n\n" +
    "## Pending & next step\n" +
    "What is still in progress or unstarted, and the single most concrete next action to take.\n\n" +
    "Rules: be terse — bullet points and fragments, not prose. Preserve identifiers, paths, and numbers exactly. Merge valid facts from any earlier conversation-history summary and drop facts superseded by later messages. Do NOT invent anything not present in the messages; if something is unknown, leave it out rather than guessing. Output only the structured Markdown briefing. Do not call tools. Do not output reasoning.";
  if (pinnedSkillNames.length === 0) return base;
  const list = pinnedSkillNames.map((n) => `"${n}"`).join(", ");
  return `${base} The following skill memos are pinned verbatim and appended after your summary — do NOT quote or paraphrase their bodies: ${list}.`;
}
