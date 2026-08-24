import type { DeepSeekClient, Usage } from "../client.js";
import type { ReasoningEffort } from "../config.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../types.js";
import { looksLikeCompleteJson } from "./shrink.js";
import { thinkingModeForModel } from "./thinking.js";
import type { LoopEvent } from "./types.js";

export interface StreamModelOptions {
  client: DeepSeekClient;
  model: string;
  messages: ChatMessage[];
  toolSpecs: readonly ToolSpec[];
  signal: AbortSignal;
  reasoningEffort: ReasoningEffort;
  /** Per-turn output token cap forwarded to the stream as `max_tokens`. Undefined = no cap. */
  maxTokens?: number;
  turn: number;
}

export interface StreamModelResult {
  assistantContent: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  /** Last non-empty finish reason from the stream (e.g. ollama `done_reason`). */
  finishReason?: string;
}

export async function* streamModelResponse(
  opts: StreamModelOptions,
): AsyncGenerator<LoopEvent, StreamModelResult, void> {
  const { client, model, messages, toolSpecs, signal, reasoningEffort, maxTokens, turn } = opts;
  let assistantContent = "";
  let reasoningContent = "";
  let usage: Usage | null = null;
  let finishReason: string | undefined;
  const callBuf: Map<number, ToolCall> = new Map();
  const readyIndices = new Set<number>();
  let emittedOutput = false;

  try {
    for await (const chunk of client.stream({
      model,
      messages,
      tools: toolSpecs.length ? toolSpecs : undefined,
      signal,
      thinking: thinkingModeForModel(model),
      reasoningEffort,
      maxTokens,
    })) {
      if (chunk.reasoningDelta) {
        // Reasoning is rendered transiently but is not persisted until the
        // stream completes. It is therefore safe to replay a stream that
        // terminates after reasoning-only deltas; marking it partial here
        // incorrectly disables the loop's bounded body-read retry.
        reasoningContent += chunk.reasoningDelta;
        yield {
          turn,
          role: "assistant_delta",
          content: "",
          reasoningDelta: chunk.reasoningDelta,
        };
      }
      if (chunk.contentDelta) {
        emittedOutput = true;
        assistantContent += chunk.contentDelta;
        yield {
          turn,
          role: "assistant_delta",
          content: chunk.contentDelta,
        };
      }
      if (chunk.toolCallDelta) {
        const d = chunk.toolCallDelta;
        const cur = callBuf.get(d.index) ?? {
          id: d.id,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (d.id) cur.id = d.id;
        if (d.name) cur.function.name = (cur.function.name ?? "") + d.name;
        if (d.argumentsDelta)
          cur.function.arguments = (cur.function.arguments ?? "") + d.argumentsDelta;
        callBuf.set(d.index, cur);

        if (
          !readyIndices.has(d.index) &&
          cur.function.name &&
          looksLikeCompleteJson(cur.function.arguments ?? "")
        ) {
          readyIndices.add(d.index);
        }

        if (cur.function.name) {
          emittedOutput = true;
          yield {
            turn,
            role: "tool_call_delta",
            content: "",
            toolName: cur.function.name,
            toolCallArgsChars: (cur.function.arguments ?? "").length,
            toolCallIndex: d.index,
            toolCallReadyCount: readyIndices.size,
          };
        }
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
  } catch (err) {
    // The loop may safely replay a body-read failure only when no assistant
    // bytes or tool-call progress reached the UI. Mark partial streams so the
    // retry path cannot append a second response to a settled card.
    if (emittedOutput && typeof err === "object" && err !== null) {
      (err as { partialDelivered?: boolean }).partialDelivered = true;
    }
    throw err;
  }

  return {
    assistantContent,
    reasoningContent,
    toolCalls: [...callBuf.values()],
    usage,
    finishReason,
  };
}
