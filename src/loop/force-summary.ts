import { type DeepSeekClient, Usage } from "../client.js";
import { t } from "../i18n/index.js";
import type { TurnStats } from "../telemetry/stats.js";
import { countTokensBounded } from "../tokenizer.js";
import type { ChatMessage } from "../types.js";
import { errorLabelFor, reasonPrefixFor } from "./errors.js";
import { buildAssistantMessage } from "./messages.js";
import { stripHallucinatedToolMarkup } from "./thinking.js";
import type { LoopEvent } from "./types.js";

// Scaled deadline for the summary call, mirroring the fold summarizer's pattern
// (context-manager.ts): prefill + queue time grows with the prompt, so a fixed
// short cap would deterministically kill summaries at large contexts — exactly
// when the 80% guard fires. The client's own socket cap (11 min) still bounds
// a hung connection, but an 11-min stall freezes the whole turn: the loop
// consumes this generator inline, so in-flight tool dispatch (shell instances
// included) hangs until it settles. The scaled deadline keeps the wait
// proportional to the context (~4 min at a 240k-token context) instead of
// pathological.
const FORCE_SUMMARY_TIMEOUT_MS = 15_000;
const FORCE_SUMMARY_PER_TOKEN_MS = 1.0;
const FORCE_SUMMARY_MAX_TIMEOUT_MS = 300_000;

export type ForceSummaryReason = "aborted" | "context-guard" | "stuck";

export interface ForceSummaryContext {
  client: DeepSeekClient;
  signal: AbortSignal;
  buildMessages: () => ChatMessage[];
  appendAndPersist: (msg: ChatMessage) => void;
  recordStats: (model: string, usage: Usage) => TurnStats;
  turn: number;
  /** Model to call for the summary itself — must be valid on the user's endpoint. */
  model: string;
}

export async function* forceSummaryAfterIterLimit(
  ctx: ForceSummaryContext,
  opts: { reason: ForceSummaryReason },
): AsyncGenerator<LoopEvent, string> {
  try {
    // Status bridges the silence — summary call is non-streaming, 30-60s typical.
    yield { turn: ctx.turn, role: "status", content: t("summary.status") };
    const messages = ctx.buildMessages();
    // Passing `tools: undefined` was supposed to force a text response,
    // but R1 can still hallucinate tool-call markup (e.g. DSML
    // `<｜DSML｜function_calls>…`) when primed by prior tool use. An
    // explicit user-role instruction plus post-hoc stripping of known
    // hallucination shapes keeps the user from seeing raw markup.
    messages.push({
      role: "user",
      content:
        "The turn is being force-summarized (context guard or stuck-state). Summarize in plain prose what you learned from the tool results above. Do NOT emit any tool calls, function-call markup, DSML invocations, or SEARCH/REPLACE edit blocks — they will be silently discarded. Just plain text.",
    });
    // Use the active turn model — pinning a specific name (e.g. flash) 400s
    // on third-party endpoints that don't advertise it. `thinking: disabled`
    // still keeps reasoning tokens off the bill for the bounded paraphrase.
    // Deadline race: the summary call must settle within a context-scaled
    // window even when the upstream connection stalls (see constants above).
    // The deadline aborts the request — AbortSignal.any, the same combination
    // the client uses for its own socket cap — and rejects, so the catch below
    // surfaces an error event instead of freezing the turn on "summarizing…".
    const summaryCtrl = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineMs = Math.min(
      FORCE_SUMMARY_MAX_TIMEOUT_MS,
      FORCE_SUMMARY_TIMEOUT_MS +
        Math.round(
          messages.reduce(
            (acc, m) => acc + countTokensBounded(typeof m.content === "string" ? m.content : ""),
            0,
          ) * FORCE_SUMMARY_PER_TOKEN_MS,
        ),
    );
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        summaryCtrl.abort();
        reject(new Error("forced-summary-timeout"));
      }, deadlineMs);
    });
    let resp: Awaited<ReturnType<typeof ctx.client.chat>>;
    try {
      resp = await Promise.race([
        ctx.client.chat({
          model: ctx.model,
          messages,
          signal: AbortSignal.any([ctx.signal, summaryCtrl.signal]),
          thinking: "disabled",
        }),
        deadlinePromise,
      ]);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    const rawContent = resp.content?.trim() ?? "";
    const cleaned = stripHallucinatedToolMarkup(rawContent);
    const summary = cleaned || t("summary.hallucinatedFallback");
    const reasonPrefix = reasonPrefixFor(opts.reason);
    const annotated = `${reasonPrefix}\n\n${summary}`;
    const summaryStats = ctx.recordStats(ctx.model, resp.usage ?? new Usage());
    ctx.appendAndPersist(buildAssistantMessage(summary, [], ctx.model, resp.reasoningContent));
    yield {
      turn: ctx.turn,
      role: "assistant_final",
      content: annotated,
      stats: summaryStats,
      forcedSummary: true,
    };
    yield { turn: ctx.turn, role: "done", content: summary };
    // Returns the raw summary text (without the reason prefix) so the caller can
    // fill the compaction card's summaryChars without re-parsing the event.
    return summary;
  } catch (err) {
    const label = errorLabelFor(opts.reason);
    const raw = err instanceof Error ? err.message : String(err);
    const message = t("summary.failedAfterReason", {
      label,
      message: raw === "forced-summary-timeout" ? "summary request timed out" : raw,
    });
    yield {
      turn: ctx.turn,
      role: "error",
      content: "",
      error: message,
      errorDetail: {
        name: "ForceSummaryFailed",
        message,
        retryable: true,
        recoverable: true,
      },
    };
    yield { turn: ctx.turn, role: "done", content: "" };
    return "";
  }
}
