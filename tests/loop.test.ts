/** CacheFirstLoop integration — fake-fetch DeepSeekClient, non-streaming path. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type ResolvedTransport, Usage } from "../src/client.js";
import {
  HISTORY_FOLD_AGGRESSIVE_THRESHOLD,
  HISTORY_FOLD_THRESHOLD,
} from "../src/context-manager.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

const FOLD_TEST_MODEL = "test-fold-ctx";

function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
  return makeFakeClient(responses, { echoMessages: true }).client;
}

/** Direct-fetch call sites (prefix-stability / multi-client tests) — same harness as makeClient. */
const fakeFetch = (responses: FakeResponseShape[]): typeof fetch =>
  makeFakeClient(responses, { echoMessages: true }).fetchMock as unknown as typeof fetch;

describe("CacheFirstLoop (non-streaming)", () => {
  afterEach(() => {
    delete DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL];
  });

  it("completes a single-turn plain chat", async () => {
    const client = makeClient([{ content: "hi there" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });

    const events: string[] = [];
    for await (const ev of loop.step("hello")) {
      events.push(ev.role);
    }

    expect(events).toContain("assistant_final");
    expect(events[events.length - 1]).toBe("done");
    expect(loop.stats.turns.length).toBe(1);
    expect(loop.log.length).toBe(2); // user + assistant
  });

  it("retries once when the model returns a fully empty completion, then recovers", async () => {
    const client = makeClient([{ content: "" }, { content: "recovered" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    // One visible retry warning, then the second attempt answered normally.
    expect(events.filter((e) => e.role === "warning").length).toBe(1);
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals.length).toBe(1);
    expect(finals[0]?.content).toBe("recovered");
    expect(events[events.length - 1]?.role).toBe("done");
    // The empty completion was NOT appended to the log — only user + answer.
    expect(loop.log.length).toBe(2);
  });

  it("gives up loudly after two consecutive empty completions instead of a silent turn", async () => {
    const client = makeClient([{ content: "" }, { content: "" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    const warnings = events.filter((e) => e.role === "warning");
    expect(warnings.length).toBe(2);
    expect(warnings[0]?.content).toContain("retrying");
    expect(warnings[1]?.content).toContain("twice");
    // No final, no done — the turn ends after the give-up warning, but the
    // user saw why instead of a silent dead turn.
    expect(events.some((e) => e.role === "assistant_final")).toBe(false);
    expect(events.some((e) => e.role === "done")).toBe(false);
    // Nothing from the failed attempts landed in the log.
    expect(loop.log.length).toBe(1);
  });

  it("records cache hit telemetry from API usage", async () => {
    const client = makeClient([
      {
        content: "ok",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        },
      },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    await loop.run("q");
    expect(loop.stats.aggregateCacheHitRatio).toBeCloseTo(0.8);
    expect(loop.stats.totalCost).toBeGreaterThan(0);
    // Savings vs Claude depends on which DeepSeek model is the loop's
    // default. v4-pro lands around 0.85; v4-flash around 0.97. Test the
    // lower bound so a future default swap doesn't churn this assertion.
    expect(loop.stats.savingsVsClaude).toBeGreaterThan(0.8);
  });

  it("dispatches a tool call and loops until the model stops", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":2,"b":3}' },
          },
        ],
      },
      { content: "The answer is 5." },
    ]);

    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({
        system: "use add tool",
        toolSpecs: tools.specs(),
      }),
      tools,
      stream: false,
    });

    const roles: string[] = [];
    let toolContent = "";
    let finalContent = "";
    for await (const ev of loop.step("2 + 3 = ?")) {
      roles.push(ev.role);
      if (ev.role === "tool") toolContent = ev.content;
      if (ev.role === "assistant_final") finalContent = ev.content;
    }

    expect(roles).toContain("tool");
    expect(toolContent).toBe("5");
    expect(finalContent).toBe("The answer is 5.");
    expect(loop.stats.turns.length).toBe(2); // two model round-trips
  });

  it("yields tool_start before each tool dispatch so the TUI can show 'running…'", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      },
      { content: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    const roleOrder: { role: string; toolName?: string }[] = [];
    for await (const ev of loop.step("go")) {
      if (ev.role === "tool_start" || ev.role === "tool") {
        roleOrder.push({ role: ev.role, toolName: ev.toolName });
      }
    }
    // tool_start must precede the matching tool result.
    expect(roleOrder[0]).toEqual({ role: "tool_start", toolName: "add" });
    expect(roleOrder[1]).toEqual({ role: "tool", toolName: "add" });
  });

  it("surfaces a warning when a tool call is rate-limited", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "echo", arguments: '{"msg":"one"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "echo", arguments: '{"msg":"two"}' },
          },
          {
            id: "call_3",
            type: "function",
            function: { name: "echo", arguments: '{"msg":"three"}' },
          },
        ],
      },
      { content: "done" },
    ]);
    const tools = new ToolRegistry({
      rateLimit: { aggregate: { maxCalls: 2, windowSeconds: 60 }, tools: {} },
    });
    const seen: string[] = [];
    tools.register<{ msg: string }, string>({
      name: "echo",
      parallelSafe: true,
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      fn: ({ msg }) => {
        seen.push(msg);
        return msg;
      },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    const warnings: string[] = [];
    const toolResults: string[] = [];
    for await (const ev of loop.step("go")) {
      if (ev.role === "warning") warnings.push(ev.content);
      if (ev.role === "tool") toolResults.push(ev.content);
    }

    expect(seen).toEqual(["one", "two"]);
    expect(toolResults).toHaveLength(3);
    expect(JSON.parse(toolResults[2]!).error).toBe("rate_limited");
    expect(warnings.filter((content) => content.includes("rate-limited"))).toHaveLength(1);
  });

  it("immutable prefix is preserved across turns (cache-stability invariant)", async () => {
    const sharedFetch = fakeFetch([{ content: "a" }, { content: "b" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: sharedFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "pinned system" }),
      stream: false,
    });

    await loop.run("q1");
    await loop.run("q2");

    const calls = (sharedFetch as any).mock.calls;
    expect(calls.length).toBe(2);
    const msgs1 = JSON.parse(calls[0][1].body).messages as ChatMessage[];
    const msgs2 = JSON.parse(calls[1][1].body).messages as ChatMessage[];

    // Both requests start with the exact same system prefix (byte-identical).
    expect(msgs1[0]).toEqual({ role: "system", content: "pinned system" });
    expect(msgs2[0]).toEqual({ role: "system", content: "pinned system" });

    // Second request should begin with msgs1 as its prefix
    // (append-only log invariant: history is never rewritten).
    for (let i = 0; i < msgs1.length; i++) {
      expect(msgs2[i]).toEqual(msgs1[i]);
    }
    // And msgs2 is strictly longer (new user turn + assistant reply from turn 1).
    expect(msgs2.length).toBeGreaterThan(msgs1.length);
  });

  it("abort() mid-step stops immediately without a follow-up API call", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const chainingToolCall = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    // Only one chaining response needed — abort should stop the loop
    // before any follow-up model call. A second response in the array
    // would indicate the loop made an unwanted extra API call.
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const responses: FakeResponseShape[] = [chainingToolCall];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(responses) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 16,
    });

    // Call abort AFTER the first tool event fires — simulates the user
    // hitting Esc while the loop is exploring.
    const events: { role: string; content?: string; forcedSummary?: boolean }[] = [];
    let aborted = false;
    for await (const ev of loop.step("go")) {
      events.push({ role: ev.role, content: ev.content, forcedSummary: ev.forcedSummary });
      if (!aborted && ev.role === "tool") {
        aborted = true;
        loop.abort();
      }
    }

    // Synthetic assistant_final is tagged forcedSummary and carries
    // the stopped-message text. It should NOT contain any model
    // output because no second API call was made.
    const finals = events.filter((e) => e.role === "assistant_final");
    const stopped = finals[finals.length - 1]!;
    expect(stopped.forcedSummary).toBe(true);
    expect(stopped.content).toMatch(/aborted by user \(Esc\)/);
    expect(stopped.content).toMatch(/no summary produced/);

    // Suite ends with `done`.
    expect(events[events.length - 1]!.role).toBe("done");
    // Silence unused-var warning.
    void fetchSpy;
  });

  it("cancelToolCall stops exactly one of two parallel tools (TUI Stop button)", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "blocker",
      parallelSafe: true,
      description: "blocks until the per-tool cancel signal fires",
      parameters: { type: "object", properties: {} },
      fn: async (_args: unknown, ctx: { cancelSignal?: AbortSignal }) => {
        const sig = ctx.cancelSignal;
        if (sig) {
          await new Promise<void>((resolve) => {
            if (sig.aborted) return resolve();
            sig.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return JSON.stringify({ cancelledByUser: true });
      },
    });
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "blocker", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "blocker", arguments: "{}" } },
        ],
      },
      { content: "both done" },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
    });

    const stepPromise = (async () => {
      const events: { role: string; content?: string }[] = [];
      for await (const ev of loop.step("go")) {
        events.push({ role: ev.role, content: ev.content });
      }
      return events;
    })();

    // Both calls are running in parallel — the chunk is inflight.
    await vi.waitFor(() => expect(loop.inflight.size).toBe(2));

    // A Stop click on call_a must kill only call_a…
    loop.cancelToolCall("call_a", "Stop");
    await vi.waitFor(() => expect(loop.inflight.size).toBe(1));
    expect(loop.inflight.has("call_b")).toBe(true);

    // …and call_b keeps running until its own stop.
    loop.cancelToolCall("call_b", "Stop");
    const events = await stepPromise;

    const cancelledTools = events.filter(
      (e) => e.role === "tool" && (e.content ?? "").includes("cancelledByUser"),
    );
    expect(cancelledTools).toHaveLength(2);
    expect(events[events.length - 1]!.role).toBe("done");
  });

  it("does not bleed the prior turn's abort into the next step", async () => {
    // Regression: a user pressing Esc once would put _turnAbort into
    // an aborted state; the iter-0 abort branch handled it but didn't
    // reset the controller. Every subsequent step() then carried the
    // stale aborted state forward and bailed out with the synthetic
    // stopped-summary before any model call ran. The session was
    // effectively dead until restart.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const chainingToolCall = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    const finalAnswer = { content: "second turn ran cleanly", tool_calls: [] };
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch([chainingToolCall, finalAnswer]) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 16,
    });

    // Turn 1 — abort mid-flight.
    let aborted = false;
    for await (const ev of loop.step("first")) {
      if (!aborted && ev.role === "tool") {
        aborted = true;
        loop.abort();
      }
    }

    // Turn 2 — fresh user input; should reach the second model call
    // and yield its output. If the bug is back, we see iter-0 abort
    // again and never see "second turn ran cleanly".
    const turn2Events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("second")) {
      turn2Events.push({ role: ev.role, content: ev.content });
    }

    const finals = turn2Events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("second turn ran cleanly");
  });

  it("does not bleed when consumer breaks for-await mid-abort-yield", async () => {
    // Desktop runTurn checks its own outer aborter after each yielded
    // event and `break`s out. That calls generator.return() on step(),
    // which throws into the suspended yield and skips any straight-line
    // code after it. If `_turnAbort = new AbortController()` sits after
    // a yield (rather than in finally), the reset is lost and every
    // subsequent step() locks at iter 0 via carryAbort.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const chainingToolCall = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    const finalAnswer = { content: "second turn ran cleanly", tool_calls: [] };
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch([chainingToolCall, finalAnswer]) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 16,
    });

    let aborted = false;
    for await (const ev of loop.step("first")) {
      if (!aborted && ev.role === "tool") {
        aborted = true;
        loop.abort();
        continue;
      }
      if (aborted && ev.role === "assistant_final" && ev.forcedSummary) {
        // Mirror desktop runTurn: drop out of for-await mid-abort-drain,
        // before `done` is yielded — exercises the finally-block reset.
        break;
      }
    }

    const turn2Events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("second")) {
      turn2Events.push({ role: ev.role, content: ev.content });
    }

    const finals = turn2Events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("second turn ran cleanly");
  });

  it("does not bleed an abort landing in the normal-completion tail (consumer break at assistant_final)", async () => {
    // Desktop runTurn's Stop path: abortTurn() fires loop.abort() while
    // the turn is completing NORMALLY (the model already answered, so no
    // abort path ever runs), and the consumer breaks at the
    // assistant_final yield. generator.return() skips the tail
    // straight-line code, so nothing resets _turnAbort. The next step()
    // used to carry the stale abort and instantly kill the user's next
    // message — the "send it a second time" bug.
    const firstAnswer = { content: "first turn done", tool_calls: [] };
    const secondAnswer = { content: "second turn ran cleanly", tool_calls: [] };
    const client = makeClient([firstAnswer, secondAnswer]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    let aborted = false;
    for await (const ev of loop.step("first")) {
      if (!aborted && ev.role === "assistant_final") {
        aborted = true;
        loop.abort();
        break;
      }
    }

    const turn2Events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("second")) {
      turn2Events.push({ role: ev.role, content: ev.content });
    }

    const finals = turn2Events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("second turn ran cleanly");
  });

  it("does not bleed an abort fired after the previous turn completed (Stop-hook teardown window)", async () => {
    // TUI window: the generator has fully completed (the answer is
    // rendered) but the App is still busy running Stop hooks / teardown.
    // Esc in that window aborts the dead turn's controller; the next
    // message used to be cancelled and require a re-send.
    const firstAnswer = { content: "first turn done", tool_calls: [] };
    const secondAnswer = { content: "second turn ran cleanly", tool_calls: [] };
    const client = makeClient([firstAnswer, secondAnswer]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    // Turn 1 — drain to completion, THEN abort (as if Esc landed while
    // the App was still tearing the turn down).
    for await (const _ev of loop.step("first")) {
      // drain
    }
    loop.abort();

    const turn2Events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("second")) {
      turn2Events.push({ role: ev.role, content: ev.content });
    }

    const finals = turn2Events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("second turn ran cleanly");
  });

  it("first all-suppressed storm self-corrects in-turn instead of stopping", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const dupCall = {
      id: "c1",
      type: "function",
      function: { name: "probe", arguments: "{}" },
    };
    const responses: FakeResponseShape[] = [
      { content: "", tool_calls: [dupCall] },
      { content: "", tool_calls: [{ ...dupCall, id: "c2" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c3" }] },
      { content: "got it — done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("explore")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    expect(
      events.some((e) => e.role === "warning" && /repeated tool call/i.test(e.content ?? "")),
    ).toBe(true);
    expect(
      events.some((e) => e.role === "warning" && /stuck retry loop/i.test(e.content ?? "")),
    ).toBe(false);

    const finals = events.filter((e) => e.role === "assistant_final");
    const final = finals[finals.length - 1];
    expect(final?.forcedSummary).toBeFalsy();
    expect(final?.content).toBe("got it — done.");

    const tail = loop.log.entries[loop.log.entries.length - 1];
    expect(tail?.role).toBe("assistant");
  });

  it("second all-suppressed storm in same turn falls back to forced summary", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const dupCall = {
      id: "c1",
      type: "function",
      function: { name: "probe", arguments: "{}" },
    };
    const responses: FakeResponseShape[] = [
      { content: "", tool_calls: [dupCall] },
      { content: "", tool_calls: [{ ...dupCall, id: "c2" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c3" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c4" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c5" }] },
      { content: "i would summarize but the harness should override me." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("explore")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    expect(
      events.some((e) => e.role === "warning" && /stuck retry loop/i.test(e.content ?? "")),
    ).toBe(true);

    const finals = events.filter((e) => e.role === "assistant_final");
    const summary = finals[finals.length - 1];
    expect(summary?.forcedSummary).toBe(true);
    expect(summary?.content).toMatch(/stuck on a repeated tool call/);
  });

  it("context-guard diverts to summary when promptTokens > 80% of the window, tagging forcedSummary", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    // First response: chaining tool call with a prompt-token count
    // deliberately over 80% of DeepSeek V4's 1M window (1M * 0.8 =
    // 800k). 900k trips the guard.
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 50,
          total_tokens: 900_050,
          prompt_cache_hit_tokens: 700_000,
          prompt_cache_miss_tokens: 200_000,
        },
      },
      // Forced-summary response (no tools)
      { content: "based on what I saw, X." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("analyze the repo")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    // A warning must fire about the context guard. Accept both the
    // auto-compact-saved-us variant and the nothing-to-compact variant
    // — the message format shifted in 0.4.11 when we added the
    // auto-compact attempt before forcing summary.
    const warn = events.find((e) => e.role === "warning");
    expect(warn).toBeDefined();
    expect(warn!.content).toMatch(/context [\d,]+\/[\d,]+/);

    // The final assistant_final must be tagged forcedSummary and carry the context-guard prefix.
    const finals = events.filter((e) => e.role === "assistant_final");
    const summary = finals[finals.length - 1];
    expect(summary!.forcedSummary).toBe(true);
    expect(summary!.content).toMatch(/context budget running low/);
  });

  it("context-guard force-summary runs inside the compaction card lifecycle (fold-equivalent events)", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 50,
          total_tokens: 900_050,
          prompt_cache_hit_tokens: 700_000,
          prompt_cache_miss_tokens: 200_000,
        },
      },
      // Forced-summary response (no tools).
      { content: "based on what I saw, X." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("analyze the repo")) events.push(ev);

    // The forced summary is a COMPACTION action — it must render the same
    // compaction_start → compaction_end card pair as a fold, not just a warning.
    const start = events.find((e) => e.role === "compaction_start");
    const end = events.find((e) => e.role === "compaction_end");
    expect(start).toMatchObject({
      compactionReason: "auto-context-pressure",
      compactionKind: "force-summary",
    });
    expect(end).toMatchObject({
      compactionKind: "force-summary",
      folded: true, // the force summary FULL-folds the log into the summary
      summaryChars: "based on what I saw, X.".length,
    });
    // The trim removed the trailing in-flight assistant-with-tool_calls, then
    // the whole history was replaced by the synthesized summary.
    expect(end!.beforeMessages).toBe(2);
    expect(end!.afterMessages).toBe(1);
    // A force-summary now swaps the log like a fold — the replacement snapshot
    // rides the end event for the kernel view.
    expect((end as { replacementMessages?: unknown }).replacementMessages).toBeDefined();
    // The forced summary message still lands as the annotated assistant final.
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals[finals.length - 1]!.forcedSummary).toBe(true);
  });

  it("force-cancels live tasks (onPreCompaction) BEFORE the compaction card opens", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 50,
          total_tokens: 900_050,
          prompt_cache_hit_tokens: 700_000,
          prompt_cache_miss_tokens: 200_000,
        },
      },
      { content: "based on what I saw, X." },
    ];
    const client = makeClient(responses);
    const order: string[] = [];
    const onPreCompaction = vi.fn(() => {
      order.push("cancel");
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
      onPreCompaction,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("analyze the repo")) {
      events.push(ev);
      if (ev.role === "compaction_start") order.push("compaction_start");
    }

    // The cancel hook fires exactly once, and strictly before the compaction
    // card opens (i.e. before the summary call runs).
    expect(onPreCompaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cancel", "compaction_start"]);
    // The force-summary still committed after the cancel.
    expect(events.find((e) => e.role === "compaction_end")).toMatchObject({ folded: true });
  });

  it("refuses new tool dispatch while a compaction is in flight", async () => {
    const reg = new ToolRegistry();
    let dispatched = 0;
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => {
        dispatched++;
        return "ok";
      },
    });
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "hi" }]),
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
    });
    const internals = loop as unknown as {
      _compacting: boolean;
      runOneToolCall: (
        call: { function?: { name?: string; arguments?: string } },
        signal: AbortSignal,
      ) => Promise<{ result: string }>;
    };
    internals._compacting = true;
    const res = await internals.runOneToolCall(
      { function: { name: "probe", arguments: "{}" } },
      new AbortController().signal,
    );
    expect(res.result).toContain("compaction in progress");
    expect(dispatched).toBe(0);
  });

  it("settles the compaction card and continues when an auto-fold throws", async () => {
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 1_000;
    const client = makeClient([{ content: "continued after compaction failure" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: FOLD_TEST_MODEL,
    });
    for (let i = 0; i < 6; i++) {
      loop.log.append({
        role: "user",
        content: `question ${i}: ${"context padding for compaction failure ".repeat(80)}`,
      });
      loop.log.append({
        role: "assistant",
        content: `answer ${i}: ${"more context padding for compaction failure ".repeat(8)}`,
      });
    }
    const internals = loop as unknown as {
      context: { fold: (...args: unknown[]) => Promise<never> };
    };
    vi.spyOn(internals.context, "fold").mockRejectedValue(new Error("tokenizer unavailable"));

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("continue")) events.push(ev);

    expect(events.map((ev) => ev.role)).toContain("compaction_start");
    expect(events.map((ev) => ev.role)).toContain("compaction_end");
    expect(events.find((ev) => ev.role === "compaction_end")).toMatchObject({
      folded: false,
      foldError: "compaction failed — tokenizer unavailable",
    });
    expect(events.find((ev) => ev.role === "assistant_final")).toBeUndefined();
    expect(events.find((ev) => ev.role === "error")?.errorDetail?.message).toContain(
      "forced-summary request exceeds the model context budget",
    );
  });

  it("refuses an over-limit request when turn-start compaction fails", async () => {
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 1_000;
    const client = makeClient([{ content: "provider must not be called" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: FOLD_TEST_MODEL,
    });
    for (let i = 0; i < 8; i++) {
      loop.log.append({
        role: "user",
        content: `oversized context ${i}: ${"context padding ".repeat(100)}`,
      });
    }
    const internals = loop as unknown as {
      context: { fold: (...args: unknown[]) => Promise<never> };
    };
    vi.spyOn(internals.context, "fold").mockRejectedValue(new Error("fold unavailable"));

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("continue")) events.push(ev);

    expect(events.find((ev) => ev.role === "compaction_end")).toMatchObject({
      folded: false,
      foldError: "compaction failed — fold unavailable",
    });
    expect(events.find((ev) => ev.role === "error")?.errorDetail?.message).toContain(
      "forced-summary request exceeds the model context budget",
    );
    expect(events.find((ev) => ev.role === "assistant_final")).toBeUndefined();
  });

  it("settles the compaction card when forced-summary recovery fails", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "c",
                      type: "function",
                      function: { name: "probe", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 900_000,
              completion_tokens: 50,
              total_tokens: 900_050,
              prompt_cache_hit_tokens: 700_000,
              prompt_cache_miss_tokens: 200_000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("summary provider unavailable", { status: 401 });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("analyze the repo")) events.push(ev);

    expect(calls).toBe(2);
    expect(events.some((ev) => ev.role === "error")).toBe(true);
    expect(events.find((ev) => ev.role === "compaction_end")).toMatchObject({
      compactionKind: "force-summary",
      folded: false,
      foldError: "forced summary failed",
    });
    expect(events[events.length - 1]?.role).toBe("compaction_end");
  });

  it("force-summary calls the active model, not a hard-coded one (third-party endpoint compat)", async () => {
    const seenModels: string[] = [];
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 10,
          total_tokens: 900_010,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 900_000,
        },
      },
      { content: "summary text" },
    ];
    let i = 0;
    const captureFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (typeof body.model === "string") seenModels.push(body.model);
      const resp = responses[i++] ?? responses[responses.length - 1]!;
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: resp.content ?? "",
                tool_calls: resp.tool_calls ?? undefined,
              },
              finish_reason: resp.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: resp.usage ?? {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 100,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const thirdPartyModel = "mimo-v2.5-pro";
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: captureFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
      model: thirdPartyModel,
    });

    for await (const _ of loop.step("analyze the repo")) {
      // drain
    }

    expect(seenModels.length).toBeGreaterThanOrEqual(2);
    expect(seenModels.every((m) => m === thirdPartyModel)).toBe(true);
  });

  it("compactHistory replaces head with summary, keeps tail within token budget", async () => {
    const responses: FakeResponseShape[] = [
      { content: "User explored auth and billing modules; landed on session refactor plan." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    // Seed 6 user/assistant pairs with chunky content so we can
    // reason about token weight; each pair ≈ 20 tokens.
    for (let i = 0; i < 6; i++) {
      loop.log.append({
        role: "user",
        content: `question number ${i} with some words to weigh it`,
      });
      loop.log.append({ role: "assistant", content: `answer number ${i} with similar bulk` });
    }
    expect(loop.log.length).toBe(12);

    // Budget of ~60 tokens fits ~3 trailing pairs.
    const result = await loop.compactHistory({ keepRecentTokens: 60 });
    expect(result.folded).toBe(true);
    expect(result.beforeMessages).toBe(12);
    expect(result.afterMessages).toBeLessThan(12);

    const entries = loop.log.entries;
    expect(entries[0]!.role).toBe("assistant");
    expect(entries[0]!.content as string).toMatch(/HISTORY SUMMARY/);
    expect(entries[1]!.role).toBe("user");
    expect(entries[entries.length - 1]!.content).toMatch(/answer number 5/);
  });

  it("compactHistory no-ops when head wouldn't shrink log meaningfully", async () => {
    const client = makeClient([{ content: "summary" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "q0" });
    loop.log.append({ role: "assistant", content: "a0" });
    loop.log.append({ role: "user", content: "q1" });
    loop.log.append({ role: "assistant", content: "a1" });

    // Budget large enough to cover everything → no fold needed.
    const result = await loop.compactHistory({ keepRecentTokens: 10_000 });
    expect(result.folded).toBe(false);
    expect(loop.log.length).toBe(4);
  });

  it("fold proceeds (does not noop) when the log is over the threshold even with a small head", async () => {
    // Regression: the min-savings noop fired whenever the head was < 30% of
    // the log — including when the ACTIVE exchange dominated and the total was
    // already past the 75% fold line. That let context climb to the 80% guard.
    // Above the threshold the fold must run even if the head is small.
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 1_000;
    const client = makeClient([{ content: "Earlier turns summarized." }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: FOLD_TEST_MODEL,
    });
    // Tiny head, huge active exchange (last user message near the top) → the
    // head alone would trip the min-savings noop, but the log is over 750/1000.
    const big =
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
        60,
      );
    loop.log.append({ role: "user", content: "q0" });
    loop.log.append({ role: "assistant", content: "a0" });
    loop.log.append({ role: "user", content: "q1" });
    loop.log.append({ role: "assistant", content: big });

    const result = await loop.compactHistory({
      keepRecentTokens: 100,
      protectActiveExchange: true,
    });
    expect(result.folded).toBe(true);
    expect(result.beforeMessages).toBe(4);
    expect(loop.log.length).toBeLessThan(4);
  });

  it("compactHistoryWithEvents yields the same card lifecycle as auto folds (user /compact path)", async () => {
    const responses: FakeResponseShape[] = [
      { content: "User explored auth and billing modules; landed on session refactor plan." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    for (let i = 0; i < 6; i++) {
      loop.log.append({
        role: "user",
        content: `question number ${i} with some words to weigh it`,
      });
      loop.log.append({ role: "assistant", content: `answer number ${i} with similar bulk` });
    }
    expect(loop.log.length).toBe(12);

    const events: LoopEvent[] = [];
    const gen = loop.compactHistoryWithEvents({ keepRecentTokens: 60 });
    for await (const ev of gen) events.push(ev);

    // Compaction card pair — same shape the auto folds yield, user-tagged.
    expect(events.map((e) => e.role)).toEqual(["compaction_start", "compaction_end"]);
    expect(events[0]).toMatchObject({
      compactionReason: "user",
      compactionKind: "fold",
    });
    const end = events[1];
    expect(end).toMatchObject({
      compactionKind: "fold",
      folded: true,
      beforeMessages: 12,
    });
    expect(end!.afterMessages).toBeLessThan(12);
    expect(end!.summaryChars).toBeGreaterThan(0);
    // The post-fold log snapshot rides the end event so the eventizer can emit
    // session.compacted — the kernel conversation view stays replayable.
    expect((end as { replacementMessages?: unknown[] }).replacementMessages).toBeDefined();
    expect(loop.log.length).toBe(end!.afterMessages);
  });

  it("auto-folds history when promptTokens crosses the normal fold threshold", async () => {
    // ctxMax sized so the seed log (~90K content tokens) stays under the
    // turn-start preflight's 75% threshold AND the fold tailBudget (20%) stays
    // smaller than the log so fold has a meaningful head to compact. The mocked
    // usage trips post-response auto-fold without preflight stealing the work.
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 200_000;
    const tripPrompt = Math.ceil(
      200_000 *
        (HISTORY_FOLD_THRESHOLD + (HISTORY_FOLD_AGGRESSIVE_THRESHOLD - HISTORY_FOLD_THRESHOLD) / 2),
    );
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: tripPrompt,
          completion_tokens: 10,
          total_tokens: tripPrompt + 10,
          prompt_cache_hit_tokens: Math.floor(tripPrompt * 0.8),
          prompt_cache_miss_tokens: Math.ceil(tripPrompt * 0.2),
        },
      },
      // Summary call response (compactHistory).
      { content: "Earlier turns explored topic X and decided Y." },
      // Iter 1 (after fold): wrap-up.
      { content: "done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
      model: FOLD_TEST_MODEL,
    });
    // Seed 18 user/assistant turns sized so the LOG estimate stays below both
    // preflight signals (95% of token ctx AND the byte ceiling) — otherwise
    // preflight folds first and the auto-fold path never runs. The mocked usage
    // of 600k below is what trips the auto-fold check.
    const fillLines = (label: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          `${label} line ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      ).join("\n");
    for (let i = 0; i < 18; i++) {
      loop.log.append({ role: "user", content: `Q${i}\n${fillLines(`q${i}`, 100)}` });
      loop.log.append({ role: "assistant", content: `A${i}\n${fillLines(`a${i}`, 100)}` });
    }
    const beforeMessages = loop.log.length;

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("continue")) {
      events.push(ev);
    }

    // The fold now renders as a card in the tool queue: compaction_start →
    // compaction_end (no more permanent warning divider).
    const foldStart = events.find((e) => e.role === "compaction_start");
    expect(foldStart).toBeDefined();
    const foldEnd = events.find((e) => e.role === "compaction_end");
    expect(foldEnd).toBeDefined();
    expect(foldEnd!.folded).toBe(true);
    // The fold counts the log at fold time, so beforeMessages includes the
    // tool exchange + wrap-up appended before the compaction card, and the
    // fold must have actually shrunk the log.
    expect(foldEnd!.beforeMessages).toBeGreaterThan(beforeMessages);
    expect(foldEnd!.afterMessages ?? 0).toBeLessThan(foldEnd!.beforeMessages ?? 0);
    // Dispatch-before-fold: the pending tool call completes BEFORE the
    // compaction card starts, so a read isn't blocked behind the summary window.
    const toolIdx = events.findIndex((e) => e.role === "tool" && e.toolName === "probe");
    const compactIdx = events.findIndex((e) => e.role === "compaction_start");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThan(toolIdx);
    expect(loop.log.length).toBeLessThan(beforeMessages);
  }, 30_000);

  it("uses the aggressive fold tier when promptTokens crosses the aggressive threshold", async () => {
    DEEPSEEK_CONTEXT_TOKENS[FOLD_TEST_MODEL] = 200_000;
    const tripPrompt = Math.ceil(
      200_000 * (HISTORY_FOLD_AGGRESSIVE_THRESHOLD + (0.8 - HISTORY_FOLD_AGGRESSIVE_THRESHOLD) / 2),
    );
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: tripPrompt,
          completion_tokens: 10,
          total_tokens: tripPrompt + 10,
          prompt_cache_hit_tokens: Math.floor(tripPrompt * 0.8),
          prompt_cache_miss_tokens: Math.ceil(tripPrompt * 0.2),
        },
      },
      // Summary call (compactHistory).
      { content: "Earlier turns covered topic X." },
      // Iter 1 wrap-up.
      { content: "done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
      model: FOLD_TEST_MODEL,
    });
    const fillLines = (label: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          `${label} line ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      ).join("\n");
    for (let i = 0; i < 18; i++) {
      loop.log.append({ role: "user", content: `Q${i}\n${fillLines(`q${i}`, 100)}` });
      loop.log.append({ role: "assistant", content: `A${i}\n${fillLines(`a${i}`, 100)}` });
    }

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("continue")) {
      events.push(ev);
    }

    // The compaction card advertises the aggressive tier on the start event so
    // users know why recent context got trimmed harder than usual.
    const foldStart = events.find((e) => e.role === "compaction_start");
    expect(foldStart).toBeDefined();
    expect(foldStart!.aggressive).toBe(true);
    const foldEnd = events.find((e) => e.role === "compaction_end");
    expect(foldEnd).toBeDefined();
    expect(foldEnd!.folded).toBe(true);
  }, 30_000);

  it("pre-clips new tool results at dispatch so they never enter the log oversized", async () => {
    const reg = new ToolRegistry();
    // Tool returns ~50k chars of realistic-shape log text; the default
    // token budget (8k) bounds the resulting log entry to a small
    // fraction of the raw size. (Using "A".repeat(N) would hit the
    // tokenizer's BPE O(n²) path for repeated single-char inputs —
    // pathological enough to slow the suite by tens of seconds, and
    // not representative of real tool output.)
    const huge = "ERROR: repeated failure with some detail\n".repeat(1250);
    reg.register({
      name: "big",
      description: "returns a lot",
      parameters: { type: "object", properties: {} },
      fn: async () => huge,
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "big", arguments: "{}" } }],
      },
      { content: "summarized." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
    });
    for await (const _ev of loop.step("go")) {
      /* drain */
    }
    const toolEntry = loop.log.toMessages().find((m) => m.role === "tool");
    expect(toolEntry).toBeDefined();
    const content = typeof toolEntry!.content === "string" ? toolEntry!.content : "";
    // Well under the raw 50k — pre-clip fired before append.
    expect(content.length).toBeLessThan(40_000);
    expect(content).toMatch(/truncated/);
  });

  it("shrinks retained tool-call args without starving the tool dispatch", async () => {
    const reg = new ToolRegistry();
    const hugeContent = Array.from({ length: 9000 }, (_, i) => `line ${i}: payload ${i}`).join(
      "\n",
    );
    let receivedChars = 0;
    reg.register<{ path: string; content: string }, string>({
      name: "write_blob",
      description: "captures a large write payload",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      fn: async (args) => {
        receivedChars = args.content.length;
        return `received ${receivedChars}`;
      },
    });
    const rawArgs = JSON.stringify({ path: "big.txt", content: hugeContent });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "write_blob", arguments: rawArgs } },
        ],
      },
      { content: "done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
    });

    for await (const _ev of loop.step("go")) {
      /* drain */
    }

    expect(receivedChars).toBe(hugeContent.length);
    const assistantEntry = loop.log
      .toMessages()
      .find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    expect(assistantEntry).toBeDefined();
    const savedArgs = assistantEntry!.tool_calls![0]!.function.arguments;
    expect(savedArgs.length).toBeLessThan(rawArgs.length / 10);
    const parsed = JSON.parse(savedArgs) as { path: string; content: string };
    expect(parsed.path).toBe("big.txt");
    expect(parsed.content).toMatch(/shrunk/);
  });

  it("buildMessages strips a dangling assistant-with-tool_calls tail — defensive against 'insufficient tool messages' 400", async () => {
    // Craft a log where the last entry is an assistant message with
    // tool_calls but no matching tool responses. This is the shape
    // that used to crash the forced-summary call with DeepSeek's
    // 'insufficient tool messages following tool_calls' error.
    const client = makeClient([{ content: "summary text" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "x", type: "function", function: { name: "noop", arguments: "{}" } }],
    });
    // A chat turn from here should succeed, not 400, because
    // buildMessages strips the unpaired tail.
    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("continue")) {
      events.push({ role: ev.role, content: ev.content });
    }
    expect(events.find((e) => e.role === "error")).toBeUndefined();
    // The fake fetch echoes the messages it received — no unpaired
    // assistant+tool_calls should be in there.
    expect(events.find((e) => e.role === "assistant_final")?.content).toContain("summary text");
  });

  it("surfaces an error event when the HTTP call fails with a non-retryable status", async () => {
    // 401 is non-retryable (bad key). Using this avoids multi-retry waits.
    const errFetch = vi.fn(async () => new Response("boom", { status: 401 }));
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: errFetch as unknown as typeof fetch,
      retry: { initialBackoffMs: 1, maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const roles: string[] = [];
    for await (const ev of loop.step("q")) {
      roles.push(ev.role);
    }
    expect(roles).toContain("error");
  });
});

