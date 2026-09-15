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

/** Four iterations that re-emit the identical thought while the tool ARGS drift,
 *  so the storm breaker never trips and only the reasoning guard can catch it. */
const REASONING = "I wonder whether the answer is right. Let me reconsider.";

function reasoningLoopResponses(): FakeResponseShape[] {
  return [
    ...Array.from({ length: 4 }, (_, i) => ({
      reasoning_content: REASONING,
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
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "probe",
    description: "no-op",
    parameters: { type: "object", properties: {} },
    fn: async () => "ok",
  });
  return reg;
}

const isReasoningWarning = (e: LoopEvent): boolean =>
  e.role === "warning" && /re-thinking the same point/i.test(e.content ?? "");

describe("CacheFirstLoop repetition-guard toggle", () => {
  it("defaults repetitionGuardEnabled to false and can be hot-configured", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "hi" }]),
      prefix: new ImmutablePrefix({ system: "test system prompt" }),
    });
    expect(loop.repetitionGuardEnabled).toBe(false);

    loop.configure({ repetitionGuardEnabled: true });
    expect(loop.repetitionGuardEnabled).toBe(true);

    loop.configure({ repetitionGuardEnabled: false });
    expect(loop.repetitionGuardEnabled).toBe(false);
  });

  it("does NOT collapse a repeated-reasoning loop when the guard is disabled", async () => {
    const reg = makeRegistry();
    const loop = new CacheFirstLoop({
      client: makeClient(reasoningLoopResponses()),
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
    });

    const events = await drain(loop, "explore");

    // Guard is off by default: no "stuck re-thinking" warning, no compaction.
    expect(events.some(isReasoningWarning)).toBe(false);
    expect(events.some((e) => e.role === "compaction_start")).toBe(false);
  });

  it("collapses a repeated-reasoning loop once the guard is enabled", async () => {
    const reg = makeRegistry();
    const loop = new CacheFirstLoop({
      client: makeClient(reasoningLoopResponses()),
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      // Manual-only compaction keeps the assertion on the warning itself.
      disableAutoCompaction: true,
      repetitionGuardEnabled: true,
      maxToolIters: 8,
    });

    const events = await drain(loop, "explore");

    expect(events.some(isReasoningWarning)).toBe(true);
  });
});
