import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { makeFakeClient } from "./support/fake-client.js";

function makeLoop() {
  const { client, captured } = makeFakeClient([
    { content: "answer one", reasoning_content: "turn one thinking" },
    { content: "answer two", reasoning_content: "turn two thinking" },
  ]);
  const loop = new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "s" }),
    stream: false,
  });
  return { loop, captured };
}

describe("CacheFirstLoop reasoning retention", () => {
  it("keeps a prior turn's reasoning in the log and in the next request", async () => {
    const { loop, captured } = makeLoop();
    for await (const _ev of loop.step("first")) {
      // drain
    }
    for await (const _ev of loop.step("second")) {
      // drain
    }

    const logAssistant = loop.log.toMessages().find((m) => m.role === "assistant");
    expect(logAssistant?.reasoning_content).toBe("turn one thinking");

    const sentAssistant = captured[1]?.messages.find((m) => m.role === "assistant");
    expect(sentAssistant?.reasoning_content).toBe("turn one thinking");
  });
});
