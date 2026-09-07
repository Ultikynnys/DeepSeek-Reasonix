/** Premature-stop guard: the model must not end a task turn mid-thought.
 *  Covers the pure heuristic plus the loop-level bounded nudge. */

import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { looksLikePrematureStop } from "../src/loop/premature-stop.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

describe("looksLikePrematureStop", () => {
  it("flags the real-world mid-task narration stop", () => {
    expect(
      looksLikePrematureStop(
        "Now the remaining verification: a test that pins the new behavior. Existing test files give me the patterns:",
      ),
    ).toBe(true);
    expect(looksLikePrematureStop("Reading the config now")).toBe(false); // narration but no starter match? no — covered below
  });

  it("flags narration lines that carry no sentence end", () => {
    expect(looksLikePrematureStop("Now the remaining verification")).toBe(true);
    expect(looksLikePrematureStop("Let me check the failing test")).toBe(true);
  });

  it("flags dangling list bullets and unclosed code fences", () => {
    expect(looksLikePrematureStop("Plan:\n- item one\n- ")).toBe(true);
    expect(looksLikePrematureStop("Here is the fix:\n\n```ts\nconst x = 1;")).toBe(true);
  });

  it("accepts complete-looking messages", () => {
    expect(looksLikePrematureStop("All steps complete: tests pass.")).toBe(false);
    expect(looksLikePrematureStop("Next steps: run npm test")).toBe(false);
    expect(
      looksLikePrematureStop("Done. Everything works.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"),
    ).toBe(false);
    expect(
      looksLikePrematureStop("See the guide below:\n\n```ts\ncode();\n```\n\nThat's it."),
    ).toBe(false);
    expect(looksLikePrematureStop("")).toBe(false);
  });
});

function probeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "probe",
    description: "no-op",
    parameters: { type: "object", properties: {} },
    fn: async () => "ok",
  });
  return reg;
}

describe("CacheFirstLoop premature-stop nudge", () => {
  it("re-prompts a mid-thought final after tool activity and completes the turn", async () => {
    const reg = probeRegistry();
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      // The model's actual stop shape from the field: narrates the next step
      // and cuts off at the colon.
      {
        content:
          "Now the remaining verification: a test that pins the new behavior. Existing test files give me the patterns:",
      },
      { content: "Task complete: the test passes and the fix is verified." },
    ];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      model: "deepseek-v4-flash",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("fix the bug")) events.push(ev);

    expect(captured.length).toBe(3);
    // The nudge arrived as a user message between the partial and the retry.
    const nudgedMessages = captured[2]?.messages ?? [];
    const lastUser = [...nudgedMessages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("If the task is now complete");
    expect(lastUser?.content).toContain("continue working");
    expect(events.find((ev) => ev.role === "done")?.content).toBe(
      "Task complete: the test passes and the fix is verified.",
    );
    expect(
      events.some((ev) => ev.role === "warning" && ev.content?.includes("stopped mid-task")),
    ).toBe(true);
  });

  it("does not nudge plain Q&A answers that never used tools", async () => {
    const responses: FakeResponseShape[] = [{ content: "Now the remaining verification" }];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "deepseek-v4-flash",
    });

    for await (const _ of loop.step("just answer this")) {
      /* drain */
    }
    expect(captured.length).toBe(1);
  });

  it("does not nudge complete-looking finals after tool activity", async () => {
    const reg = probeRegistry();
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      { content: "Task complete: the test passes and the fix is verified." },
    ];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      model: "deepseek-v4-flash",
    });

    for await (const _ of loop.step("fix the bug")) {
      /* drain */
    }
    expect(captured.length).toBe(2);
  });

  it("stops nudging after the per-turn budget and ends loudly, not silently", async () => {
    const reg = probeRegistry();
    const partial = "Now the remaining verification:";
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      { content: partial },
      { content: partial },
      { content: partial },
    ];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      model: "deepseek-v4-flash",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("fix the bug")) events.push(ev);

    // Tool round + first premature final + one call per nudge (the last
    // premature final ends the turn without another call).
    expect(captured.length).toBe(CacheFirstLoop.MAX_PREMATURE_STOP_NUDGES + 2);
    expect(
      events
        .filter((ev) => ev.role === "warning")
        .some((ev) => ev.content?.includes("after 2 continuation prompts")),
    ).toBe(true);
    expect(events[events.length - 1]?.role).toBe("done");
  });
});
