import { describe, expect, it } from "vitest";
import type { DeepSeekClient, StreamChunk } from "../src/client.js";
import type { ReasoningEffort } from "../src/config.js";
import { streamModelResponse } from "../src/loop/streaming.js";
import type { StreamModelResult } from "../src/loop/streaming.js";

function fakeClient(chunks: StreamChunk[]): DeepSeekClient {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as DeepSeekClient;
}

async function run(chunks: StreamChunk[]): Promise<StreamModelResult> {
  const gen = streamModelResponse({
    client: fakeClient(chunks),
    model: "test-model",
    messages: [],
    toolSpecs: [],
    signal: new AbortController().signal,
    reasoningEffort: "low" as ReasoningEffort,
    turn: 1,
  });
  // Drain the async generator; the settled result is the generator's return value.
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

function argChunks(name: string, args: string, deltaSize = 20): StreamChunk[] {
  const chunks: StreamChunk[] = [{ toolCallDelta: { index: 0, id: "call_1", name } }];
  for (let i = 0; i < args.length; i += deltaSize) {
    chunks.push({ toolCallDelta: { index: 0, argumentsDelta: args.slice(i, i + deltaSize) } });
  }
  return chunks;
}

describe("streamModelResponse — repetition stall false positives", () => {
  it("does not stall a write_file whose content legitimately repeats lines", async () => {
    const line = "server.listen(8080);\\n";
    const args = JSON.stringify({ path: "src/index.js", content: line.repeat(20) });
    const result = await run(argChunks("write_file", args));

    expect(result.repetitionStall).toBeUndefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.function.arguments).toBe(args);
  });

  it("does not stall edit_file arguments containing a repeated SEARCH block", async () => {
    const repeated = "  return sameValue;\n";
    const args = JSON.stringify({
      path: "src/mod.ts",
      search: repeated.repeat(10),
      replace: repeated.repeat(10),
    });
    const result = await run(argChunks("edit_file", args));

    expect(result.repetitionStall).toBeUndefined();
    expect(result.toolCalls[0]!.function.arguments).toBe(args);
  });

  it("still stalls a non-exempt tool whose arguments degenerate", async () => {
    const args = "a".repeat(400);
    const result = await run(argChunks("web_search", args));

    expect(result.repetitionStall).toMatchObject({ channel: "tool_call", period: 1 });
  });

  it("does not stall healthy reasoning that restates a hypothesis 3x", async () => {
    const healthy = Array.from(
      { length: 30 },
      (_, i) =>
        `Step ${i}: inspected the retry branch, confirmed the 5xx path retries once, and noted finding ${i * 7}.`,
    ).join("\n\n");
    const para =
      "Let me reconsider the providerErrorRetryable check. For a 500 error it should be true, unless the error is being thrown as a 4xx by the parse path. But opencode uses chat-completions, not responses, so that is unlikely.";
    const reasoning = `${healthy}\n\n${`${para}\n`.repeat(3)}`;
    const chunks: StreamChunk[] = [];
    for (let i = 0; i < reasoning.length; i += 17) {
      chunks.push({ reasoningDelta: reasoning.slice(i, i + 17) });
    }

    const result = await run(chunks);

    expect(result.repetitionStall).toBeUndefined();
    expect(result.reasoningContent).toBe(reasoning);
  });
});
