import type { DeepSeekClient, Usage } from "../client.js";
import type { ReasoningEffort } from "../config.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../types.js";
import { StreamRepetitionDetector } from "./repetition.js";
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
  /** Model-generated image (Antigravity inlineData part) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
  /** Exact-periodic output detected while the provider was still streaming. */
  repetitionStall?: {
    channel: "content" | "reasoning" | "tool_call";
    period: number;
    repeatedChars: number;
  };
}

export async function* streamModelResponse(
  opts: StreamModelOptions,
): AsyncGenerator<LoopEvent, StreamModelResult, void> {
  const { client, model, messages, toolSpecs, signal, reasoningEffort, maxTokens, turn } = opts;
  let assistantContent = "";
  let reasoningContent = "";
  let usage: Usage | null = null;
  let finishReason: string | undefined;
  let image: { dataUrl: string; mimeType: string } | undefined;
  let repetitionStall: StreamModelResult["repetitionStall"];
  const contentRepetition = new StreamRepetitionDetector();
  const reasoningRepetition = new StreamRepetitionDetector();
  const toolNameRepetitions = new Map<number, StreamRepetitionDetector>();
  const toolArgsRepetitions = new Map<number, StreamRepetitionDetector>();
  const stallAbort = new AbortController();
  const requestSignal = AbortSignal.any([signal, stallAbort.signal]);
  const callBuf: Map<number, ToolCall> = new Map();
  const readyIndices = new Set<number>();
  let emittedOutput = false;

  try {
    for await (const chunk of client.stream({
      model,
      messages,
      tools: toolSpecs.length ? toolSpecs : undefined,
      signal: requestSignal,
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
        const repetition = reasoningRepetition.append(chunk.reasoningDelta);
        if (repetition) {
          reasoningContent = reasoningContent.slice(0, repetition.safeLength);
          repetitionStall = {
            channel: "reasoning",
            period: repetition.period,
            repeatedChars: repetition.repeatedChars,
          };
          stallAbort.abort(new Error("Repetitive reasoning stream stopped"));
          break;
        }
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
        const repetition = contentRepetition.append(chunk.contentDelta);
        if (repetition) {
          assistantContent = assistantContent.slice(0, repetition.safeLength);
          repetitionStall = {
            channel: "content",
            period: repetition.period,
            repeatedChars: repetition.repeatedChars,
          };
          stallAbort.abort(new Error("Repetitive content stream stopped"));
          break;
        }
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
        if (d.name) {
          cur.function.name = (cur.function.name ?? "") + d.name;
          let nameRep = toolNameRepetitions.get(d.index);
          if (!nameRep) {
            nameRep = new StreamRepetitionDetector();
            toolNameRepetitions.set(d.index, nameRep);
          }
          const repetition = nameRep.append(d.name);
          if (repetition) {
            cur.function.name = cur.function.name.slice(0, repetition.safeLength);
            repetitionStall = {
              channel: "tool_call",
              period: repetition.period,
              repeatedChars: repetition.repeatedChars,
            };
            stallAbort.abort(new Error("Repetitive tool name stream stopped"));
            break;
          }
        }
        if (d.argumentsDelta) {
          cur.function.arguments = (cur.function.arguments ?? "") + d.argumentsDelta;
          let argsRep = toolArgsRepetitions.get(d.index);
          if (!argsRep) {
            argsRep = new StreamRepetitionDetector();
            toolArgsRepetitions.set(d.index, argsRep);
          }
          const repetition = argsRep.append(d.argumentsDelta);
          if (repetition) {
            cur.function.arguments = cur.function.arguments.slice(0, repetition.safeLength);
            repetitionStall = {
              channel: "tool_call",
              period: repetition.period,
              repeatedChars: repetition.repeatedChars,
            };
            stallAbort.abort(new Error("Repetitive tool arguments stream stopped"));
            break;
          }
        }
        if (d.thoughtSignature) cur.thoughtSignature = d.thoughtSignature;
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
      if (chunk.image) image = chunk.image;
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
    image,
    repetitionStall,
  };
}
