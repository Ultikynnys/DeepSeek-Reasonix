import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { ContextManager, estimateFoldEconomics } from "../src/context-manager.js";
import { AppendOnlyLog } from "../src/memory/runtime.js";

function manager(): ContextManager {
  return new ContextManager({
    client: {} as never,
    log: new AppendOnlyLog(),
    stats: {} as never,
    sessionName: null,
    getCurrentTurn: () => 1,
    getSystemPrompt: () => "system",
  });
}

describe("ContextManager fold economics", () => {
  it("does not fold in the normal band when cache carry cost is cheaper than fold tax", () => {
    // 230K prompt tokens ≈ 76.7% of the fork's 300K ctxMax — normal fold band (75-78%).
    const usage = new Usage(230_000, 100, 230_100, 222_000, 8_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("none");
    expect(decision.economics?.worthwhile).toBe(false);
  });

  it("folds in the normal band when high miss tokens make carrying context expensive", () => {
    const usage = new Usage(230_000, 100, 230_100, 0, 230_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("fold");
    expect(decision.economics?.worthwhile).toBe(true);
  });

  it("still folds aggressively for headroom even if cache economics are cheap", () => {
    // 236K ≈ 78.7% — aggressive band (78-80%) skips the economics gate.
    const usage = new Usage(236_000, 100, 236_100, 232_000, 4_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("fold");
    expect(decision.aggressive).toBe(true);
  });

  it("estimates fold cost over a short multi-turn horizon", () => {
    const usage = new Usage(230_000, 100, 230_100, 0, 230_000);
    const economics = estimateFoldEconomics(usage, "deepseek-v4-flash", 200_000);

    expect(economics.horizonTurns).toBeGreaterThan(1);
    expect(economics.carryInputUsd).toBeGreaterThan(economics.foldInputUsd);
    expect(economics.savingsUsd).toBeGreaterThan(0);
  });
});
