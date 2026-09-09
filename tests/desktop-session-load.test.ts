import { describe, expect, it } from "vitest";
import * as desktopCommand from "../src/cli/commands/desktop.js";
import type { ChatMessage } from "../src/types.js";

type BuildLoadedMessages = (records: ChatMessage[]) => Array<{
  kind: "assistant" | "user";
  text?: string;
  images?: string[];
  segments?: Array<{ kind: string; text?: string; args?: string; result?: string }>;
}>;

describe("desktop session loading", () => {
  const buildLoadedMessages = (desktopCommand as { buildLoadedMessages?: BuildLoadedMessages })
    .buildLoadedMessages;

  it("elides old heavy assistant segments before sending $session_loaded", () => {
    expect(typeof buildLoadedMessages).toBe("function");

    const huge = "desktop retained field\n".repeat(900);
    const records: ChatMessage[] = [];
    for (let i = 0; i < 260; i++) {
      records.push({
        role: "assistant",
        content: huge,
        reasoning_content: huge,
        tool_calls: [
          {
            id: `c-${i}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: `file-${i}.txt`, content: huge }),
            },
          },
        ],
      });
      records.push({ role: "tool", tool_call_id: `c-${i}`, content: huge });
    }

    const loaded = buildLoadedMessages!(records);
    const firstAssistant = loaded.find((m) => m.kind === "assistant");
    expect(firstAssistant).toBeDefined();
    const reasoning = firstAssistant!.segments!.find((s) => s.kind === "reasoning");
    const text = firstAssistant!.segments!.find((s) => s.kind === "text");
    const tool = firstAssistant!.segments!.find((s) => s.kind === "tool");

    expect(reasoning?.text?.length).toBeLessThan(huge.length / 10);
    expect(text?.text?.length).toBeLessThan(huge.length / 10);
    expect(tool?.args?.length).toBeLessThan(huge.length / 10);
    expect(tool?.result?.length).toBeLessThan(huge.length / 10);
  });

  it("extracts text + image data URLs from OpenAI user content arrays", () => {
    const records: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what does this show?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    const loaded = buildLoadedMessages!(records);
    const user = loaded[0];
    expect(user?.kind).toBe("user");
    if (user?.kind === "user") {
      expect(user.text).toBe("what does this show?");
      expect(user.images).toEqual(["data:image/png;base64,AAAA"]);
    }
  });

  it("keeps plain-text user records without an images field", () => {
    const loaded = buildLoadedMessages!([{ role: "user", content: "just text" }]);
    const user = loaded[0];
    expect(user?.kind).toBe("user");
    if (user?.kind === "user") {
      expect(user.text).toBe("just text");
      expect(user.images).toBeUndefined();
    }
  });

  it("numbers tool-loop assistant records by their owning user turn", () => {
    const records: ChatMessage[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "file body" },
      {
        role: "assistant",
        content: "final answer",
      },
      { role: "user", content: "second" },
      { role: "assistant", content: "second answer" },
    ];
    const loaded = buildLoadedMessages!(records);
    // Three assistant records: two for turn 1's tool loop, one for turn 2.
    const assistants = loaded.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants.map((a) => (a.kind === "assistant" ? a.turn : -1))).toEqual([1, 1, 2]);
    // Tool results stay attached to their declaring record.
    const firstRecord = assistants[0];
    if (firstRecord?.kind !== "assistant") throw new Error("expected assistant");
    const toolSeg = firstRecord.segments.find((s) => s.kind === "tool");
    if (toolSeg?.kind !== "tool") throw new Error("expected tool segment");
    expect(toolSeg.result).toBe("file body");
    const users = loaded.filter((m) => m.kind === "user");
    expect(users).toHaveLength(2);
  });

  it("drops synthetic user records — steers and nudges never start a turn or render", () => {
    const records: ChatMessage[] = [
      { role: "user", content: "real one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "mid-turn steer text", synthetic: true },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "real two" },
    ];
    const loaded = buildLoadedMessages!(records);
    const kinds = loaded.map((m) => m.kind);
    expect(kinds).toEqual(["user", "assistant", "assistant", "user"]);
    const texts = loaded.map((m) => (m.kind === "user" ? m.text : ""));
    expect(texts).not.toContain("mid-turn steer text");
  });

  it("keeps a failed turn's user record as its own turn (no assistant reply)", () => {
    const records: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "failed prompt" },
      { role: "user", content: "three" },
    ];
    const loaded = buildLoadedMessages!(records);
    expect(loaded).toHaveLength(4);
    const users = loaded.filter((m) => m.kind === "user");
    expect(users).toHaveLength(3);
    expect(users.map((m) => (m.kind === "user" ? m.text : ""))).toEqual([
      "one",
      "failed prompt",
      "three",
    ]);
  });

  it("maps an assistant generated-image content part to an image segment", () => {
    const records: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "here you go" },
          { type: "image", data_url: "data:image/jpeg;base64,AAAA", mime_type: "image/jpeg" },
        ],
      },
    ];
    const loaded = buildLoadedMessages!(records);
    const assistant = loaded[0];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind === "assistant") {
      expect(assistant.segments).toEqual([
        { kind: "text", text: "here you go" },
        { kind: "image", dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" },
      ]);
    }
  });
});
