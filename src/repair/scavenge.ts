/** Recover intended tool calls that models emitted as text instead of structured `tool_calls`. */

import { type EditBlock, parseEditBlocks } from "../code/edit-blocks.js";
import type { ToolCall } from "../types.js";

export interface ScavengeOptions {
  /** Names of tools the model may legitimately call. Other names are ignored. */
  allowedNames: ReadonlySet<string>;
  /** Maximum number of calls to scavenge per pass (defence against runaway). */
  maxCalls?: number;
}

export interface ScavengeResult {
  calls: ToolCall[];
  notes: string[];
  /** Text ranges occupied by calls recovered from Markdown. */
  recoveredRanges: ScavengeRange[];
}

export interface ScavengeRange {
  start: number;
  end: number;
}

/** Bounds the regex input — DSML matchers are O(n²) on adversarial input per CodeQL js/polynomial-redos. */
const MAX_SCAVENGE_INPUT = 100 * 1024;

/** Recovers tool names corrupted by repetition stalls (e.g. "read_fileread_fileread_file..." → "read_file"). */
export function repairRepeatingToolName(
  name: string,
  allowedNames: ReadonlySet<string>,
): string | null {
  if (allowedNames.has(name)) return name;
  for (const candidate of allowedNames) {
    if (candidate.length === 0 || name.length <= candidate.length) continue;
    if (!name.startsWith(candidate)) continue;
    let pos = 0;
    let isRepeat = true;
    while (pos < name.length) {
      const remaining = name.length - pos;
      if (remaining >= candidate.length) {
        if (name.slice(pos, pos + candidate.length) !== candidate) {
          isRepeat = false;
          break;
        }
        pos += candidate.length;
      } else {
        if (candidate.slice(0, remaining) !== name.slice(pos)) {
          isRepeat = false;
        }
        break;
      }
    }
    if (isRepeat && pos >= candidate.length * 2) {
      return candidate;
    }
  }
  return null;
}

export function scavengeToolCalls(
  reasoningContent: string | null | undefined,
  opts: ScavengeOptions,
): ScavengeResult {
  if (!reasoningContent) return { calls: [], notes: [], recoveredRanges: [] };
  if (reasoningContent.length > MAX_SCAVENGE_INPUT) {
    return {
      calls: [],
      notes: [`scavenge skipped: reasoning_content too large (${reasoningContent.length} chars)`],
      recoveredRanges: [],
    };
  }
  const max = opts.maxCalls ?? 4;
  const notes: string[] = [];
  const out: ToolCall[] = [];
  const recoveredRanges: ScavengeRange[] = [];

  // Pattern A: DSML invoke blocks. R1 sometimes emits tool calls as
  // its chat-template markup in the content channel instead of the
  // proper `tool_calls` field. 0.4.3 stripped these from display;
  // here we actually turn them back into proper ToolCalls so the
  // model's intent isn't lost.
  for (const invoke of iterateDsmlInvokes(reasoningContent)) {
    if (out.length >= max) break;
    const resolvedName = opts.allowedNames.has(invoke.name)
      ? invoke.name
      : repairRepeatingToolName(invoke.name, opts.allowedNames);
    if (!resolvedName) continue;
    out.push({
      function: {
        name: resolvedName,
        arguments: JSON.stringify(invoke.args),
      },
    });
    notes.push(`scavenged DSML call: ${resolvedName}`);
  }

  // Pattern B: native Reasonix SEARCH/REPLACE blocks. Some models emit the
  // edit protocol as Markdown content instead of calling the corresponding
  // filesystem tool. Only complete, unfenced blocks accepted by the canonical
  // parser and backed by an offered tool are executable.
  const editBlocks = parseEditBlocks(reasoningContent);
  for (const block of editBlocks) {
    if (out.length >= max) break;
    if (isInsideMarkdownFence(reasoningContent, block.offset)) continue;
    const call = editBlockToToolCall(block, opts.allowedNames);
    if (!call) continue;
    out.push(call);
    recoveredRanges.push(editBlockRange(reasoningContent, block));
    notes.push(`scavenged Markdown call: ${call.function.name}`);
  }

  // Pattern C: raw JSON objects (the original three shapes). Strip DSML and
  // edit blocks first so JSON in their parameter/replacement bodies cannot be
  // mistaken for an additional standalone call.
  const standaloneText = stripDsmlBlocks(stripEditBlocks(reasoningContent, editBlocks));
  for (const candidate of iterateJsonObjects(standaloneText)) {
    if (out.length >= max) break;
    const call = coerceToToolCall(candidate, opts.allowedNames);
    if (call) {
      out.push(call);
      notes.push(`scavenged call: ${call.function.name}`);
    }
  }
  return { calls: out, notes, recoveredRanges };
}

interface DsmlInvoke {
  name: string;
  args: Record<string, unknown>;
}

