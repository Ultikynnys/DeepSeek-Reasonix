/** OpenAI Responses API (v1/responses) conversion for chatgpt.com's codex
 *  backend, which 400-rejects chat-completions payloads. */

import type { ChatMessage, ChatRequestOptions, ToolCall } from "./types.js";

export interface ResponsesInputItem {
  type: string;
  [k: string]: unknown;
}

// Build the `content` field for a Responses API message: plain string for
// text-only (bypasses the type enum — works across backend deployments that
// disagree on input_text vs output_text), array for mixed text+image content.
function contentParts(content: ChatMessage["content"]): string | ResponsesInputItem[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content; // plain string — safest across backends
  // If the array has no images, join the text parts into a single string.
  if (content.every((p) => p.type === "text")) {
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) textParts.push(part.text);
    }
    return textParts.join("\n");
  }
  // Mixed content — use input_text / input_image parts.
  const parts: ResponsesInputItem[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "input_text", text: part.text });
    } else {
      // Responses input_image takes the URL as a bare string (chat
      // completions wraps it in { url, detail }).
      parts.push({
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      });
    }
  }
  return parts;
}

/** Split messages: leading system text → top-level `instructions` (like the
 *  Codex CLI), the rest → `input` items (system becomes developer role). */
function splitMessages(messages: ChatMessage[]): {
  instructions: string;
  items: ResponsesInputItem[];
} {
  const systemTexts: string[] = [];
  const items: ResponsesInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system": {
        if (items.length === 0 && typeof m.content === "string") {
          systemTexts.push(m.content);
        } else {
          // Always send content (even empty) — the wire schema requires it.
          items.push({ type: "message", role: "developer", content: contentParts(m.content) });
        }
        break;
      }
      case "user": {
        items.push({ type: "message", role: "user", content: contentParts(m.content) });
        break;
      }
      case "assistant": {
        items.push({
          type: "message",
          role: "assistant",
          content: contentParts(m.content),
        });
        for (const tc of m.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc.id ?? "",
            name: tc.function.name,
            arguments: tc.function.arguments ?? "",
          });
        }
        break;
      }
      case "tool": {
        items.push({
          type: "function_call_output",
          call_id: m.tool_call_id ?? "",
          output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        });
        break;
      }
    }
  }
  return { instructions: systemTexts.join("\n\n"), items };
}

/** Chat-completions → Responses payload (mirrors the Codex CLI): top-level
 *  instructions, `input` items, flat tools, reasoning.effort, store:false.
 *  Chat-completions-only fields are omitted — the endpoint 400s unknowns. */
export function buildResponsesPayload(
  opts: ChatRequestOptions,
  stream: boolean,
): Record<string, unknown> {
  const { instructions, items } = splitMessages(opts.messages);
  const payload: Record<string, unknown> = {
    model: opts.model,
    input: items,
    stream,
    // The Codex CLI always sends store:false to chatgpt.com.
    store: false,
  };
  if (instructions) payload.instructions = instructions;
  if (opts.tools?.length) {
    payload.tools = opts.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
  if (opts.reasoningEffort) {
    // Responses nests effort under `reasoning`; `summary: "concise"` mirrors
    // the Codex CLI so reasoning summaries stream back to the UI.
    payload.reasoning = { effort: opts.reasoningEffort, summary: "concise" };
  }
  return payload;
}

export interface ParsedResponsesOutput {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
}

/** Non-streaming Responses envelope → the client's ChatResponse shape. */
export function parseResponsesOutput(data: unknown): ParsedResponsesOutput {
  const output = (data as { output?: unknown })?.output;
  if (!Array.isArray(output)) return { content: "", reasoningContent: null, toolCalls: [] };
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as {
      type?: unknown;
      content?: unknown;
      summary?: unknown;
      name?: unknown;
      arguments?: unknown;
      call_id?: unknown;
    };
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "output_text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          content += (part as { text: string }).text;
        }
      }
    } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "summary_text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          reasoning += (part as { text: string }).text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : undefined,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        },
      });
    }
  }
  return { content, reasoningContent: reasoning || null, toolCalls };
}

/** Error envelope of an HTTP-200 Responses body (e.g. { error: { message } }). */
export function responsesErrorFromData(data: unknown): string | null {
  const err = (data as { error?: { message?: unknown } })?.error;
  return err && typeof err.message === "string" ? err.message : null;
}
