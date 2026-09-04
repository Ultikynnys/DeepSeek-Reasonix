import { describe, expect, it } from "vitest";
import type { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop, type LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
  return makeFakeClient(responses, { echoMessages: true }).client;
}

async function drain(loop: CacheFirstLoop, prompt: string): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of loop.step(prompt)) out.push(ev);
  return out;
}

describe("CacheFirstLoop auto-compaction toggle", () => {
  it("defaults disableAutoCompaction to false and can be hot-configured", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "hi" }]),
      prefix: new ImmutablePrefix({ system: "test system prompt" }),
    });
    expect(loop.disableAutoCompaction).toBe(false);

    loop.configure({ disableAutoCompaction: true });
    expect(loop.disableAutoCompaction).toBe(true);

    loop.configure({ disableAutoCompaction: false });
    expect(loop.disableAutoCompaction).toBe(false);
  });

  it("skips auto-compaction when disableAutoCompaction is true", async () => {
    const responses: FakeResponseShape[] = [
      { content: "first reply" },
      { content: "second reply" },
    ];
    const loop = new CacheFirstLoop({
      client: makeClient(responses),
      prefix: new ImmutablePrefix({ system: "system prompt" }),
      // Tiny context window so normal turns would immediately trigger auto-fold
      ctxMaxOverride: 128_000,
      disableAutoCompaction: true,
      stream: false,
    });

    const events1 = await drain(loop, "a".repeat(5000));
    expect(events1.some((e) => e.role === "compaction_start")).toBe(false);

    const events2 = await drain(loop, "b".repeat(5000));
    expect(events2.some((e) => e.role === "compaction_start")).toBe(false);
  });

  it("allows manual compaction even when disableAutoCompaction is true", async () => {
    const loop = new CacheFirstLoop({
      client: makeClient([
        { content: "hello world" },
        // Summary call for manual fold
        { content: "this is a manual fold summary" },
      ]),
      prefix: new ImmutablePrefix({ system: "system prompt" }),
      disableAutoCompaction: true,
      stream: false,
    });

    await drain(loop, "first user turn");

    const compactionEvents: LoopEvent[] = [];
    for await (const ev of loop.compactHistoryWithEvents({ keepRecentTokens: 10 })) {
      compactionEvents.push(ev);
    }

    const start = compactionEvents.find((e) => e.role === "compaction_start");
    const end = compactionEvents.find((e) => e.role === "compaction_end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start?.compactionReason).toBe("user");
  });

  it("does NOT trigger forced summary compaction on reasoning doom loops when disabled", async () => {
    const reasoning = "I wonder whether the answer is right. Let me reconsider.";
    const responses: FakeResponseShape[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        reasoning_content: reasoning,
        content: "",
        tool_calls: [
          {
            id: `c${i}`,
            type: "function" as const,
            function: { name: "probe", arguments: JSON.stringify({ i }) },
          },
        ],
      })),
      { content: "done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      disableAutoCompaction: true,
      stream: false,
    });

    const events = await drain(loop, "test reasoning doom loop");
    // Warns about reasoning loop
    expect(
      events.some(
        (e) => e.role === "warning" && /re-thinking the same point/i.test(e.content ?? ""),
      ),
    ).toBe(true);
    // But does NOT emit compaction events or forced summary
    expect(events.some((e) => e.role === "compaction_start")).toBe(false);
    expect(events.some((e) => e.role === "compaction_end")).toBe(false);
    expect(events.some((e) => e.forcedSummary === true)).toBe(false);
  });

  it("does NOT trigger forced summary compaction on tool storm doom loops when disabled", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const dupCall = {
      id: "c1",
      type: "function" as const,
      function: { name: "probe", arguments: "{}" },
    };
    const responses: FakeResponseShape[] = [
      { content: "", tool_calls: [dupCall] },
      { content: "", tool_calls: [{ ...dupCall, id: "c2" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c3" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c4" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c5" }] },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      disableAutoCompaction: true,
      stream: false,
      maxToolIters: 8,
    });

    const events = await drain(loop, "explore");
    expect(
      events.some((e) => e.role === "warning" && /stuck retry loop/i.test(e.content ?? "")),
    ).toBe(true);

    // Verifies NO compaction cards or forced summary were emitted
    expect(events.some((e) => e.role === "compaction_start")).toBe(false);
    expect(events.some((e) => e.role === "compaction_end")).toBe(false);
    expect(events.some((e) => e.forcedSummary === true)).toBe(false);
  });
});
