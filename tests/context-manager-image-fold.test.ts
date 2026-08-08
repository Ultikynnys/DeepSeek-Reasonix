import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ToolSpec } from "../src/types.js";
import { type CapturedRequest, makeFakeClient } from "./support/fake-client.js";

function fakeFetch(captured: CapturedRequest[], stubContent: string): typeof fetch {
  return makeFakeClient([{ content: stubContent }], { capture: (req) => captured.push(req) })
    .fetchMock as unknown as typeof fetch;
}

const SYSTEM_PROMPT =
  "You are a coding agent for project X.\nFollow the user's instructions.\nUse tools as needed.";

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

function seedTurns(loop: CacheFirstLoop, n: number, padding = 8): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({
      role: "user",
      content: `q${i}: ${"context padding to weigh the turn ".repeat(padding)}`,
    });
    loop.log.append({
      role: "assistant",
      content: `a${i}: ${"reply padding to weigh the turn ".repeat(padding)}`,
    });
  }
}

describe("ContextManager fold — image content parts", () => {
  it("strips OpenAI image_url parts to a placeholder before the DeepSeek fold summarizer", async () => {
    const captured: CapturedRequest[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(captured, "compact prose summary."),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT, toolSpecs: TOOLS }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    // Image-bearing user turn sits in the foldable head (not the kept tail).
    seedTurns(loop, 2);
    loop.log.append({
      role: "user",
      content: [
        { type: "text", text: `q-img: ${"context padding to weigh the turn ".repeat(8)}` },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    loop.log.append({ role: "assistant", content: "a-img: reply padding" });
    seedTurns(loop, 6);

    const result = await loop.compactHistory({ keepRecentTokens: 40 });
    expect(result.folded).toBe(true);

    // The summary request goes to deepseek-v4-flash — image_url parts would
    // 400, so they must never reach it. The text part survives.
    const req = captured[0]!;
    expect(JSON.stringify(req.messages)).not.toContain("image_url");
    expect(JSON.stringify(req.messages)).toContain("q-img:");
    expect(JSON.stringify(req.messages)).not.toContain("data:image/png;base64");
  });
});
