import { describe, expect, it } from "vitest";
import { contextRawPayload } from "../src/cli/commands/desktop.js";
import { parseContext } from "../src/context-plaintext.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage } from "../src/types.js";
import { makeFakeClient } from "./support/fake-client.js";

type TabArg = Parameters<typeof contextRawPayload>[0];

function makeTab(system: string, messages: ChatMessage[]): TabArg {
  const loop = new CacheFirstLoop({
    client: makeFakeClient([], { echoMessages: true }).client,
    prefix: new ImmutablePrefix({ system }),
    stream: false,
  });
  for (const m of messages) loop.log.append(m);
  return { id: "tab-1", aborter: null, runtime: { loop } } as unknown as TabArg;
}

function makeLoopTab(system: string, messages: ChatMessage[]) {
  const loop = new CacheFirstLoop({
    client: makeFakeClient([], { echoMessages: true }).client,
    prefix: new ImmutablePrefix({ system }),
    model: "deepseek-chat",
    stream: false,
  });
  for (const m of messages) loop.log.append(m);
  const tab = { id: "tab-1", aborter: null, runtime: { loop } } as unknown as TabArg;
  return { tab, loop };
}

describe("contextRawPayload", () => {
  it("serializes the system prompt + conversation as plaintext", () => {
    const payload = contextRawPayload(makeTab("SYS", [{ role: "user", content: "hi" }]));
    expect(payload.type).toBe("$context_raw");
    expect(payload.text).toContain("===== system =====\nSYS");
    expect(payload.text).toContain("===== user =====\nhi");
    expect(payload.messageCount).toBe(1);
    expect(payload.busy).toBe(false);
    expect(payload.tokens).toBeGreaterThan(0);
  });

  it("omits assistant reasoning (output-only, not overwritable)", () => {
    const payload = contextRawPayload(
      makeTab("SYS", [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", reasoning_content: "the reasoning" },
      ]),
    );
    expect(payload.text).not.toContain("===== thinking =====");
    expect(payload.text).not.toContain("the reasoning");
    expect(payload.text).toContain("===== assistant =====\na");
  });

  it("reports busy while a turn is in flight", () => {
    const tab = makeTab("SYS", []);
    (tab as unknown as { aborter: unknown }).aborter = {};
    expect(contextRawPayload(tab).busy).toBe(true);
  });

  it("returns an empty payload when there is no runtime", () => {
    const payload = contextRawPayload({
      id: "x",
      aborter: null,
      runtime: null,
    } as unknown as TabArg);
    expect(payload.text).toBe("");
    expect(payload.messageCount).toBe(0);
    expect(payload.busy).toBe(false);
  });

  it("carries an optional notice through", () => {
    expect(contextRawPayload(makeTab("SYS", []), "note").notice).toBe("note");
  });
});

describe("editing the UI's plaintext modifies the live agent context", () => {
  it("applies a system + message edit to the loop", () => {
    const { tab, loop } = makeLoopTab("OLD SYSTEM", [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ]);
    // The exact text the UI shows, then edited the way a user would.
    const shown = contextRawPayload(tab).text;
    const edited = shown.replace("OLD SYSTEM", "NEW SYSTEM").replace("first", "edited ask");
    const { system, messages } = parseContext(edited);
    loop.replaceConversation(system, messages);

    expect(loop.prefix.system).toBe("NEW SYSTEM");
    expect(loop.log.toMessages()).toEqual([
      { role: "user", content: "edited ask" },
      { role: "assistant", content: "reply" },
    ]);
  });
});
