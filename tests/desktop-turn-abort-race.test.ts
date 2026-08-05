// Desktop runTurn abort-race regression — "Send now" / Stop while the turn
// generator is suspended in a non-interruptible compaction fold.
//
// The fold deliberately ignores the turn's abort signal (see
// summarizeForFold), so the loop won't yield anything until the scaled
// deadline fires — minutes later. The old `for await` consumer blocked on
// that, $turn_complete never fired, and the queued-sends drain never ran:
// the force-pushed message stalled forever. runTurn now races
// raceLoopStep() against its own aborter, so the consumer must unblock the
// instant the abort fires, and the next turn must still run cleanly (fresh
// per-turn controller — no carryAbort, no interference from the deferred
// generator close).

import { afterEach, describe, expect, it, vi } from "vitest";
import { raceLoopStep } from "../src/cli/commands/desktop.js";
import { DeepSeekClient } from "../src/client.js";
import { HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { jsonOkResponse, neverResolvingFetch } from "./support/fake-client.js";

const FOLD_TEST_MODEL = "test-fold-ctx";
/** summarizeForFold hardcodes the summary model — fold requests carry this. */
const FOLD_SUMMARY_MODEL = "deepseek-v4-flash";

function seedTurns(loop: CacheFirstLoop, n: number): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({
      role: "user",
      content: `question ${i}: ${"context padding for fold race regression ".repeat(8)}`,
    });
    loop.log.append({
      role: "assistant",
      content: `answer ${i}: ${"more context padding for fold race regression ".repeat(8)}`,
    });
  }
}

describe("desktop runTurn abort race (Send now during a non-interruptible fold)", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL];
  });

  it("unblocks the consumer mid-fold and the next turn runs cleanly", async () => {
    vi.useFakeTimers();
    // Tiny ctxMax so the seeded log crosses the 75% turn-start fold
    // threshold on the very first step().
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 1_000;

    const hangFold = neverResolvingFetch();
    const fetchMock = vi.fn((url: unknown, init: { body?: string } | undefined) => {
      const body = JSON.parse(init?.body ?? "{}") as { model?: string };
      if (body.model === FOLD_SUMMARY_MODEL) {
        // Fold summarizer: hangs until foldCtrl's scaled deadline aborts it.
        return hangFold(url, init);
      }
      return Promise.resolve(
        jsonOkResponse({ choices: [{ message: { content: "turn two ran cleanly" } }] }),
      );
    });
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: FOLD_TEST_MODEL,
    });
    seedTurns(loop, 6);

    // Mirror desktop runTurn: drive the generator via raceLoopStep.
    const aborter = new AbortController();
    const gen = loop.step("turn one");
    let sawCompactionStart = false;
    let aborted = false;
    let completed = false;
    const consume = async (): Promise<void> => {
      while (true) {
        const next = await raceLoopStep(gen, aborter.signal);
        if (next === null) {
          aborted = true;
          return;
        }
        if (next.done) {
          completed = true;
          return;
        }
        if (next.value.role === "compaction_start") sawCompactionStart = true;
      }
    };
    const turn1 = consume();
    // Let the generator reach the fold suspension (compaction_start
    // yielded, now hung inside summarizeForFold).
    await vi.advanceTimersByTimeAsync(0);
    expect(sawCompactionStart).toBe(true);
    expect(aborted).toBe(false);
    expect(completed).toBe(false);

    // Send now / Stop: abortTurn fires the consumer's aborter first, then
    // loop.abort() — both, exactly like the real handler.
    aborter.abort();
    loop.abort();
    await turn1;

    // The regression: the consumer unblocked while the fold is still hung.
    expect(aborted).toBe(true);
    expect(completed).toBe(false);
    // Fold deadline still pending — the generator has NOT unwound yet.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // runTurn closes the suspended generator fire-and-forget; the close is
    // queued behind the in-flight fold and settles when the deadline fires.
    const closeP = gen.return(undefined).catch(() => undefined);

    // Turn two — the force-sent queued message. Its own turn-start fold
    // (turn one's never committed) fails open at the deadline, then the
    // model answers. Must NOT hit the iter-0 abort path.
    const turn2: LoopEvent[] = [];
    const turn2P = (async () => {
      for await (const ev of loop.step("turn two")) turn2.push(ev);
    })();
    await vi.advanceTimersByTimeAsync(HISTORY_FOLD_SUMMARY_MAX_TIMEOUT_MS + 5_000);
    await turn2P;
    await closeP;

    const finals = turn2.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("turn two ran cleanly");
    // A clean run, not the abort path — turn two's fresh controller won.
    expect(finals[0]!.forcedSummary).toBeUndefined();
    expect(turn2.some((e) => e.role === "compaction_end")).toBe(true);
  });
});
