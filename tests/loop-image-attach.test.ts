import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
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
});
