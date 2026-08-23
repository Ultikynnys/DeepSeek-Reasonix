import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import { registerSeeImageTool } from "../src/tools/see-image.js";
import { makeFakeClient } from "./support/fake-client.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

async function consume(loop: CacheFirstLoop, text: string, images?: string[]): Promise<void> {
  for await (const ev of loop.step(text, images)) {
    if (ev.role === "done") break;
  }
}

describe("CacheFirstLoop — image attachments (OpenAI vision parts)", () => {
  it("builds OpenAI content parts when images are attached", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    await consume(loop, "what does this show?", [DATA_URL]);

    const userMsg = captured[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toEqual([
      { type: "text", text: "what does this show?" },
      { type: "image_url", image_url: { url: DATA_URL, detail: "low" } },
    ]);
  });

  it("keeps plain string content when no images are attached (prefix-cache stable)", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    await consume(loop, "hello");

    const userMsg = captured[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("hello");
  });

  it("allows an image-only message with empty text", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    await consume(loop, "", [DATA_URL]);

    const userMsg = captured[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toEqual([
      { type: "image_url", image_url: { url: DATA_URL, detail: "low" } },
    ]);
  });

  it("forwards the turn's attached images into tool dispatch (see_image)", async () => {
    const { client, captured } = makeFakeClient([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "see_image", arguments: "{}" },
          },
        ],
      },
      { content: "ok" },
    ]);
    const tools = new ToolRegistry();
    registerSeeImageTool(tools);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
      tools,
    });
    await consume(loop, "what does this show?", [DATA_URL]);

    const toolMsg = captured[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("1 image(s) attached to the current turn");
    expect(toolMsg?.content).toContain("visible to you directly");
  });

  it("delivers a see_image path call's pixels to the model on a USER message", async () => {
    const root = mkdtempSync(join(tmpdir(), "see-image-loop-"));
    try {
      const bytes = "fake-png-bytes";
      writeFileSync(join(root, "sprite.png"), bytes, "utf8");
      const { client, captured } = makeFakeClient([
        {
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "see_image", arguments: JSON.stringify({ path: "sprite.png" }) },
            },
          ],
        },
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      registerSeeImageTool(tools, { rootDir: root });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "be brief" }),
        stream: false,
        tools,
        hookCwd: root,
      });
      await consume(loop, "describe this");

      const messages = captured[1]!.messages;
      // The tool result stays a string (text summary) so pairing holds.
      const toolMsg = messages.find((m) => m.role === "tool");
      expect(typeof toolMsg?.content).toBe("string");
      // A follow-up USER message carries the image_url part so the vision model
      // actually receives the pixels (Ollama ignores images on tool messages).
      const imgUserMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
      const parts = imgUserMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(Array.isArray(parts)).toBe(true);
      const image = parts.find((p) => p.type === "image_url");
      const b64 = image?.image_url?.url?.split(",")[1] ?? "";
      expect(Buffer.from(b64, "base64").toString("utf8")).toBe(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
