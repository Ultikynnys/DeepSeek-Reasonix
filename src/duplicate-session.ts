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

export function truncateToolOutputsInMarkdown(markdown: string, maxLines = 3): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inToolBlock = false;
  let inCodeFence = false;
  let isJsonArgsFence = false;
  let fenceLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inCodeFence) {
      if (line.startsWith("> **")) {
        inToolBlock = true;
      } else if (line.startsWith("### ") || line === "---") {
        inToolBlock = false;
      }

      if (inToolBlock && line.startsWith("```")) {
        inCodeFence = true;
        isJsonArgsFence = line.startsWith("```json");
        fenceLines = [];
        result.push(line);
        continue;
      }
      result.push(line);
    } else {
      if (line.startsWith("```")) {
        inCodeFence = false;
        if (!isJsonArgsFence && fenceLines.length > maxLines) {
          result.push(...fenceLines.slice(0, maxLines));
        } else {
          result.push(...fenceLines);
        }
        result.push(line);
        fenceLines = [];
        isJsonArgsFence = false;
      } else {
        fenceLines.push(line);
      }
    }
  }

  if (inCodeFence) {
    result.push(...fenceLines);
  }

  return result.join("\n");
}

/** A block's must-survive essence: a user/input block (a `### ` header that is
 *  not `### Reasonix`) is kept whole; an assistant block keeps its `<details>`
 *  thinking. Bare fragments with neither return null (fully droppable). */
function preservedOnly(block: string): string | null {
  const newline = block.indexOf("\n");
  const firstLine = newline === -1 ? block : block.slice(0, newline);
  if (firstLine.startsWith("### ") && firstLine !== "### Reasonix") return block;
  const thinking = block.match(/<details>[\s\S]*?<\/details>/g);
  if (!thinking || thinking.length === 0) return null;
  const header = firstLine.startsWith("### ") ? firstLine : "";
  return [header, ...thinking].filter(Boolean).join("\n\n");
}

/** Keep newest blocks whole until the budget is spent, then keep only each older
 *  block's essence (user input / thinking) so thinking survives; tool cards and
 *  prose drop first. A block too big even for its essence is tail-truncated. */
export function truncateMarkdownToTokens(markdown: string, budget: number): TruncatedContext {
  const trimmed = markdown.trim();
  if (!trimmed) return { text: "", droppedTokens: 0, truncated: false };

  const processed = truncateToolOutputsInMarkdown(trimmed, 3);
  const total = countTokens(processed);
  if (budget <= 0) return { text: "", droppedTokens: total, truncated: total > 0 };
  if (total <= budget) return { text: processed, droppedTokens: 0, truncated: false };

  const blocks = processed.split(BLOCK_SEPARATOR);
  // Reserve each block's essence — a user input in full, or an assistant block's
  // `<details>` thinking — BEFORE spending budget on droppable tool cards and
  // prose, so thinking and user inputs survive over-budget cuts instead of being
  // front-dropped wholesale with the block that carried them.
  const essence = blocks.map((block) => preservedOnly(block));
  const essenceTokens = essence.map((e) => (e === null ? 0 : countTokens(e)));
  const essenceTotal = essenceTokens.reduce((sum, n) => sum + n, 0);

  if (essenceTotal > budget) {
    // Even the essence alone can't fit: keep only its newest slice.
    const essenceStream = essence.filter((e): e is string => e !== null).join(BLOCK_SEPARATOR);
    const text = trailingWithinBudget(essenceStream, budget);
    return { text, droppedTokens: Math.max(0, total - countTokens(text)), truncated: true };
  }

  // Spend what remains upgrading blocks to their full form (newest first) and
  // keeping blocks that carry no essence; older blocks left over stay essence-only.
  const keepFull = blocks.map(() => false);
  let remaining = budget - essenceTotal;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const extra = countTokens(blocks[i]!) - essenceTokens[i]!;
    if (extra <= remaining) {
      keepFull[i] = true;
      remaining -= extra;
    }
  }

  const kept: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (keepFull[i]) kept.push(blocks[i]!);
    else if (essence[i] !== null) kept.push(essence[i]!);
  }

  // A transcript of only huge, thinking-less blocks (nothing reserved, nothing
  // fitting whole) must never collapse to empty — fall back to the newest tail.
  const text =
    kept.length > 0
      ? kept.join(BLOCK_SEPARATOR)
      : trailingWithinBudget(blocks[blocks.length - 1] ?? processed, budget);
  return { text, droppedTokens: Math.max(0, total - countTokens(text)), truncated: true };
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
