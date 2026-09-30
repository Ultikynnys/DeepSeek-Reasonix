import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { makeFakeClient } from "./support/fake-client.js";

describe("Raw-editor reasoning override", () => {
  it("keeps hand-written thinking in the log and the request, never on the wire", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });
    loop.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "hand-written thinking" },
    ]);
    for await (const _ev of loop.step("next")) {
      // drain
    }

    const logAssistant = loop.log.toMessages().find((m) => m.role === "assistant");
    expect(logAssistant?.reasoning_content).toBe("hand-written thinking");
    expect(logAssistant?.reasoning_manual).toBe(true);

    const sentAssistant = captured.at(-1)?.messages.find((m) => m.role === "assistant");
    expect(sentAssistant?.reasoning_content).toBe("hand-written thinking");
    expect(sentAssistant && Object.hasOwn(sentAssistant, "reasoning_manual")).toBe(false);
  });

  it("still ages out model-generated reasoning on the next user turn", async () => {
    const { client, captured } = makeFakeClient([
      { content: "one", reasoning_content: "model thinking" },
      { content: "two" },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });
    for await (const _ev of loop.step("first")) {
      // drain
    }
    for await (const _ev of loop.step("second")) {
      // drain
    }

    const sentAssistant = captured.at(-1)?.messages.find((m) => m.role === "assistant");
    expect(sentAssistant).toBeDefined();
    expect(Object.hasOwn(sentAssistant!, "reasoning_content")).toBe(false);
  });
});
