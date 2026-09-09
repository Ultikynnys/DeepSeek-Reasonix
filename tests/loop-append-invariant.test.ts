/** Loop-level cache invariant: consecutive model requests extend the previous request by
 *  appended messages only. Folds, /clear, and tool-set changes are deliberate misses, exempt. */

import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage } from "../src/types.js";
import { type CapturedRequest, makeFakeClient } from "./support/fake-client.js";

const SYSTEM_PROMPT = "You are a terse coding assistant. Answer in one sentence.";

/** Every message of `prev` must appear byte-identical at the head of `next`. */
function assertAppendExtension(prev: ChatMessage[], next: ChatMessage[], label: string): void {
  expect(next.length, `${label}: request grew`).toBeGreaterThanOrEqual(prev.length);
  for (let i = 0; i < prev.length; i++) {
    expect(next[i], `${label}: message ${i} rewritten`).toEqual(prev[i]);
  }
}

async function drainTurn(loop: CacheFirstLoop, text: string): Promise<void> {
  for await (const ev of loop.step(text)) {
    void ev;
  }
}

describe("append-only wire invariant (steady state)", () => {
  it("consecutive turns extend the previous request by appended messages only", async () => {
    const fake = makeFakeClient([{ content: "answer one" }, { content: "answer two" }]);
    const loop = new CacheFirstLoop({
      client: fake.client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT }),
      stream: false,
    });

    await drainTurn(loop, "first question");
    await drainTurn(loop, "second question");

    expect(fake.captured).toHaveLength(2);
    assertAppendExtension(
      fake.captured[0]!.messages,
      fake.captured[1]!.messages,
      "turn 2 vs turn 1",
    );
    // The second turn's appends are exactly the prior assistant reply + the new user prompt.
    expect(fake.captured[1]!.messages.length).toBe(fake.captured[0]!.messages.length + 2);
  });

  it("a queued steer appends as a synthetic user record; history bytes stay put", async () => {
    const fake = makeFakeClient([{ content: "answer one" }, { content: "answer two" }]);
    const loop = new CacheFirstLoop({
      client: fake.client,
      prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT }),
      stream: false,
    });

    await drainTurn(loop, "first question");
    loop.steer("also mention the tradeoffs");
    await drainTurn(loop, "second question");

    expect(fake.captured).toHaveLength(2);
    const req1 = fake.captured[0]!.messages;
    const req2 = fake.captured[1]!.messages;
    assertAppendExtension(req1, req2, "steer turn vs turn 1");
    // The steer lands as a user-role record appended after the new prompt;
    // the client strips the internal synthetic flag before the wire.
    const steerMsg = req2[req2.length - 1]!;
    expect(steerMsg.role).toBe("user");
    expect(steerMsg.content).toContain("also mention the tradeoffs");
  });
});