describe("CacheFirstLoop - retryLastUser edge cases", () => {
  it("returns null when the only entry is not a user message", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "assistant", content: "answer" });
    const result = loop.retryLastUser();
    expect(result).toBeNull();
    // Log should be unchanged.
    expect(loop.log.length).toBe(1);
  });

  it("returns empty string when the last user message content is not a string", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    // Append a user message with array content (not a string).
    loop.log.append({ role: "user", content: ["not a string"] } as any);
    const result = loop.retryLastUser();
    // typeof raw === "string" → false, so userText = ""
    expect(result).toBe("");
    expect(loop.log.length).toBe(0); // messages after and including user were removed
  });

  it("preserves only messages before the LAST user, ignoring earlier users", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "q1" });
    loop.log.append({ role: "assistant", content: "a1" });
    loop.log.append({ role: "user", content: "q2" });
    loop.log.append({ role: "assistant", content: "a2" });
    loop.log.append({ role: "user", content: "q3" });
    loop.log.append({ role: "assistant", content: "a3" });

    const result = loop.retryLastUser();
    expect(result).toBe("q3");
    // Messages up to q2/a2 should be preserved (4 entries), q3 and a3 removed.
    expect(loop.log.length).toBe(4);
    expect(loop.log.entries[0]!.content).toBe("q1");
    expect(loop.log.entries[3]!.content).toBe("a2");
  });

  it("returns null from empty log even with session name set", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    const result = loop.retryLastUser();
    expect(result).toBeNull();
  });

  it("returns content with complex value but asynchronously stores to session", async () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "retry me" });
    loop.log.append({ role: "assistant", content: "answer" });

    const result = loop.retryLastUser();
    expect(result).toBe("retry me");
    // verify log was truncated to only messages before retry target
    expect(loop.log.length).toBe(0);
  });
});

