import { describe, expect, it } from "vitest";
import {
  emptySessionCarryover,
  projectKernelEvent,
  sessionCarryover,
} from "../src/cli/commands/desktop.js";
import { Eventizer } from "../src/core/eventize.js";

describe("desktop session carryover", () => {
  it("maps persisted metadata through one constructor", () => {
    expect(
      sessionCarryover({
        totalCostUsd: 1.25,
        costByProvider: { openai: { kind: "usd", totalCostUsd: 1.25 } },
        cacheHitTokens: 10,
        cacheMissTokens: 5,
        totalCompletionTokens: 3,
      }),
    ).toEqual({
      totalCostUsd: 1.25,
      costByProvider: { openai: { kind: "usd", totalCostUsd: 1.25 } },
      cacheHitTokens: 10,
      cacheMissTokens: 5,
      totalCompletionTokens: 3,
    });
  });

  it("constructs a fresh-session carryover consistently", () => {
    expect(emptySessionCarryover()).toEqual({
      totalCostUsd: 0,
      costByProvider: {},
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalCompletionTokens: 0,
    });
  });

  it("projects a session retraction through the explicit desktop wire boundary", () => {
    const eventizer = new Eventizer();
    const kernelEvent = eventizer.emitSessionRetracted(2, "retry", 4, 2, [
      { role: "user", content: "try again" },
    ]);

    expect(projectKernelEvent(kernelEvent)).toMatchObject({
      type: "session.retracted",
      kind: "retry",
      beforeMessages: 4,
      afterMessages: 2,
      replacementMessages: [{ kind: "user", text: "try again" }],
    });
  });
});
