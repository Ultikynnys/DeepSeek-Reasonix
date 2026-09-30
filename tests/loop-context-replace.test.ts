import { describe, expect, it } from "vitest";
import type { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { makeFakeClient } from "./support/fake-client.js";

function makeLoop(system = "orig system"): CacheFirstLoop {
  const client: DeepSeekClient = makeFakeClient([], { echoMessages: true }).client;
  return new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system }),
    stream: false,
  });
}

describe("CacheFirstLoop.replaceConversation", () => {
  it("replaces the system prompt and the message log wholesale", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "old" });

    const result = loop.replaceConversation("new system", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(result.systemChanged).toBe(true);
    expect(loop.prefix.system).toBe("new system");
    expect(loop.log.toMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("reports systemChanged=false when the prompt is unchanged", () => {
    const loop = makeLoop("same");
    const result = loop.replaceConversation("same", [{ role: "user", content: "x" }]);
    expect(result.systemChanged).toBe(false);
    expect(loop.prefix.system).toBe("same");
  });

  it("heals orphan tool messages before applying (never ships an invalid shape)", () => {
    const loop = makeLoop();
    const result = loop.replaceConversation("s", [
      { role: "user", content: "q" },
      // A tool result with no preceding tool_calls is unvalidatable, healed away.
      { role: "tool", tool_call_id: "missing", content: "orphan" },
    ]);
    expect(result.dropped).toBe(1);
    expect(loop.log.toMessages()).toEqual([{ role: "user", content: "q" }]);
  });
});