describe("CacheFirstLoop - configure() method", () => {
  it("updates model via configure", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    expect(loop.model).toBe("deepseek-v4-flash");
    loop.configure({ model: "deepseek-v4-pro" });
    expect(loop.model).toBe("deepseek-v4-pro");
  });

  it("updates stream preference via configure", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: true,
    });
    expect(loop.stream).toBe(true);
    loop.configure({ stream: false });
    expect(loop._streamPreference).toBe(false);
    expect(loop.stream).toBe(false);
  });

  it("updates reasoningEffort via configure", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      reasoningEffort: "max",
    });
    loop.configure({ reasoningEffort: "high" });
    expect(loop.reasoningEffort).toBe("high");
  });
});

describe("CacheFirstLoop - setBudget / clearLog / retryLastUser", () => {
  it("setBudget(null) clears budget", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.setBudget(null);
    expect(loop.budgetUsd).toBeNull();
    // Re-arm of the 80%-warning latch is tested behaviorally in
    // "setBudget re-arms the 80% warning when the cap moves" below.
  });

  it("setBudget(0) clears budget to null (same as null)", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.setBudget(0);
    expect(loop.budgetUsd).toBeNull();
  });

  it("setBudget(positive) sets budget", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.setBudget(2.5);
    expect(loop.budgetUsd).toBe(2.5);
    // Re-arm of the 80%-warning latch is tested behaviorally in
    // "setBudget re-arms the 80% warning when the cap moves" below.
  });

  it("clearLog empties messages and resets scratch", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    // Seed log entries and scratch state.
    loop.log.append({ role: "user", content: "hello" });
    loop.log.append({ role: "assistant", content: "hi" });
    expect(loop.log.length).toBeGreaterThan(0);
    loop.scratch.notes = ["stale note"];
    loop.scratch.reasoning = "stale reasoning";
    loop.stats.record(1, "deepseek-chat", new Usage(1000, 100, 1100, 800, 200));
    expect(loop.stats.summary().totalCostUsd).toBeGreaterThan(0);

    const { dropped } = loop.clearLog();
    expect(dropped).toBe(2);
    expect(loop.log.length).toBe(0);
    expect(loop.scratch.notes).toEqual([]);
    expect(loop.scratch.reasoning).toBeNull();
    expect(loop.stats.summary().totalCostUsd).toBe(0);
    expect(loop.stats.summary().turns).toBe(0);
    expect(loop.currentTurn).toBe(0);
  });

  it("clearLog drains the steer queue so the next turn doesn't replay prior intent", async () => {
    const fetchSpy = vi.fn(
      async (_url: any, init: any) =>
        new Response(
          JSON.stringify({
            _echo_messages: JSON.parse(init.body).messages,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fetchSpy });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.steer("finish the refactor i started in the prior session");
    loop.clearLog();
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    const sent = JSON.parse((fetchSpy as any).mock.calls[0][1].body).messages as ChatMessage[];
    const userBodies = sent.filter((m) => m.role === "user").map((m) => m.content);
    expect(userBodies).toEqual(["hello"]);
  });

  it("clearLog returns 0 dropped when already empty", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    expect(loop.log.length).toBe(0);
    const { dropped } = loop.clearLog();
    expect(dropped).toBe(0);
  });

  it("clearLog rebuilds prefix.system when the rebuild closure returns a new string", () => {
    const client = makeClient([{ content: "ok" }]);
    let current = "system-v1";
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: current }),
      stream: false,
      rebuildSystem: () => current,
    });
    expect(loop.prefix.system).toBe("system-v1");
    const fp1 = loop.prefix.fingerprint;

    current = "system-v2";
    const { systemRebuilt } = loop.clearLog();
    expect(systemRebuilt).toBe(true);
    expect(loop.prefix.system).toBe("system-v2");
    expect(loop.prefix.fingerprint).not.toBe(fp1);
  });

  it("clearLog leaves prefix.system untouched when the rebuild closure returns the same string", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "stable" }),
      stream: false,
      rebuildSystem: () => "stable",
    });
    const fp1 = loop.prefix.fingerprint;
    const { systemRebuilt } = loop.clearLog();
    expect(systemRebuilt).toBe(false);
    expect(loop.prefix.system).toBe("stable");
    expect(loop.prefix.fingerprint).toBe(fp1);
  });

  it("clearLog swallows rebuild-closure exceptions and keeps the prior system", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "keep-me" }),
      stream: false,
      rebuildSystem: () => {
        throw new Error("disk on fire");
      },
    });
    const { systemRebuilt } = loop.clearLog();
    expect(systemRebuilt).toBe(false);
    expect(loop.prefix.system).toBe("keep-me");
  });

  it("switchWorkspace drops the log, repoints sessionName, and rebuilds system via the rebuilder closure", () => {
    const client = makeClient([{ content: "ok" }]);
    let currentSystem = "system-tmp-a";
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: currentSystem }),
      stream: false,
      session: "code-tmp-a",
      rebuildSystem: () => currentSystem,
    });
    loop.log.append({ role: "user", content: "from tmp-a" });
    loop.log.append({ role: "assistant", content: "ok" });
    loop.scratch.notes = ["stale"];
    expect(loop.sessionName).toBe("code-tmp-a");
    expect(loop.log.length).toBe(2);

    currentSystem = "system-tmp-b";
    const { dropped } = loop.switchWorkspace({ sessionName: "code-tmp-b" });
    expect(dropped).toBe(2);
    expect(loop.log.length).toBe(0);
    expect(loop.scratch.notes).toEqual([]);
    expect(loop.sessionName).toBe("code-tmp-b");
    expect(loop.prefix.system).toBe("system-tmp-b");
  });

  it("switchWorkspace is a noop on log content when there's nothing to drop", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: "code-old",
    });
    const { dropped } = loop.switchWorkspace({ sessionName: "code-new" });
    expect(dropped).toBe(0);
    expect(loop.sessionName).toBe("code-new");
  });

  it("switchWorkspace swallows rebuilder errors and keeps the prior system", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "keep-me" }),
      stream: false,
      session: "code-a",
      rebuildSystem: () => {
        throw new Error("rebuilder went sideways");
      },
    });
    loop.switchWorkspace({ sessionName: "code-b" });
    expect(loop.prefix.system).toBe("keep-me");
    expect(loop.sessionName).toBe("code-b");
  });

  it("retryLastUser returns null when no user message exists", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    const result = loop.retryLastUser();
    expect(result).toBeNull();
  });

  it("retryLastUser returns user text and removes messages after it", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "my question" });
    loop.log.append({ role: "assistant", content: "an answer" });
    loop.log.append({ role: "user", content: "follow up" });
    loop.log.append({ role: "assistant", content: "follow-up answer" });

    const result = loop.retryLastUser();
    expect(result).toBe("follow up");
    // Messages after the last user (including it) should be removed.
    expect(loop.log.length).toBe(2);
    expect(loop.log.entries[0]!.content).toBe("my question");
    expect(loop.log.entries[1]!.content).toBe("an answer");
  });
});

