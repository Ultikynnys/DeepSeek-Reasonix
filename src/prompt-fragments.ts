/** Shared prompt fragments — single source so house-style rules can't drift across agent/subagent/skill prompts. */

/** Embedded literally — no interpolation, so prefix-cache hash stays stable across sessions. */
export const TUI_FORMATTING_RULES = `Formatting (rendered in a TUI with a real markdown renderer):
- Tabular data → GitHub-Flavored Markdown tables with ASCII pipes (\`| col | col |\` header + \`| --- | --- |\` separator). Never use Unicode box-drawing characters (│ ─ ┼ ┌ ┐ └ ┘ ├ ┤) — they look intentional but break terminal word-wrap and render as garbled columns at narrow widths.
- Keep table cells short (one phrase each). If a cell needs a paragraph, use bullets below the table instead.
- Code, file paths with line ranges, and shell commands → fenced code blocks (\`\`\`).
- Do NOT draw decorative frames around content with \`┌──┐ │ └──┘\` characters. The renderer adds its own borders; extra ASCII art adds noise and shatters at narrow widths.
- For flow charts and diagrams: a plain bullet list with \`→\` or \`↓\` between steps. Don't try to draw boxes-and-arrows in ASCII; it never survives word-wrap.`;

/** Model identity note used by session prompts. Models must complete work directly. */
export function escalationContract(modelId: string): string {
  return `You are running on \`${modelId}\`. Deliver the strongest answer you can directly. Do not stop merely because a task is difficult or uncertain. If asked which model you are, answer \`${modelId}\`.`;
}

/** Backward-compatible export retained for public API consumers. */
export const ESCALATION_CONTRACT = escalationContract("deepseek-v4-flash");

export const NEGATIVE_CLAIM_RULE = `Negative claims ("X is missing", "Y isn't implemented", "there's no Z") are the #1 hallucination shape. They feel safe to write because no citation seems possible — but that's exactly why you must NOT write them on instinct.

If you have a search tool (\`search_content\`, \`grep\`, web search), call it FIRST before asserting absence:
- Returns matches → you were wrong; correct yourself and cite the matches.
- Returns nothing → state the absence WITH the search query as evidence: \`No callers of \\\`foo()\\\` found (search_content "foo").\`

If you have no search tool, qualify hard: "I haven't verified — this is a guess." Never assert absence with fake authority.`;
