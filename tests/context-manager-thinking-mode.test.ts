import { describe, expect, it } from "vitest";
import type { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
  return makeFakeClient(responses).client;
}

function seedTurns(loop: CacheFirstLoop, n: number): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({ role: "user", content: `q${i} bulk text padding to weigh the turn` });
    loop.log.append({
      role: "assistant",
      content: `a${i} bulk text padding to weigh the turn`,
      reasoning_content: `r${i} thinking trace`,
    });
  }
}

describe("ContextManager fold preserves reasoning_content for thinking-mode (#1042)", () => {
  it("stamps reasoning_content on the synthesized fold summary so the next API call doesn't 400", async () => {
    const client = makeClient([
      { content: "earlier turns covered the user's auth refactor.", reasoning_content: "thought" },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);

    const head = loop.log.entries[0]!;
    expect(head.role).toBe("assistant");
    expect(head.content).toMatch(/HISTORY SUMMARY/);
    expect(head.reasoning_content).toBeDefined();
    expect(head.reasoning_content).toBe("thought");
  });

  it("stamps empty reasoning_content when the summarizer response omitted it (thinking-mode contract)", async () => {
    const client = makeClient([{ content: "earlier turns happened." }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);

    const head = loop.log.entries[0]!;
    expect(head.reasoning_content).toBe("");
  });

  it("omits reasoning_content for non-thinking-mode session models when summarizer returned none", async () => {
    const client = makeClient([{ content: "earlier turns happened." }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-chat",
      stream: false,
    });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);

    const head = loop.log.entries[0]!;
    expect(head.reasoning_content).toBeUndefined();
  });
});
