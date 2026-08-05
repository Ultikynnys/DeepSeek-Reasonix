/** CacheFirstLoop.inflight — finally-driven cleanup around runOneToolCall. */

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

describe("CacheFirstLoop.inflight", () => {
  it("starts empty and exposes the InflightSet via getter", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    expect(loop.inflight.size).toBe(0);
    expect(loop.inflight.has("anything")).toBe(false);
  });

  it("tool_start event carries a callId that matches the inflight key", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "test tool",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const loop = new CacheFirstLoop({
      client: makeClient([
        {
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "echo", arguments: "{}" },
            },
          ],
        },
        { content: "all done" },
      ]),
      prefix: new ImmutablePrefix({ system: "s" }),
      tools,
      stream: false,
    });
    const events = await drain(loop, "go");
    const start = events.find((e) => e.role === "tool_start");
    expect(start).toBeDefined();
    expect(start?.callId).toBe("call_abc");
    // Set is drained after the turn completes — every dispatch's finally fired.
    expect(loop.inflight.size).toBe(0);
  });

  it("inflight is empty after a tool throws — finally still removes the id", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "boom",
      description: "always fails",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      fn: async () => {
        throw new Error("simulated tool failure");
      },
    });
    const loop = new CacheFirstLoop({
      client: makeClient([
        {
          tool_calls: [
            {
              id: "call_boom",
              type: "function",
              function: { name: "boom", arguments: "{}" },
            },
          ],
        },
        { content: "recovered" },
      ]),
      prefix: new ImmutablePrefix({ system: "s" }),
      tools,
      stream: false,
    });
    await drain(loop, "go");
    expect(loop.inflight.size).toBe(0);
    expect(loop.inflight.has("call_boom")).toBe(false);
  });

  it("clearLog drains the inflight set so /new can't strand a stale callId", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    loop.inflight.add("call-1");
    loop.inflight.add("call-2");
    expect(loop.inflight.size).toBe(2);
    loop.clearLog();
    expect(loop.inflight.size).toBe(0);
  });
});
