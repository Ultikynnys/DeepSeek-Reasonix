/** Trim a session's export markdown to a token budget and append a continuation instruction. */

import { countTokens } from "./tokenizer.js";

/** Message separator used by the desktop export (`formatConversationMarkdown`). */
const BLOCK_SEPARATOR = "\n\n---\n\n";

/** Appended after the truncated transcript. The model must know the context is
 *  incomplete and how to recover the missing pieces rather than inventing them. */
export const DUPLICATE_SESSION_INSTRUCTION = [
  "> **Note for the assistant — this is a truncated context blob.**",
  ">",
  "> This conversation was duplicated from a longer session and trimmed to its most recent portion; older messages were dropped and may hold information you no longer have.",
  ">",
  "> Continue the work exactly where it left off. Do NOT guess or invent missing details: when something is missing or ambiguous, fill the gap by asking the user or by searching the workspace with your tools before proceeding.",
].join("\n");

export interface TruncatedContext {
  /** The retained markdown — the oldest retained block may be tail-truncated to fit. */
  text: string;
  /** Tokens dropped off the front of the transcript. */
  droppedTokens: number;
  /** True when any content was dropped. */
  truncated: boolean;
}

/** Largest trailing slice of `text` whose token count is ≤ `budget`. Binary-searches
 *  the start index (countTokens is O(n), so ~log₂(len) calls); aligns away from a
 *  lone low surrogate so a slice never splits a UTF-16 pair (issue #1970). */
function trailingWithinBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (countTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (countTokens(text.slice(mid)) <= budget) hi = mid;
    else lo = mid + 1;
  }
  let start = lo;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

/** Keep the newest blocks until the budget is spent; the oldest retained block is
 *  tail-truncated to fill whatever budget remains. */
export function truncateMarkdownToTokens(markdown: string, budget: number): TruncatedContext {
  const trimmed = markdown.trim();
  if (!trimmed) return { text: "", droppedTokens: 0, truncated: false };

  const total = countTokens(trimmed);
  if (budget <= 0) return { text: "", droppedTokens: total, truncated: total > 0 };
  if (total <= budget) return { text: trimmed, droppedTokens: 0, truncated: false };

  const blocks = trimmed.split(BLOCK_SEPARATOR);
  const kept: string[] = [];
  let remaining = budget;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const blockTokens = countTokens(block);
    if (blockTokens <= remaining) {
      kept.unshift(block);
      remaining -= blockTokens;
      continue;
    }
    const tail = trailingWithinBudget(block, remaining);
    if (tail) kept.unshift(tail);
    break;
  }

  const text = kept.join(BLOCK_SEPARATOR);
  const keptTokens = countTokens(text);
  return { text, droppedTokens: Math.max(0, total - keptTokens), truncated: true };
}

/** Full new-session seed: a truncation header (only when something was dropped),
 *  the retained transcript, and the continuation instruction. */
export function buildDuplicateContext(markdown: string, budget: number): string {
  const { text, truncated } = truncateMarkdownToTokens(markdown, budget);
  const header = truncated
    ? `_Truncated continuation context — only the most recent ~${budget.toLocaleString()} tokens of the previous session were kept._`
    : "";
  return [header, text, DUPLICATE_SESSION_INSTRUCTION].filter(Boolean).join(BLOCK_SEPARATOR);
}