describe("CacheFirstLoop (streaming) — tool_call_delta emission", () => {
  it("yields tool_call_delta events carrying growing arg-char count", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      // Fake fetch that streams an SSE body with a multi-chunk tool call.
      fetch: (async (_url: any, _init: any) => {
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: {} }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "edit_file", arguments: '{"path":"a.txt","search":"' } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'old","replace":"new"}' } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const body = new ReadableStream({
          start(ctrl) {
            for (const f of frames) ctrl.enqueue(new TextEncoder().encode(f));
            ctrl.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    });

    const tools = new ToolRegistry();
    tools.register({
      name: "edit_file",
      parameters: { type: "object", properties: {}, required: [] },
      fn: () => "ok",
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: true,
      maxToolIters: 1,
    });

    const deltas: Array<{ name?: string; chars?: number }> = [];
    for await (const ev of loop.step("do it")) {
      if (ev.role === "tool_call_delta") {
        deltas.push({ name: ev.toolName, chars: ev.toolCallArgsChars });
      }
      if (ev.role === "tool_start") break;
    }

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]!.name).toBe("edit_file");
    expect(deltas[deltas.length - 1]!.chars).toBeGreaterThan(deltas[0]!.chars!);
  });

  it("yields reasoning before content when a chunk carries both fields", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: (async (_url: any, _init: any) => {
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "I" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "'m thinking", content: "Let" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: " me reply" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const body = new ReadableStream({
          start(ctrl) {
            for (const f of frames) ctrl.enqueue(new TextEncoder().encode(f));
            ctrl.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: true,
      maxToolIters: 1,
    });

    const channels: Array<"reasoning" | "content"> = [];
    for await (const ev of loop.step("hi")) {
      if (ev.role === "assistant_delta") {
        channels.push(ev.reasoningDelta ? "reasoning" : "content");
      }
      if (ev.role === "done") break;
    }

    expect(channels).toEqual(["reasoning", "reasoning", "content", "content"]);
  });

  it("does not emit a red error event when the API call is aborted mid-flight", async () => {
    // Reproduces the reported "error This operation was aborted" UX
    // bug: when App.tsx calls loop.abort() to switch to a queued
    // synthetic input (e.g. ShellConfirm "always allow"), the in-flight
    // fetch throws AbortError. We treat that as a clean early-exit
    // (yield `done`) instead of bubbling it up as a red error row.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      // Slow fake fetch — never resolves on its own; only the abort
      // signal terminates it.
      fetch: vi.fn(async (_url: any, init: any) => {
        const signal: AbortSignal | undefined = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        });
      }) as any,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const events: Array<{ role: string; error?: string }> = [];
    const stepPromise = (async () => {
      for await (const ev of loop.step("hi")) {
        events.push({ role: ev.role, error: ev.error });
      }
    })();
    // Race: fire abort before the fake fetch can resolve.
    setTimeout(() => loop.abort(), 10);
    await stepPromise;

    // No "error" event leaked through.
    expect(events.find((e) => e.role === "error")).toBeUndefined();
    // Loop terminated cleanly so the TUI's busy state unsticks.
    expect(events[events.length - 1]?.role).toBe("done");
  });

  it("blocks on confirmation gate without letting the model retry in the same turn", async () => {
    // An auto-approving gate so the tool doesn't block forever in tests.
    // In production, the singleton gate shows the ShellConfirm modal.
    const gate = new PauseGate();
    // Override ask to auto-approve without blocking.
    const origAsk = gate.ask.bind(gate);
    void origAsk;
    gate.ask = (_opts: { kind: string; payload?: unknown }) => {
      return Promise.resolve<ConfirmationChoice>({ type: "run_once" });
    };

    // A tool that uses the confirmation gate (like run_command does)
    const reg = new ToolRegistry();
    reg.register({
      name: "run_command",
      description: "run a command — needs confirmation",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      fn: async (_args: { command: string }, ctx) => {
        // Simulate what shell.ts does: block on the gate
        const realGate = ctx?.confirmationGate ?? gate;
        const choice = await (realGate.ask({
          kind: "run_command",
          payload: { command: "echo ok" },
        }) as Promise<ConfirmationChoice>);
        if (choice.type === "deny") {
          throw new Error("user denied: echo ok");
        }
        return "$ echo ok\n[exit 0]\nok";
      },
    });

    // Response 1: model emits a run_command tool call
    const toolCallResp: FakeResponseShape = {
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "run_command",
            arguments: '{"command":"echo ok"}',
          },
        },
      ],
    };
    // Response 2: model sees the tool output and responds naturally
    const followUpResp: FakeResponseShape = {
      content: "Command ran successfully — output was 'ok'.",
      tool_calls: [],
    };

    const responses: FakeResponseShape[] = [toolCallResp, followUpResp];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(responses) as unknown as typeof fetch,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      confirmationGate: gate,
    });

    const events: Array<{ role: string; content?: string }> = [];
    for await (const ev of loop.step("run something")) {
      events.push({ role: ev.role, content: ev.content });
    }

    // The tool result should be the normal command output — not a
    // NeedsConfirmationError string
    const toolEvents = events.filter((e) => e.role === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.content).toContain("ok");
    expect(toolEvents[0]?.content).not.toContain("NeedsConfirmationError");
    expect(toolEvents[0]?.content).not.toContain("user denied");

    // Two model calls: first generates the tool call, second responds to the
    // output. The gate made the tool return real output synchronously — no
    // error, no NeedsConfirmationError, no synthetic retry.
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(2);
    // Second call should be the natural follow-up, not a workaround
    expect(finals[1]?.content).toMatch(/ran successfully/);

    // Turn ends cleanly
    expect(events[events.length - 1]?.role).toBe("done");
  });

  describe("session USD budget", () => {
    // The gate runs purely against `loop.stats.totalCost`, which sums
    // the public `turns` array. Tests inject synthetic turns directly
    // instead of pumping fake API responses sized to land in the
    // narrow 80%-100% window — keeps each case focused on the
    // gate's behavior without coupling to v4-flash token pricing.
    function injectCost(loop: CacheFirstLoop, costUsd: number): void {
      // SessionStats.turns is `readonly` at the type level (you can't
      // reassign the field), but the array itself is mutable — the
      // public API normally appends via recordTurn(). For tests we
      // bypass that path; the only fields the gate reads are summed
      // via `t.cost`, so the rest is filler.
      (loop.stats.turns as unknown as Array<{ cost: number; model: string; usage: unknown }>).push({
        cost: costUsd,
        model: loop.model,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          cacheHitRatio: 0,
        },
      });
    }

    it("default behavior: budgetUsd undefined → no checks, no events", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        // no budgetUsd
      });
      expect(loop.budgetUsd).toBeNull();
      injectCost(loop, 9999); // even huge fake spend doesn't matter
      const roles: string[] = [];
      for await (const ev of loop.step("q")) roles.push(ev.role);
      expect(roles).not.toContain("error");
      expect(roles.filter((r) => r === "warning")).toHaveLength(0);
    });

    it("warns once when cumulative cost crosses 80% of the cap", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85); // 85% of cap

      const roles: string[] = [];
      const warnings: string[] = [];
      for await (const ev of loop.step("a")) {
        roles.push(ev.role);
        if (ev.role === "warning") warnings.push(ev.content);
      }
      expect(warnings.filter((w) => /budget 80% used/.test(w))).toHaveLength(1);
      expect(roles).toContain("assistant_final");
    });

    it("does not repeat the 80% warning on subsequent turns", async () => {
      const client = makeClient([{ content: "ok" }, { content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85);
      // Turn 1 fires warn.
      let turn1Warns = 0;
      for await (const ev of loop.step("a")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn1Warns++;
      }
      // Turn 2 starts at the same 0.85 spent (real turn cost is tiny
      // with our fake fetch's default 100/20 token usage) — gate still
      // sees >80% but the 80%-warning latch is sticky, so no repeat.
      let turn2Warns = 0;
      for await (const ev of loop.step("b")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn2Warns++;
      }
      expect(turn1Warns).toBe(1);
      expect(turn2Warns).toBe(0);
    });

    it("refuses the next turn once cumulative cost ≥ cap", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 1.5);

      const events: { role: string; error?: string }[] = [];
      for await (const ev of loop.step("a")) {
        events.push({ role: ev.role, error: ev.error });
      }
      expect(events).toHaveLength(1);
      expect(events[0]?.role).toBe("error");
      expect(events[0]?.error).toMatch(/budget exhausted/);
      // Gate runs before any state mutation: only the injected fake
      // turn remains, no real model call recorded.
      expect(loop.stats.turns).toHaveLength(1);
    });

    it("setBudget(null) clears the cap and unblocks subsequent turns", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 1.5);
      // Sanity check: the cap is currently exhausted.
      let firstAttempt: string | null = null;
      for await (const ev of loop.step("a")) {
        if (ev.role === "error") firstAttempt = ev.error ?? "";
        break;
      }
      expect(firstAttempt).toMatch(/budget exhausted/);
      // Clear the cap and try again.
      loop.setBudget(null);
      const roles: string[] = [];
      for await (const ev of loop.step("a")) roles.push(ev.role);
      expect(roles).not.toContain("error");
      expect(roles).toContain("assistant_final");
    });

    it("setBudget re-arms the 80% warning when the cap moves", async () => {
      const client = makeClient([{ content: "ok" }, { content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85); // 85% of $1
      // Turn 1: warn fires (sticky after this).
      let turn1Warns = 0;
      for await (const ev of loop.step("a")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn1Warns++;
      }
      expect(turn1Warns).toBe(1);
      // Lower the cap further so spent (0.85) is even further past
      // the new 80% mark. setBudget must reset the sticky flag so
      // the user sees a fresh warning at the new threshold.
      loop.setBudget(0.95);
      let turn2Warns = 0;
      for await (const ev of loop.step("b")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn2Warns++;
      }
      expect(turn2Warns).toBe(1);
    });
  });

  describe("parallel tool dispatch", () => {
    function makeMultiToolResponse(calls: Array<{ name: string; args: string }>) {
      return {
        content: "",
        tool_calls: calls.map((c, i) => ({
          id: `call_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      };
    }

    it("runs consecutive parallelSafe calls concurrently", async () => {
      const client = makeClient([
        makeMultiToolResponse([
          { name: "slow_read", args: '{"k":1}' },
          { name: "slow_read", args: '{"k":2}' },
          { name: "slow_read", args: '{"k":3}' },
        ]),
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      tools.register({
        name: "slow_read",
        parallelSafe: true,
        fn: async (args: { k: number }) => {
          await new Promise((r) => setTimeout(r, 80));
          return String(args.k);
        },
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        stream: false,
      });

      const t0 = Date.now();
      for await (const _ of loop.step("go")) {
        // drain
      }
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(220);
    });

    it("unsafe call splits the chunk into serial barriers", async () => {
      const client = makeClient([
        makeMultiToolResponse([
          { name: "slow_read", args: '{"k":1}' },
          { name: "slow_write", args: '{"k":2}' },
          { name: "slow_read", args: '{"k":3}' },
        ]),
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      tools.register({
        name: "slow_read",
        parallelSafe: true,
        fn: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return "r";
        },
      });
      tools.register({
        name: "slow_write",
        fn: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return "w";
        },
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        stream: false,
      });

      const t0 = Date.now();
      for await (const _ of loop.step("go")) {
        // drain
      }
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeGreaterThan(220);
    });

    it("tool yields land in declared order even when later calls finish first", async () => {
      const client = makeClient([
        makeMultiToolResponse([
          { name: "delayed", args: '{"id":"a","ms":120}' },
          { name: "delayed", args: '{"id":"b","ms":20}' },
          { name: "delayed", args: '{"id":"c","ms":60}' },
        ]),
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      tools.register({
        name: "delayed",
        parallelSafe: true,
        fn: async (args: { id: string; ms: number }) => {
          await new Promise((r) => setTimeout(r, args.ms));
          return args.id;
        },
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        stream: false,
      });

      const order: string[] = [];
      for await (const ev of loop.step("go")) {
        if (ev.role === "tool") order.push(ev.content);
      }
      expect(order).toEqual(["a", "b", "c"]);
    });

    it("REASONIX_TOOL_DISPATCH=serial forces serial dispatch", async () => {
      const prev = process.env.REASONIX_TOOL_DISPATCH;
      process.env.REASONIX_TOOL_DISPATCH = "serial";
      try {
        const client = makeClient([
          makeMultiToolResponse([
            { name: "slow_read", args: '{"k":1}' },
            { name: "slow_read", args: '{"k":2}' },
          ]),
          { content: "ok" },
        ]);
        const tools = new ToolRegistry();
        tools.register({
          name: "slow_read",
          parallelSafe: true,
          fn: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return "x";
          },
        });
        const loop = new CacheFirstLoop({
          client,
          prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
          tools,
          stream: false,
        });

        const t0 = Date.now();
        for await (const _ of loop.step("go")) {
          // drain
        }
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeGreaterThan(150);
      } finally {
        if (prev === undefined) {
          // biome-ignore lint/performance/noDelete: env restore must remove the key, not stringify "undefined"
          delete process.env.REASONIX_TOOL_DISPATCH;
        } else process.env.REASONIX_TOOL_DISPATCH = prev;
      }
    });

    it("REASONIX_PARALLEL_MAX caps the chunk size", async () => {
      const prev = process.env.REASONIX_PARALLEL_MAX;
      process.env.REASONIX_PARALLEL_MAX = "2";
      try {
        const client = makeClient([
          makeMultiToolResponse([
            { name: "slow_read", args: '{"k":1}' },
            { name: "slow_read", args: '{"k":2}' },
            { name: "slow_read", args: '{"k":3}' },
            { name: "slow_read", args: '{"k":4}' },
          ]),
          { content: "ok" },
        ]);
        const tools = new ToolRegistry();
        tools.register({
          name: "slow_read",
          parallelSafe: true,
          fn: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return "x";
          },
        });
        const loop = new CacheFirstLoop({
          client,
          prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
          tools,
          stream: false,
        });

        const t0 = Date.now();
        for await (const _ of loop.step("go")) {
          // drain
        }
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeGreaterThan(150);
        expect(elapsed).toBeLessThan(280);
      } finally {
        if (prev === undefined) {
          // biome-ignore lint/performance/noDelete: env restore must remove the key, not stringify "undefined"
          delete process.env.REASONIX_PARALLEL_MAX;
        } else process.env.REASONIX_PARALLEL_MAX = prev;
      }
    });

    it("gpt-* models dispatch tool calls serially by default — each call finishes before the next starts", async () => {
      const client = makeClient([
        makeMultiToolResponse([
          { name: "slow_read", args: '{"k":1}' },
          { name: "slow_read", args: '{"k":2}' },
          { name: "slow_read", args: '{"k":3}' },
        ]),
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      tools.register({
        name: "slow_read",
        parallelSafe: true,
        fn: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return "x";
        },
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "gpt-4o",
        stream: false,
      });

      const t0 = Date.now();
      for await (const _ of loop.step("go")) {
        // drain
      }
      const elapsed = Date.now() - t0;

      // Serial: 3 × 80ms back-to-back (≈240ms). The parallel path (<220ms)
      // would let all three run concurrently — gpt-* must not do that.
      expect(elapsed).toBeGreaterThan(220);
    });

    it("REASONIX_TOOL_DISPATCH=parallel restores parallel dispatch for gpt models", async () => {
      const prev = process.env.REASONIX_TOOL_DISPATCH;
      process.env.REASONIX_TOOL_DISPATCH = "parallel";
      try {
        const client = makeClient([
          makeMultiToolResponse([
            { name: "slow_read", args: '{"k":1}' },
            { name: "slow_read", args: '{"k":2}' },
            { name: "slow_read", args: '{"k":3}' },
          ]),
          { content: "ok" },
        ]);
        const tools = new ToolRegistry();
        tools.register({
          name: "slow_read",
          parallelSafe: true,
          fn: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return "x";
          },
        });
        const loop = new CacheFirstLoop({
          client,
          prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
          tools,
          model: "gpt-4o",
          stream: false,
        });

        const t0 = Date.now();
        for await (const _ of loop.step("go")) {
          // drain
        }
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeLessThan(220);
      } finally {
        if (prev === undefined) {
          // biome-ignore lint/performance/noDelete: env restore must remove the key, not stringify "undefined"
          delete process.env.REASONIX_TOOL_DISPATCH;
        } else process.env.REASONIX_TOOL_DISPATCH = prev;
      }
    });

    it("never starts the next thinking round until every dispatched tool call has settled", async () => {
      const client = makeClient([
        makeMultiToolResponse([
          { name: "slow_read", args: '{"k":1}' },
          { name: "slow_read", args: '{"k":2}' },
        ]),
        { content: "ok" },
      ]);
      const tools = new ToolRegistry();
      tools.register({
        name: "slow_read",
        parallelSafe: true,
        fn: async () => {
          await new Promise((r) => setTimeout(r, 60));
          return "x";
        },
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "gpt-4o",
        stream: false,
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("go")) events.push(ev);

      // Second call only starts after the first one completed (serial order),
      // and the answer ("thinking round") only arrives after ALL tool results.
      const starts = events
        .map((e, i) => [i, e] as const)
        .filter(([, e]) => e.role === "tool_start");
      const results = events.map((e, i) => [i, e] as const).filter(([, e]) => e.role === "tool");
      expect(starts.length).toBe(2);
      expect(results.length).toBe(2);
      expect(starts[1]![0]).toBeGreaterThan(results[0]![0]);
      const answerIdx = events.findIndex((e) => e.role === "assistant_final" && e.content === "ok");
      expect(answerIdx).toBeGreaterThan(results[1]![0]);
    });
  });
});

describe("CacheFirstLoop — mid-turn steer injection", () => {
  it("steer() stores text and steerConsumed returns false before consumption", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    expect(loop.steerConsumed).toBe(false);
    loop.steer("mid-turn msg");
    expect(loop.steerConsumed).toBe(false); // not consumed until step()
  });

  it("steer(null) clears a pending steer", () => {
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    loop.steer("mid-turn msg");
    loop.steer(null);
    // steer(null) should clear — step() won't see it
    expect(loop.steerConsumed).toBe(false);
  });

  it("consumes a mid-turn steer between iterations and yields a steer event", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":2,"b":3}' },
          },
        ],
      },
      { content: "The answer is 5." },
    ]);

    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({
        system: "use add tool",
        toolSpecs: tools.specs(),
      }),
      tools,
      stream: false,
    });

    // Start step() — manually iterate to inject steer mid-turn.
    const gen = loop.step("2 + 3 = ?");

    // Drain events until the tool result is yielded ("tool" role).
    let sawTool = false;
    let result = await gen.next();
    while (!result.done) {
      if (result.value.role === "tool") {
        sawTool = true;
        break;
      }
      result = await gen.next();
    }
    expect(sawTool).toBe(true);

    // Inject steer BEFORE the next iteration starts.
    loop.steer("mid-turn steer message");

    // Continue — the next iteration should consume the steer.
    let sawSteer = false;
    result = await gen.next();
    while (!result.done) {
      if (result.value.role === "steer") {
        sawSteer = true;
        expect(result.value.content).toBe("mid-turn steer message");
        break;
      }
      result = await gen.next();
    }
    expect(sawSteer).toBe(true);

    // Drain remaining events to completion.
    while (!result.done) {
      result = await gen.next();
    }

    // steerConsumed should be true after consumption.
    expect(loop.steerConsumed).toBe(true);

    // The steer should appear as a user message in the log, wrapped so it
    // remains guidance for the current task rather than a new top-level task.
    const userMessages = loop.log.entries.filter((m) => m.role === "user");
    expect(
      userMessages.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("Mid-turn steer queued by the user") &&
          m.content.includes("mid-turn steer message"),
      ),
    ).toBe(true);
  });

  it("queues multiple mid-turn steers and consumes one per iteration", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":1}' },
          },
        ],
      },
      {
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "add", arguments: '{"a":2,"b":2}' },
          },
        ],
      },
      { content: "done" },
    ]);

    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "use add", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    const gen = loop.step("turn");
    let r = await gen.next();
    while (!r.done && r.value.role !== "tool") r = await gen.next();

    loop.steer("first steer");
    loop.steer("second steer");

    const seen: string[] = [];
    while (!r.done) {
      r = await gen.next();
      if (!r.done && r.value.role === "steer") seen.push(r.value.content);
    }

    expect(seen).toEqual(["first steer", "second steer"]);
    const persisted = loop.log.entries
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .filter((c): c is string => typeof c === "string");
    expect(persisted.some((c) => c.includes("first steer"))).toBe(true);
    expect(persisted.some((c) => c.includes("second steer"))).toBe(true);
  });

  it("steerConsumed resets to false at the start of each new step()", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":1}' },
          },
        ],
      },
      { content: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "use add", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    // First turn: inject steer.
    const gen1 = loop.step("turn 1");
    // Drain to tool event.
    let r = await gen1.next();
    while (!r.done && r.value.role !== "tool") r = await gen1.next();
    loop.steer("steer in turn 1");
    // Drain rest.
    while (!r.done) r = await gen1.next();
    expect(loop.steerConsumed).toBe(true);

    // Second turn: steerConsumed should be false again.
    // But the fake client was exhausted. Use a fresh loop instead.
    const client2 = makeClient([{ content: "turn 2 answer" }]);
    const loop2 = new CacheFirstLoop({
      client: client2,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });
    expect(loop2.steerConsumed).toBe(false);
    loop2.steer("steer in turn 2");
    const gen2 = loop2.step("turn 2 input");
    let sawSteer2 = false;
    r = await gen2.next();
    while (!r.done) {
      if (r.value.role === "steer") {
        sawSteer2 = true;
        break;
      }
      r = await gen2.next();
    }
    expect(sawSteer2).toBe(true);
    expect(loop2.steerConsumed).toBe(true);
  });

  it("steer() resets steerConsumed when new text is set after a previous steer was consumed", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_reset",
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":1}' },
          },
        ],
      },
      { content: "done" },
    ]);

    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "use add", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    // First turn: inject steer, consume it via step(), verify steerConsumed is true.
    const gen = loop.step("turn 1");
    // Drain to tool event.
    let r = await gen.next();
    while (!r.done && r.value.role !== "tool") r = await gen.next();
    loop.steer("first steer");
    // Drain past steer consumption.
    r = await gen.next();
    while (!r.done && r.value.role !== "steer") r = await gen.next();
    // Finish the turn.
    while (!r.done) r = await gen.next();
    expect(loop.steerConsumed).toBe(true);

    // Second steer should reset steerConsumed to false.
    loop.steer("second steer");
    expect(loop.steerConsumed).toBe(false);
  });

  it("retries a transient stream body failure before any visible output", async () => {
    let calls = 0;
    const fetch = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
      calls++;
      const body = init?.body ? (JSON.parse(init.body) as { stream?: boolean }) : {};
      if (calls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" }));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      expect(body.stream).toBe(true);
      const bytes = new TextEncoder().encode(
        [
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 1 } });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(calls).toBe(2);
    expect(events.filter((ev) => ev.role === "warning").map((ev) => ev.content)).toContain(
      "The model provider returned an error before producing a visible response — retrying automatically.",
    );
    expect(events.some((ev) => ev.role === "error")).toBe(false);
    expect(events.find((ev) => ev.role === "assistant_final")?.content).toBe("recovered");
  });

  it("automatically retries an OpenAI response.failed event before visible output", async () => {
    const transport: ResolvedTransport = {
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers: { Authorization: "Bearer oauth", "ChatGPT-Account-Id": "acct-1" },
      api: "responses",
    };
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      const events =
        calls === 1
          ? ['data: {"type":"response.failed","message":"response failed"}\n\n']
          : [
              'data: {"type":"response.output_text.delta","delta":"recovered"}\n\n',
              'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
            ];
      const bytes = new TextEncoder().encode(events.join(""));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://api.openai.com/v1",
      fetch,
      transportResolver: async () => transport,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
      model: "gpt-5.6-sol",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(calls).toBe(2);
    expect(events.some((ev) => ev.role === "error")).toBe(false);
    expect(events.find((ev) => ev.role === "assistant_final")?.content).toBe("recovered");
  });

  it("does not replay an OpenAI response.failed event after visible output", async () => {
    const transport: ResolvedTransport = {
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers: { Authorization: "Bearer oauth", "ChatGPT-Account-Id": "acct-1" },
      api: "responses",
    };
    const fetch = vi.fn(async () => {
      const bytes = new TextEncoder().encode(
        [
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'data: {"type":"response.failed","message":"response failed"}\n\n',
        ].join(""),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      baseUrl: "https://api.openai.com/v1",
      fetch,
      transportResolver: async () => transport,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
      model: "gpt-5.6-sol",
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.some((ev) => ev.role === "error")).toBe(true);
  });

  it("retries a terminated stream after reasoning-only deltas", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const bytes = new TextEncoder().encode(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        );
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.error(Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" }));
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      const bytes = new TextEncoder().encode(
        [
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 1 } });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(events.filter((ev) => ev.role === "warning").map((ev) => ev.content)).toContain(
      "The model provider returned an error before producing a visible response — retrying automatically.",
    );
    expect(events.some((ev) => ev.role === "error")).toBe(false);
    expect(events.find((ev) => ev.role === "assistant_final")?.content).toBe("recovered");
  });

  it("does not retry a stream body failure after visible output", async () => {
    const fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
          );
          setTimeout(
            () =>
              controller.error(
                Object.assign(new Error("socket dropped"), { code: "UND_ERR_SOCKET" }),
              ),
            10,
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 1 } });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.some((ev) => ev.role === "error")).toBe(true);
    expect(events.some((ev) => ev.role === "assistant_final")).toBe(false);
  });

  it("retries a local request timeout once, then surfaces the repeated failure", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const reqSignal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          if (!reqSignal) return;
          if (reqSignal.aborted) {
            controller.error(reqSignal.reason);
            return;
          }
          reqSignal.addEventListener(
            "abort",
            () => {
              try {
                controller.error(reqSignal.reason);
              } catch {
                /* controller already closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      timeoutMs: 20,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: true,
    });

    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hello")) events.push(ev);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter((ev) => ev.role === "warning")).toHaveLength(1);
    expect(events.find((ev) => ev.role === "error")).toMatchObject({
      errorDetail: {
        phase: "stream_body_read",
        retryable: false,
      },
    });
  });

  it("surfaces structured errorDetail when the API call fails", async () => {
    const err = Object.assign(new Error("SSE body read failed: terminated"), {
      phase: "stream_body_read",
      code: "UND_ERR_ABORTED",
    });
    const fetch = vi.fn(async () => {
      throw err;
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });

    const events: any[] = [];
    for await (const ev of loop.step("hello")) {
      events.push(ev);
    }

    const errorEv = events.find((e) => e.role === "error");
    expect(errorEv).toBeDefined();
    expect(errorEv!.error).toContain("terminated");
    expect(errorEv!.errorDetail).toMatchObject({
      name: "Error",
      message: expect.stringContaining("terminated"),
      phase: "stream_body_read",
      code: "UND_ERR_ABORTED",
      retryable: false,
      recoverable: false,
    });
  });
});
