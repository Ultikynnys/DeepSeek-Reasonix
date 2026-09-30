import { describe, expect, it } from "vitest";
import { parseContext, serializeContext } from "../src/context-plaintext.js";
import type { ChatMessage } from "../src/types.js";

describe("serializeContext", () => {
  it("renders the system prompt once and each message as a labelled block", () => {
    const text = serializeContext({
      system: "You are Reasonix.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(text).toContain("===== system =====\nYou are Reasonix.");
    expect(text).toContain("===== user =====\nhi");
    expect(text).toContain("===== assistant =====\nhello");
  });

  it("never renders a system message from the log twice", () => {
    const text = serializeContext({
      system: "SYS",
      messages: [{ role: "system", content: "SYS" }],
    });
    expect(text.match(/===== system =====/g)).toHaveLength(1);
  });

  it("annotates assistant tool_calls informationally", () => {
    const text = serializeContext({
      system: "s",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
      ],
    });
    expect(text).toContain("[tool_calls: read_file]");
  });

  it("collapses multimodal user content to text with an image placeholder", () => {
    const text = serializeContext({
      system: "s",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look: " },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(text).toContain("===== user =====\nlook: [image]");
  });

  it("renders tool results as named blocks", () => {
    const text = serializeContext({
      system: "s",
      messages: [{ role: "tool", name: "read_file", content: "file body" }],
    });
    expect(text).toContain("===== tool: read_file =====\nfile body");
  });

  it("renders a thinking block before an assistant turn that carries reasoning", () => {
    const text = serializeContext({
      system: "s",
      messages: [{ role: "assistant", content: "answer", reasoning_content: "why" }],
    });
    expect(text).toContain("===== thinking =====\nwhy");
    expect(text.indexOf("===== thinking =====")).toBeLessThan(
      text.indexOf("===== assistant ====="),
    );
  });
});

describe("parseContext", () => {
  it("round-trips system + user/assistant text", () => {
    const original = {
      system: "You are Reasonix.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ] as ChatMessage[],
    };
    const parsed = parseContext(serializeContext(original));
    expect(parsed.system).toBe("You are Reasonix.");
    expect(parsed.messages).toEqual(original.messages);
  });

  it("round-trips reasoning through a thinking block", () => {
    const original = {
      system: "s",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", reasoning_content: "because" },
      ] as ChatMessage[],
    };
    expect(parseContext(serializeContext(original)).messages).toEqual(original.messages);
  });

  it("drops a thinking block that has no following assistant", () => {
    expect(parseContext("===== thinking =====\nsolo").messages).toEqual([]);
  });

  it("drops the informational tool_calls note", () => {
    const text = "===== assistant =====\nthinking\n[tool_calls: read_file]";
    const parsed = parseContext(text);
    expect(parsed.messages).toEqual([{ role: "assistant", content: "thinking" }]);
  });

  it("drops tool blocks (unvalidatable without their tool_calls)", () => {
    const text = [
      "===== user =====",
      "do it",
      "===== tool: read_file =====",
      "contents",
      "===== assistant =====",
      "done",
    ].join("\n");
    const parsed = parseContext(text);
    expect(parsed.messages).toEqual([
      { role: "user", content: "do it" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("treats content that only resembles a separator as ordinary text", () => {
    const text = "===== user =====\nnot ===== a real header =====";
    const parsed = parseContext(text);
    expect(parsed.messages).toEqual([{ role: "user", content: "not ===== a real header =====" }]);
  });

  it("ignores text before the first header", () => {
    const parsed = parseContext("stray preamble\n===== system =====\nsys");
    expect(parsed.system).toBe("sys");
    expect(parsed.messages).toEqual([]);
  });

  it("returns empty context for input with no headers", () => {
    expect(parseContext("just some text")).toEqual({ system: "", messages: [] });
  });
});
