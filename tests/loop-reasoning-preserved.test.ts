import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { makeFakeClient } from "./support/fake-client.js";

function makeLoop(session?: string, model = "deepseek-reasoner") {
  return new CacheFirstLoop({
    client: makeFakeClient([{ content: "ok" }]).client,
    prefix: new ImmutablePrefix({ system: "s" }),
    model,
    ...(session ? { session } : {}),
    stream: false,
  });
}

describe("Raw-editor reasoning override", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-raw-"));
    vi.stubEnv("USERPROFILE", tmp);
    vi.stubEnv("HOME", tmp);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps hand-written thinking in the log and the request, never on the wire", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });
    loop.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "hand-written thinking" },
    ]);
    for await (const _ev of loop.step("next")) {
      // drain
    }

    const logAssistant = loop.log.toMessages().find((m) => m.role === "assistant");
    expect(logAssistant?.reasoning_content).toBe("hand-written thinking");
    expect(logAssistant?.reasoning_manual).toBe(true);

    const sentAssistant = captured.at(-1)?.messages.find((m) => m.role === "assistant");
    expect(sentAssistant?.reasoning_content).toBe("hand-written thinking");
    expect(sentAssistant && Object.hasOwn(sentAssistant, "reasoning_manual")).toBe(false);
  });

  it("still ages out model-generated reasoning on the next user turn", async () => {
    const { client, captured } = makeFakeClient([
      { content: "one", reasoning_content: "model thinking" },
      { content: "two" },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });
    for await (const _ev of loop.step("first")) {
      // drain
    }
    for await (const _ev of loop.step("second")) {
      // drain
    }

    const sentAssistant = captured.at(-1)?.messages.find((m) => m.role === "assistant");
    expect(sentAssistant).toBeDefined();
    expect(Object.hasOwn(sentAssistant!, "reasoning_content")).toBe(false);
  });

  it("survives a session reload (marker round-trips through the jsonl)", () => {
    const first = makeLoop("raw-reload");
    first.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "hand-written thinking" },
    ]);

    // A fresh loop over the same session is what a reload builds.
    const reloaded = makeLoop("raw-reload")
      .log.toMessages()
      .find((m) => m.role === "assistant");
    expect(reloaded?.reasoning_content).toBe("hand-written thinking");
    expect(reloaded?.reasoning_manual).toBe(true);
  });
});
