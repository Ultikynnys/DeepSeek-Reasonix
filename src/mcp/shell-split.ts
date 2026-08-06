/** Quote-aware argv splitting shared by `--mcp` (shellSplit), the allowlist
 *  tokenizer (tokenizeCommand), and operator detection. NOT a full parser. */

export type DqEscapeMode = "any" | "quote-and-backslash";

export interface ShellToken {
  text: string;
  /** True when the token contained quoted content — lets operator detection skip it. */
  quoted: boolean;
}

export type ShellSplitResult = { tokens: ShellToken[] } | { unterminated: '"' | "'" };

/** Inside `"…"` only `\"` and `\\` are escapes — `\X` otherwise stays literal
 *  so Windows paths like `"C:\Users\foo\.bar"` survive tokenization. */
export function isDqEscape(prev: string, next: string | undefined): boolean {
  return prev === "\\" && (next === '"' || next === "\\");
}

/** Shared quote-state machine. `dqEscape: "any"` strips a backslash before any
 *  character inside double quotes (legacy shellSplit behavior); `"quote-and-backslash"`
 *  only treats `\"` and `\\` as escapes (tokenizeCommand / detectShellOperator). */
export function splitShellTokens(input: string, dqEscape: DqEscapeMode): ShellSplitResult {
  const tokens: ShellToken[] = [];
  let cur = "";
  let curQuoted = false;
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    if (cur.length > 0) {
      tokens.push({ text: cur, quoted: curQuoted });
      cur = "";
      curQuoted = false;
    }
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (dqEscape === "any" || next === '"' || next === "\\") {
          cur += next;
          curQuoted = true;
          i += 2;
          continue;
        }
      }
      cur += ch;
      curQuoted = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    // Backslash escapes ONLY apply inside double quotes (handled above).
    // Outside quotes, backslashes pass through literally — otherwise
    // Windows paths like `C:\path\to\exe` get mangled. POSIX users who
    // want to escape a space outside quotes can use single quotes instead.
    if (ch === " " || ch === "\t") {
      push();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (quote) return { unterminated: quote };
  push();
  return { tokens };
}

/** Split for `--mcp`; throws on unterminated quotes. */
export function shellSplit(input: string): string[] {
  const r = splitShellTokens(input, "any");
  if ("unterminated" in r) {
    throw new Error(
      `shellSplit: unterminated ${r.unterminated === '"' ? "double" : "single"} quote in input`,
    );
  }
  return r.tokens.map((t) => t.text);
}
