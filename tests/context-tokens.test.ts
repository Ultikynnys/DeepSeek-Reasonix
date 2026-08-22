import { describe, expect, it } from "vitest";
import { DeepSeekClient, Usage } from "../src/client.js";
import { ContextManager, HISTORY_FOLD_TAIL_FRACTION } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { AppendOnlyLog, ImmutablePrefix } from "../src/memory/runtime.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  SessionStats,
  resolveContextTokens,
} from "../src/telemetry/stats.js";

function makeManager(log: AppendOnlyLog, ctxMaxOverride?: number): ContextManager {
  const client = new DeepSeekClient({ apiKey: "sk-test" });
  return new ContextManager({
    client,
    log,
    stats: new SessionStats(),
    sessionName: null,
    getCurrentTurn: () => 1,
    ctxMaxOverride,
  });
}

describe("resolveContextTokens", () => {
  it("uses the per-model table when no override is set", () => {
    expect(resolveContextTokens("deepseek-v4-flash")).toBe(
      DEEPSEEK_CONTEXT_TOKENS["deepseek-v4-flash"],
    );
    expect(resolveContextTokens("gpt-5.6-sol")).toBe(300_000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS for unknown models", () => {
    expect(resolveContextTokens("some-future-model")).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("clamps a configured override to the model's known max context length", () => {
    // The user may set any value in settings, but the model's capability
    // wins: never advertise a window above what the model accepts.
    expect(resolveContextTokens("deepseek-v4-flash", 750_000)).toBe(300_000);
    expect(resolveContextTokens("deepseek-v4-flash", 1_000_000)).toBe(300_000);
    expect(resolveContextTokens("gpt-5.6-sol", 900_000)).toBe(300_000);
  });

  it("an override below the max stays in effect (floored to the config range)", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 300_000)).toBe(300_000);
    expect(resolveContextTokens("deepseek-v4-flash", 250_000)).toBe(MIN_CONTEXT_TOKENS);
  });

  it("an override also applies to unknown models up to the API ceiling (the table is only the no-override fallback)", () => {
    expect(resolveContextTokens("some-future-model", 900_000)).toBe(900_000);
  });

  it("clamps to the config range floor and the API ceiling", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 100)).toBe(MIN_CONTEXT_TOKENS);
    expect(resolveContextTokens("some-future-model", 2_000_000)).toBe(MAX_CONTEXT_TOKENS);
  });

  it("floors fractional overrides and ignores non-finite ones", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 350_000.9)).toBe(300_000);
    expect(resolveContextTokens("some-future-model", 350_000.9)).toBe(350_000);
    expect(resolveContextTokens("deepseek-v4-flash", Number.NaN)).toBe(300_000);
    expect(resolveContextTokens("deepseek-v4-flash", Number.POSITIVE_INFINITY)).toBe(300_000);
  });
});

describe("ContextManager ctxMaxOverride", () => {
  it("scales fold decisions with the configured cap (unknown model — override applies)", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "seed" });
    const mgr = makeManager(log, 1_000_000);
    const decision = mgr.decideAfterUsage(
      new Usage(760_000, 0, 760_000, 0, 760_000),
      "some-future-model",
      false,
    );
    // 760K / 1M = 0.76 → normal fold, with the tail budget scaled to the raised cap.
    expect(decision.kind).toBe("fold");
    expect(decision.ctxMax).toBe(1_000_000);
    expect(decision.tailBudget).toBe(Math.floor(1_000_000 * HISTORY_FOLD_TAIL_FRACTION));
  });

  it("a raised override never lifts a known model past its max window", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "seed" });
    const mgr = makeManager(log, 1_000_000);
    const decision = mgr.decideAfterUsage(
      new Usage(280_000, 0, 280_000, 0, 280_000),
      "deepseek-v4-flash",
      false,
    );
    // 280K / 300K = 0.93 → the clamped cap still force-summarizes. Without
    // the model clamp the cap would be 1M and this usage would read 0.28
    // (no compaction) — exactly the "above model capabilities" failure mode.
    expect(decision.ctxMax).toBe(300_000);
    expect(decision.kind).toBe("exit-with-summary");
  });

  it("the same absolute usage force-summarizes at the default 300K cap", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "seed" });
    const mgr = makeManager(log);
    const decision = mgr.decideAfterUsage(
      new Usage(760_000, 0, 760_000, 0, 760_000),
      "deepseek-v4-flash",
      false,
    );
    expect(decision.ctxMax).toBe(300_000);
    expect(decision.kind).toBe("exit-with-summary");
  });

  it("is hot-applicable: clearing the override falls back to the model default", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "seed" });
    const mgr = makeManager(log, 1_000_000);
    const before = mgr.decideAfterUsage(
      new Usage(760_000, 0, 760_000, 0, 760_000),
      "some-future-model",
      false,
    );
    expect(before.ctxMax).toBe(1_000_000);
    mgr.ctxMaxOverride = undefined;
    const after = mgr.decideAfterUsage(
      new Usage(760_000, 0, 760_000, 0, 760_000),
      "some-future-model",
      false,
    );
    expect(after.ctxMax).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(after.kind).toBe("exit-with-summary");
  });
});

describe("CacheFirstLoop.configure ctxMaxOverride", () => {
  it("accepts the override at construction and hot-applies it via configure()", () => {
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "deepseek-v4-flash",
      ctxMaxOverride: 500_000,
    });
    const internals = loop as unknown as { context: ContextManager };
    expect(loop.ctxMaxOverride).toBe(500_000);
    expect(internals.context.ctxMaxOverride).toBe(500_000);

    loop.configure({ ctxMaxOverride: 900_000 });
    expect(loop.ctxMaxOverride).toBe(900_000);
    expect(internals.context.ctxMaxOverride).toBe(900_000);

    // null clears back to the per-model default.
    loop.configure({ ctxMaxOverride: null });
    expect(loop.ctxMaxOverride).toBeUndefined();
    expect(internals.context.ctxMaxOverride).toBeUndefined();
  });

  it("does not disturb ctxMaxOverride when other options are configured", () => {
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "deepseek-v4-flash",
      ctxMaxOverride: 750_000,
    });
    loop.configure({ reasoningEffort: "max" });
    expect(loop.ctxMaxOverride).toBe(750_000);
  });
});
