import type { ChatMessage, UserContentPart } from "./types.js";

/** Delimiter line that opens each block. Restricted to the known labels so a
 *  content line that merely looks like a separator can't be mistaken for one. */
const HEADER_RE = /^===== (system|user|assistant|thinking|tool)(?::\s*(.+?))? =====[ \t]*$/;
/** Trailing informational marker appended to assistant blocks that carried
 *  tool_calls. Stripped on re-parse so it never leaks into edited content. */
const TOOL_CALLS_NOTE_RE = /^\[tool_calls: .*\]$/;

export interface ContextPlaintextInput {
  system: string;
  messages: readonly ChatMessage[];
}

export interface ParsedContext {
  system: string;
  messages: ChatMessage[];
}

/** Collapse a message body (string or multimodal parts) to plain text. Images
 *  become a placeholder (they can't survive an editable plaintext round-trip). */
function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: UserContentPart) => (part.type === "text" ? part.text : "[image]"))
      .join("");
  }
  return "";
}

/** Render the full request context (system prompt + conversation) as editable
 *  plaintext: one `===== role =====` block per message, plus a `thinking` block
 *  before each assistant turn that carries reasoning. */
export function serializeContext(input: ContextPlaintextInput): string {
  const blocks: string[] = [`===== system =====\n${input.system.trimEnd()}`];
  for (const m of input.messages) {
    // The system prompt is rendered once, from the prefix (never twice).
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const name = m.name;
      const body = contentToText(m.content).trimEnd();
      blocks.push(`===== tool${name ? `: ${name}` : ""} =====\n${body}`);
      continue;
    }
    if (m.role === "assistant") {
      const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
      if (reasoning.length > 0) blocks.push(`===== thinking =====\n${reasoning}`);
    }
    const lines = [contentToText(m.content).trimEnd()];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const names = m.tool_calls.map((c) => c.function?.name ?? "?").join(", ");
      lines.push(`[tool_calls: ${names}]`);
    }
    blocks.push(`===== ${m.role} =====\n${lines.join("\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Parse edited plaintext back to `{ system, messages }`. A `thinking` block
 *  attaches as reasoning to the following assistant message; tool blocks and
 *  the `[tool_calls: …]` note are dropped, so callers re-heal before applying. */
export function parseContext(text: string): ParsedContext {
  const blocks: Array<{ label: string; lines: string[] }> = [];
  let cur: { label: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (cur) blocks.push(cur);
      cur = { label: header[1] as string, lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
    // Text before the first header (e.g. a stray leading newline) is ignored.
  }
  if (cur) blocks.push(cur);

  let system = "";
  // A thinking block renders before its assistant turn; hold it until then.
  let pendingReasoning: string | null = null;
  const messages: ChatMessage[] = [];
  for (const block of blocks) {
    const body = block.lines
      .filter((l) => !TOOL_CALLS_NOTE_RE.test(l))
      .join("\n")
      .replace(/\s+$/, "");
    if (block.label === "system") {
      system = body;
    } else if (block.label === "thinking") {
      pendingReasoning = body;
    } else if (block.label === "user") {
      pendingReasoning = null;
      messages.push({ role: "user", content: body });
    } else if (block.label === "assistant") {
      const assistant: ChatMessage = { role: "assistant", content: body };
      if (pendingReasoning !== null) assistant.reasoning_content = pendingReasoning;
      pendingReasoning = null;
      messages.push(assistant);
    }
    // `tool` blocks are intentionally dropped (see doc comment).
  }
  return { system, messages };
}
