import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/types.js";
import { makeFakeClient } from "./support/fake-client.js";

/** History that round-trips both message kinds the DeepSeek deserializer
 *  demands ids for: an assistant message carrying tool_calls, and the
 *  matching tool result. */
const HISTORY: ChatMessage[] = [
  { role: "user", content: "read the file" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "call-1", name: "read_file", content: "contents" },
];

describe("DeepSeek wire-path message ids", () => {
  it("stamps msg-<index> ids on assistant/tool messages for deepseek requests", async () => {
    const { client, captured } = makeFakeClient([{ content: "done" }]);
    await client.chat({
      model: "deepseek-v4-flash",
      messages: [...HISTORY, { role: "assistant", content: "final answer" }],
      tools: [],
    });

    const sent = captured[0]?.messages ?? [];
    expect(sent.length).toBe(4);
    sent.forEach((m, i) => {
      if (m.role === "assistant" || m.role === "tool") {
        expect(m.id, `role ${m.role} at ${i}`).toBe(`msg-${i}`);
      } else {
        expect(m.id).toBeUndefined();
      }
    });
  });

  it("leaves existing ids untouched", async () => {
    const { client, captured } = makeFakeClient([{ content: "done" }]);
    await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ ...HISTORY[0]!, id: "keep-me" }],
      tools: [],
    });
    expect(captured[0]?.messages[0]?.id).toBe("keep-me");
  });

  it("does not stamp ids for other providers", async () => {
    const { client, captured } = makeFakeClient([{ content: "done" }]);
    await client.chat({
      model: "glm-5.3",
      messages: HISTORY,
      tools: [],
    });
    for (const m of captured[0]?.messages ?? []) {
      expect(m.id).toBeUndefined();
    }
  });

  it("keeps ids deterministic across repeated sends of the same log state", async () => {
    const first = makeFakeClient([{ content: "done" }]);
    const second = makeFakeClient([{ content: "done" }]);
    await first.client.chat({ model: "deepseek-v4-flash", messages: HISTORY, tools: [] });
    await second.client.chat({ model: "deepseek-v4-flash", messages: HISTORY, tools: [] });
    expect(first.captured[0]?.messages.map((m) => m.id)).toEqual(
      second.captured[0]?.messages.map((m) => m.id),
    );
  });
});
