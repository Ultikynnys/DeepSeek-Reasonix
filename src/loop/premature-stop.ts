// Premature-stop detection: conservative mid-thought signals only. False
// positives cost one bounded extra round-trip; the loop gates on tool activity
// so plain Q&A answers are never re-prompted.

// Trailing characters that mean the sentence continues — the model was cut
// off right after announcing something ("...give me the patterns:"). `|` and
// `>` excluded: a complete markdown table row or blockquote can end on them.
const MID_THOUGHT_TRAILING = new Set([":", ";", ",", "(", "[", "{", "+", "=", "&", "-", "*"]);

/** Last line is a markdown divider (--- / *** / ___) — a deliberate closer, not mid-thought. */
const DIVIDER_LINE = /^\s*(?:[-*_]\s*){3,}$/;

// Lines narrating the next step of work. "Next steps: run npm test" is a
// legitimate closer — a colon reads as structured guidance, not a cut-off.
const NARRATION_STARTER =
  /^(?:now|next|then|remaining|let me|moving on|continuing|first|second|third|okay|alright|so)\b/i;

/** Odd code-fence count = the reply ends inside an opened block (cut off mid-code). */
const FENCE_LINE = /^[ \t]*```/;

export function looksLikePrematureStop(content: string): boolean {
  const text = content.trimEnd();
  if (text.length === 0) return false;

  const lines = text.split("\n");
  const fenceCount = lines.filter((l) => FENCE_LINE.test(l)).length;
  if (fenceCount % 2 === 1) return true;

  const lastLine = lines[lines.length - 1] ?? "";
  if (DIVIDER_LINE.test(lastLine)) return false;

  const last = text[text.length - 1]!;
  if (MID_THOUGHT_TRAILING.has(last)) return true;

  const trimmedLast = lastLine.trim();
  return (
    NARRATION_STARTER.test(trimmedLast) &&
    // "Next steps: run npm test" is a legitimate closer — a line that already
    // carries a colon reads as structured guidance, not a cut-off thought.
    !trimmedLast.includes(":") &&
    !/[.!?,;)]$/.test(trimmedLast) &&
    trimmedLast.length <= 120
  );
}
