/** CacheFirstLoop hook wiring — confirms the loop honors `hooks` and exposes a swappable list for `/hooks reload`. */

import { describe, expect, it } from "vitest";
import type { DeepSeekClient } from "../src/client.js";
import type { ResolvedHook } from "../src/hooks.js";
import { CacheFirstLoop, type LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
  return makeFakeClient(responses, { echoMessages: true }).client;
}

describe("CacheFirstLoop hook wiring", () => {
  it("default hooks list is empty (zero overhead when no settings.json)", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    expect(loop.hooks).toEqual([]);
  });

  it("accepts a hooks list via options", () => {
    const hooks: ResolvedHook[] = [
      { event: "Stop", scope: "global", source: "/x", command: "echo done" },
    ];
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
      hooks,
    });
    expect(loop.hooks).toEqual(hooks);
  });

  it("hooks field is mutable so /hooks reload can swap without rebuild", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    const fresh: ResolvedHook[] = [
      { event: "PreToolUse", scope: "project", source: "/x", command: "true" },
    ];
    loop.hooks = fresh;
    expect(loop.hooks).toEqual(fresh);
  });

  it("hookCwd defaults to process.cwd() when not provided", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    expect(loop.hookCwd).toBe(process.cwd());
  });

  it("hookCwd takes the explicit override when set", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
      hookCwd: "/some/sandbox/root",
    });
    expect(loop.hookCwd).toBe("/some/sandbox/root");
  });

  it("a no-tool-call turn never dispatches hooks (PreToolUse only fires around tools)", async () => {
    // Sanity check: a plain text response means no PreToolUse hook
    // would be invoked even if one were configured. We assert only
    // through observable events here — no hook = no warning rows.
    const client = makeClient([{ content: "just chatting" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      hooks: [{ event: "PreToolUse", scope: "global", source: "/x", command: "noop" }],
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hi")) events.push(ev);
    expect(events.find((e) => e.role === "warning")).toBeUndefined();
    expect(events.find((e) => e.role === "assistant_final")?.content).toBe("just chatting");
  });
});
