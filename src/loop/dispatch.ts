import { parseRateLimitedToolResult } from "../tools/rate-limit.js";
import { USER_CANCEL_NOTE } from "../tools/shell.js";
import type { ChatMessage, ToolCall, UserContentPart } from "../types.js";
import type { LoopEvent } from "./types.js";

export interface RunOneToolCallResult {
  preWarnings: LoopEvent[];
  postWarnings: LoopEvent[];
  result: string | UserContentPart[];
}

export interface DispatchContext {
  turn: number;
  signal: AbortSignal;
  /** Model id of the current turn — gpt-* models default to serial dispatch
   *  so their tool calls never run ahead of each other's results. */
  model: string;
  isParallelSafe: (name: string) => boolean;
  isUserIntervention?: (name: string) => boolean;
  hasPendingGate?: () => boolean;
  inflightIdFor: (call: ToolCall) => string;
  inflightAdd: (id: string) => void;
  runOne: (call: ToolCall, signal: AbortSignal) => Promise<RunOneToolCallResult>;
  appendAndPersist: (msg: ChatMessage) => void;
  /** Loop-owned set of dispatched call ids whose results have NOT been
   *  appended yet. If the turn generator is force-closed mid-dispatch, the
   *  ids stay behind so the loop can stub them as cancellations. */
  abandonedCalls: Set<string>;
  /** Mutable across iter cycles — single rate-limit warning per step(). */
  rateLimitState: { shown: boolean };
}

function readParallelMax(): number {
  const raw = Number.parseInt(process.env.REASONIX_PARALLEL_MAX ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 16) : 3;
}

/** Collapse a content-parts tool result to a display string for the string-typed
 *  LoopEvent.content (UI renderer). Image parts are noted, not dumped. */
export function contentPartsToString(parts: UserContentPart[]): string {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const imageCount = parts.filter((p) => p.type === "image_url").length;
  const imageNote = imageCount > 0 ? `\n[${imageCount} image(s) attached]` : "";
  return `${text}${imageNote}`.trim();
}

/** Env override wins; gpt-* default to SERIAL so their parallel bursts
 *  run one-at-a-time (each settles before the next starts). DeepSeek
 *  keeps parallel chunks; `REASONIX_TOOL_DISPATCH=parallel` restores. */
function readDispatchSerial(model: string): boolean {
  const raw = (process.env.REASONIX_TOOL_DISPATCH ?? "").toLowerCase();
  if (raw === "serial") return true;
  if (raw === "parallel" || raw === "auto") return false;
  return model.startsWith("gpt-");
}

export async function* dispatchToolCallsChunked(
  repairedCalls: ToolCall[],
  ctx: DispatchContext,
): AsyncGenerator<LoopEvent, void, void> {
  const dispatchSerial = readDispatchSerial(ctx.model);
  const parallelMax = readParallelMax();

  let callIdx = 0;
  while (callIdx < repairedCalls.length) {
    const chunk: ToolCall[] = [];
    if (!dispatchSerial) {
      while (
        callIdx < repairedCalls.length &&
        chunk.length < parallelMax &&
        ctx.isParallelSafe(repairedCalls[callIdx]?.function?.name ?? "") &&
        !ctx.isUserIntervention?.(repairedCalls[callIdx]?.function?.name ?? "")
      ) {
        chunk.push(repairedCalls[callIdx++]!);
      }
    }
    if (chunk.length === 0) {
      chunk.push(repairedCalls[callIdx++]!);
    }

    for (const call of chunk) {
      const callId = ctx.inflightIdFor(call);
      ctx.inflightAdd(callId);
      // Track the dispatched call id so a force-closed turn can later stub
      // it as a cancellation if the result never gets appended.
      ctx.abandonedCalls.add(call.id ?? "");
      yield {
        turn: ctx.turn,
        role: "tool_start",
        content: "",
        toolName: call.function?.name ?? "",
        toolArgs: call.function?.arguments ?? "{}",
        callId,
      };
    }

    const settled = await Promise.allSettled(chunk.map((c) => ctx.runOne(c, ctx.signal)));

    for (let k = 0; k < chunk.length; k++) {
      const call = chunk[k]!;
      const name = call.function?.name ?? "";
      const args = call.function?.arguments ?? "{}";
      const s = settled[k]!;

      let result: string | UserContentPart[];
      let preWarnings: LoopEvent[] = [];
      let postWarnings: LoopEvent[] = [];
      if (s.status === "fulfilled") {
        preWarnings = s.value.preWarnings;
        postWarnings = s.value.postWarnings;
        result = s.value.result;
      } else {
        // A rejection that lands because the TURN was cancelled (Send now /
        // queue force / Esc) is a user cancellation, not a tool failure —
        // record it as such, or the model blames the tool for an
        // interruption it never caused.
        const err = s.reason instanceof Error ? s.reason : new Error(String(s.reason));
        result = ctx.signal.aborted
          ? JSON.stringify({
              cancelledByUser: true,
              error: `Tool call cancelled because the conversation stopped. ${USER_CANCEL_NOTE}`,
            })
          : JSON.stringify({ error: `${err.name}: ${err.message}` });
      }

      for (const w of preWarnings) yield w;
      for (const w of postWarnings) yield w;

      const rateLimited = typeof result === "string" ? parseRateLimitedToolResult(result) : null;
      if (rateLimited && !ctx.rateLimitState.shown) {
        ctx.rateLimitState.shown = true;
        yield {
          turn: ctx.turn,
          role: "warning",
          content: rateLimited.message,
        };
      }

      ctx.appendAndPersist({
        role: "tool",
        tool_call_id: call.id ?? "",
        name,
        content: Array.isArray(result) ? contentPartsToString(result) : result,
      });
      // The result is in the log — the call is no longer abandoned.
      ctx.abandonedCalls.delete(call.id ?? "");

      // Image-bearing tool results (see_image) must reach the model on a USER
      // message — Ollama vision models silently ignore images on tool-role
      // messages (ollama/ollama#16038), so a follow-up user message carrying
      // the image_url parts is the only delivery channel that renders.
      if (Array.isArray(result)) {
        ctx.appendAndPersist({
          role: "user",
          content: result,
        });
      }

      yield {
        turn: ctx.turn,
        role: "tool",
        content: Array.isArray(result) ? contentPartsToString(result) : result,
        toolName: name,
        toolArgs: args,
        callId: ctx.inflightIdFor(call),
      };
    }

    // If an interactive user-intervention tool ran or a PauseGate request was opened,
    // prevent subsequent tool calls from running ahead of the user's resolution.
    // Stub remaining calls as cancelled so the API log maintains tool_call_id parity.
    const hadIntervention =
      chunk.some((c) => ctx.isUserIntervention?.(c.function?.name ?? "")) ||
      ctx.hasPendingGate?.() === true;
    if (hadIntervention && callIdx < repairedCalls.length) {
      while (callIdx < repairedCalls.length) {
        const skipped = repairedCalls[callIdx++]!;
        const name = skipped.function?.name ?? "";
        const cancelResult = JSON.stringify({
          cancelledByUser: true,
          error: "Tool call cancelled: user intervention was required before this action.",
        });
        ctx.appendAndPersist({
          role: "tool",
          tool_call_id: skipped.id ?? "",
          name,
          content: cancelResult,
        });
        yield {
          turn: ctx.turn,
          role: "tool",
          content: cancelResult,
          toolName: name,
          toolArgs: skipped.function?.arguments ?? "{}",
          callId: ctx.inflightIdFor(skipped),
        };
      }
    }
  }
}
