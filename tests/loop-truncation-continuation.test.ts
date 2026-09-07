// Non-Ollama truncation continuation: the Ollama-native behavior
// (finish_reason cutoff → bounded resume) now covers every provider.
import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

describe("CacheFirstLoop truncation continuation (non-Ollama providers)", () => {
  it("continues a deepseek stream that truncates at the token cap", async () => {
    const responses: FakeResponseShape[] = [
      { content: "The fix is to updat", finish_reason: "length" },
      { content: "e the config and rerun." },
    ];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: true,
      model: "deepseek-v4-flash",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("continue your answer")) events.push(ev);

    expect(captured.length).toBe(2);
    expect(events.find((ev) => ev.role === "done")?.content).toBe("e the config and rerun.");
    expect(
      events
        .filter((ev) => ev.role === "warning")
        .some((ev) => ev.content?.includes("continuing generation")),
    ).toBe(true);
  });

  it("continues an OpenCode Responses-style 'incomplete' cutoff (non-stream)", async () => {
    const responses: FakeResponseShape[] = [
      { content: "partial ans", finish_reason: "incomplete" },
      { content: "wer completed" },
    ];
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "glm-5-free",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("go")) events.push(ev);

    expect(captured.length).toBe(2);
    expect(events.find((ev) => ev.role === "done")?.content).toBe("wer completed");
  });

  it("gives up after the continuation cap instead of looping forever", async () => {
    const responses: FakeResponseShape[] = Array.from({ length: 6 }, () => ({
      content: "same partial",
      finish_reason: "length",
    }));
    const { client, captured } = makeFakeClient(responses, { echoMessages: true });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "deepseek-v4-flash",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("go")) events.push(ev);

    // Initial call + MAX_TRUNCATION_CONTINUATIONS resumes, then a loud give-up.
    expect(captured.length).toBe(CacheFirstLoop.MAX_TRUNCATION_CONTINUATIONS + 1);
    expect(
      events
        .filter((ev) => ev.role === "warning")
        .some((ev) => ev.content?.includes("after 3 continuations")),
    ).toBe(true);
    expect(events[events.length - 1]?.role).toBe("done");
  });
});