function editBlockToToolCall(block: EditBlock, allowedNames: ReadonlySet<string>): ToolCall | null {
  if (block.search.length === 0) {
    if (!allowedNames.has("write_file")) return null;
    return {
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: block.path, content: block.replace }),
      },
    };
  }
  if (!allowedNames.has("edit_file")) return null;
  return {
    function: {
      name: "edit_file",
      arguments: JSON.stringify({
        path: block.path,
        search: block.search,
        replace: block.replace,
      }),
    },
  };
}

function editBlockRange(text: string, block: EditBlock): ScavengeRange {
  const closingLine = "\n>>>>>>> REPLACE";
  const closingStart = text.indexOf(closingLine, block.offset);
  return {
    start: block.offset,
    end: closingStart < 0 ? block.offset : closingStart + closingLine.length,
  };
}

function isInsideMarkdownFence(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);
  const fences = prefix.match(/^\s*```/gm);
  return (fences?.length ?? 0) % 2 === 1;
}

function stripEditBlocks(text: string, blocks: readonly EditBlock[]): string {
  let out = text;
  const ranges = blocks.map((block) => editBlockRange(text, block));
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, range.start) + out.slice(range.end);
  }
  return out;
}

/** Strips DSML invoke blocks so the raw-JSON scanner doesn't re-scavenge their parameter payloads. */
function stripDsmlBlocks(text: string): string {
  let out = text;
  out = out.replace(/<[｜|]DSML[｜|]function_calls>[\s\S]*?<\/?[｜|]DSML[｜|]function_calls>/g, "");
  out = out.replace(/<[｜|]DSML[｜|]invoke\s+[^>]*>[\s\S]*?<\/[｜|]DSML[｜|]invoke>/g, "");
  return out;
}

function* iterateDsmlInvokes(text: string): Generator<DsmlInvoke> {
  // `｜` (U+FF5C) in practice; `|` (ASCII) as a fallback seen in a
  // minority of builds. `[｜|]` inside the regex covers both.
  const INVOKE_RE = /<[｜|]DSML[｜|]invoke\s+name="([^"]+)">([\s\S]*?)<\/[｜|]DSML[｜|]invoke>/g;
  for (const match of text.matchAll(INVOKE_RE)) {
    const name = match[1];
    const body = match[2];
    if (!name || body === undefined) continue;
    yield { name, args: parseDsmlParameters(body) };
  }
}

/** Falls back to literal text when `string="false"` JSON parse fails — never lose the parameter. */
function parseDsmlParameters(body: string): Record<string, unknown> {
  const PARAM_RE =
    /<[｜|]DSML[｜|]parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/g;
  const args: Record<string, unknown> = {};
  for (const m of body.matchAll(PARAM_RE)) {
    const key = m[1];
    const stringFlag = m[2];
    const raw = (m[3] ?? "").trim();
    if (!key) continue;
    if (stringFlag === "false") {
      try {
        args[key] = JSON.parse(raw);
        continue;
      } catch {
        // Fall through — keep as literal so the information isn't lost.
      }
    }
    args[key] = raw;
  }
  return args;
}

/** Yield every top-level JSON object substring in `text`. */
function* iterateJsonObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === "\\") {
          escaped = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

function coerceToToolCall(
  candidateJson: string,
  allowedNames: ReadonlySet<string>,
): ToolCall | null {
  let parsed: any;
  try {
    parsed = JSON.parse(candidateJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  // Pattern 1: { name, arguments }
  if (typeof parsed.name === "string") {
    const resolvedName = allowedNames.has(parsed.name)
      ? parsed.name
      : repairRepeatingToolName(parsed.name, allowedNames);
    if (resolvedName) {
      const args = parsed.arguments;
      return {
        function: {
          name: resolvedName,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      };
    }
  }

  // Pattern 2: OpenAI-style { type: "function", function: { name, arguments } }
  if (parsed.type === "function" && parsed.function && typeof parsed.function.name === "string") {
    const resolvedName = allowedNames.has(parsed.function.name)
      ? parsed.function.name
      : repairRepeatingToolName(parsed.function.name, allowedNames);
    if (resolvedName) {
      const args = parsed.function.arguments;
      return {
        type: "function",
        function: {
          name: resolvedName,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      };
    }
  }

  // Pattern 3: { tool_name, tool_args } (R1 free-form variant)
  if (typeof parsed.tool_name === "string") {
    const resolvedName = allowedNames.has(parsed.tool_name)
      ? parsed.tool_name
      : repairRepeatingToolName(parsed.tool_name, allowedNames);
    if (resolvedName) {
      return {
        function: {
          name: resolvedName,
          arguments: JSON.stringify(parsed.tool_args ?? {}),
        },
      };
    }
  }

  return null;
}
