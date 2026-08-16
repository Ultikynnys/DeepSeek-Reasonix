import { COMPACTION_SUMMARY_MARKER, messageOf } from "@reasonix/core-utils";
import { type DeepSeekClient, Usage } from "../client.js";
import { t } from "../i18n/index.js";
import type { TurnStats } from "../telemetry/stats.js";
import { countTokensBounded } from "../tokenizer.js";
import type { ChatMessage } from "../types.js";
import { buildFoldSummaryInstruction, extractPinnedConstraints } from "./compaction-prompt.js";
import { COMPACTION_RETRY_DELAY_MS, withCompactionRetry } from "./compaction-retry.js";
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
  buildMessages: () => ChatMessage[];
  /** Replaces the entire log with the synthesized summary — the force summary
   *  is a FULL fold, not an append, so the context actually drops below the
   *  guard threshold instead of re-tripping it next turn. */
  replaceLog: (msg: ChatMessage) => void;
  recordStats: (model: string, usage: Usage) => TurnStats;
  turn: number;
  /** Model to call for the summary itself — must be valid on the user's endpoint. */
  model: string;
  /** System prompt — used to lift pinned constraints verbatim into the summary. */
  getSystemPrompt: () => string;
  /** Final guard supplied by the loop; a force-summary request must not exceed the model budget. */
  canSend?: (messages: ChatMessage[]) => boolean;
}

export async function* forceSummaryAfterIterLimit(
  ctx: ForceSummaryContext,
  opts: { reason: ForceSummaryReason },
): AsyncGenerator<LoopEvent, string> {
  try {
    // Status bridges the silence — summary call is non-streaming, 30-60s typical.
    yield { turn: ctx.turn, role: "status", content: t("summary.status") };
    const messages = ctx.buildMessages();
    // The force summary now REPLACES the whole log, so it must be a
    // conversation recap that preserves the original objective, negative
    // constraints, decisions, and open todos — not just a turn-scoped
    // "what did I learn" blurb. Reuse the fold's instruction for parity.
    // `stripHallucinatedToolMarkup` below still catches any tool-call/DSML
    // markup the model hallucinates despite the plain-prose directive.
    messages.push({
      role: "user",
      content: buildFoldSummaryInstruction([]),
    });
    if (ctx.canSend && !ctx.canSend(messages)) {
      throw new Error("forced-summary request exceeds the model context budget");
    }
    // Use the active turn model — pinning a specific name (e.g. flash) 400s
    // on third-party endpoints that don't advertise it. `thinking: disabled`
    // still keeps reasoning tokens off the bill for the bounded paraphrase.
    // Deadline race: the summary call must settle within a context-scaled
    // window even when the upstream connection stalls (see constants above).
    // The deadline aborts the request — AbortSignal.any, the same combination
    // the client uses for its own socket cap — and rejects, so the catch below
    // surfaces an error event instead of freezing the turn on "summarizing…".
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
    // Deliberately NOT wired to the turn's abort signal — compaction is
    // non-interruptible by design (same rationale as the fold summarizer in
    // context-manager.ts). Esc/Stop during the summary is deferred to the next
    // iteration boundary; the request is bounded only by the scaled deadline.
    const resp = await withCompactionRetry({
      maxElapsedMs: deadlineMs + COMPACTION_RETRY_DELAY_MS,
      timeoutMessage: "forced-summary-timeout",
      attempt: async (attemptSignal) => {
        const deadlineCtrl = new AbortController();
        const requestSignal = AbortSignal.any([attemptSignal, deadlineCtrl.signal]);
        let timedOut = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadlinePromise = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            deadlineCtrl.abort(new Error("forced-summary-timeout"));
            reject(new Error("forced-summary-timeout"));
          }, deadlineMs);
        });
        try {
          return await Promise.race([
            ctx.client.chat({
              model: ctx.model,
              messages,
              signal: requestSignal,
              thinking: "disabled",
            }),
            deadlinePromise,
          ]);
        } catch (err) {
          // Keep the local deadline terminal; only provider/network failures
          // are eligible for the shared bounded compaction replay.
          if (timedOut) throw new Error("forced-summary-timeout");
          throw err;
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      },
    });
    const rawContent = resp.content?.trim() ?? "";
    const cleaned = stripHallucinatedToolMarkup(rawContent);
    const summary = cleaned || t("summary.hallucinatedFallback");
    const reasonPrefix = reasonPrefixFor(opts.reason);
    const annotated = `${reasonPrefix}\n\n${summary}`;
    const summaryStats = ctx.recordStats(ctx.model, resp.usage ?? new Usage());
    // Full fold: stamp the recap + pinned constraints and REPLACE the log, so
    // the context drops below the guard instead of growing on top of it.
    const constraints = extractPinnedConstraints(ctx.getSystemPrompt());
    const constraintTail = constraints
      ? `\n\n[PINNED CONSTRAINTS — preserved verbatim]\n\n${constraints}`
      : "";
    ctx.replaceLog(
      buildAssistantMessage(
        COMPACTION_SUMMARY_MARKER + summary + constraintTail,
        [],
        ctx.model,
        resp.reasoningContent,
      ),
    );
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
    const raw = messageOf(err);
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
        retryable: false,
        recoverable: true,
      },
    };
    yield { turn: ctx.turn, role: "done", content: "" };
    return "";
  }
}
