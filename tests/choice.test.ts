/** ask_choice — schema, sanitization, ChoiceRequestedError → tool_result protocol. */

import { describe, expect, it } from "vitest";
import { PauseGate } from "../src/core/pause-gate.js";
import { ToolRegistry } from "../src/tools.js";
import { ChoiceRequestedError, registerChoiceTool } from "../src/tools/choice.js";

class AutoGate extends PauseGate {
  private _choice: { type: string; optionId?: string; text?: string };
  lastPayload: unknown;
  constructor(choice: { type: string; optionId?: string; text?: string }) {
    super();
    this._choice = choice;
  }
  override ask(_opts: { kind: string; payload?: unknown }): Promise<any> {
    this.lastPayload = _opts.payload;
    return Promise.resolve(this._choice);
  }
}

describe("ChoiceRequestedError", () => {
  it("carries the question / options / allowCustom on the instance and in toToolResult()", () => {
    const err = new ChoiceRequestedError(
      "Which framework?",
      [
        { id: "A", title: "Vitest" },
        { id: "B", title: "Jest", summary: "familiar to most" },
      ],
      true,
    );
    expect(err.name).toBe("ChoiceRequestedError");
    expect(err.question).toBe("Which framework?");
    expect(err.options).toHaveLength(2);
    expect(err.allowCustom).toBe(true);
    const payload = err.toToolResult();
    expect(payload.question).toBe("Which framework?");
    expect(payload.options).toEqual([
      { id: "A", title: "Vitest" },
      { id: "B", title: "Jest", summary: "familiar to most" },
    ]);
    expect(payload.allowCustom).toBe(true);
    expect(payload.error).toMatch(/^ChoiceRequestedError:/);
    // STOP instruction — same pattern as PlanProposedError so flash
    // doesn't race past the picker with more tool calls.
    expect(payload.error).toMatch(/STOP/);
  });
});

describe("registerChoiceTool + ask_choice", () => {
  it("registers ask_choice as readOnly (safe during plan mode too)", () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    expect(reg.has("ask_choice")).toBe(true);
    expect(reg.get("ask_choice")?.readOnly).toBe(true);
  });

  it("blocks on PauseGate and returns the user's pick", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ question: string; options: unknown }> = [];
    registerChoiceTool(reg, {
      onChoiceRequested: (q, o) => seen.push({ question: q, options: o }),
    });
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick a route.",
        options: [
          { id: "A", title: "Deepen demo" },
          { id: "B", title: "Start UE5", summary: "fresh engine" },
        ],
        allowCustom: true,
      }),
      { confirmationGate: gate },
    );
    expect(out).toBe("user picked: A");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Pick a route.");
  });

  it("defaults allowCustom to true so free-text input is always available", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Which one?",
        options: [
          { id: "A", title: "one" },
          { id: "B", title: "two" },
        ],
      }),
      { confirmationGate: gate },
    );
    // Tool works without error — custom input is on by default
    expect(out).toBe("user picked: A");
    expect((gate.lastPayload as { allowCustom?: boolean }).allowCustom).toBe(true);
  });

  it("allowCustom: false explicitly hides the custom input", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Which one?",
        options: [
          { id: "A", title: "one" },
          { id: "B", title: "two" },
        ],
        allowCustom: false,
      }),
      { confirmationGate: gate },
    );
    expect(out).toBe("user picked: A");
    expect((gate.lastPayload as { allowCustom?: boolean }).allowCustom).toBe(false);
  });

  it("drops malformed option entries (DeepSeek sometimes misses fields)", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ options: { id: string; title: string }[] }> = [];
    registerChoiceTool(reg, {
      onChoiceRequested: (_q, opts) => seen.push({ options: opts as any }),
    });
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [
          { id: "A", title: "good" },
          { id: "", title: "no id" },
          { id: "B", title: "" },
          "not-an-object",
          null,
          { id: "C", title: "also good" },
        ],
      }),
      { confirmationGate: gate },
    );
    expect(seen[0]?.options).toEqual([
      { id: "A", title: "good" },
      { id: "C", title: "also good" },
    ]);
  });

  it("deduplicates options with the same id (first one wins)", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ question: string; options: unknown }> = [];
    registerChoiceTool(reg, {
      onChoiceRequested: (q, o) => seen.push({ question: q, options: o }),
    });
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [
          { id: "A", title: "first" },
          { id: "A", title: "dup" },
          { id: "B", title: "second" },
        ],
      }),
      { confirmationGate: gate },
    );
    expect(seen[0]?.options).toEqual([
      { id: "A", title: "first" },
      { id: "B", title: "second" },
    ]);
  });

  it("rejects an empty question", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "  ",
        options: [
          { id: "A", title: "one" },
          { id: "B", title: "two" },
        ],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/question is required/);
  });

  it("rejects when fewer than 2 well-formed options remain", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [{ id: "A", title: "only one" }],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/at least 2 well-formed options/);
  });

  it("rejects runaway option lists (>6 entries)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const options = Array.from({ length: 7 }, (_, i) => ({
      id: `opt-${i}`,
      title: `option ${i}`,
    }));
    const out = await reg.dispatch("ask_choice", JSON.stringify({ question: "too many", options }));
    expect(JSON.parse(out).error).toMatch(/too many options/);
  });

  it("keeps the tool passable in plan mode (branching questions can fire mid-plan)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    reg.setPlanMode(true);
    const gate = new AutoGate({ type: "pick", optionId: "A" });
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Which branch?",
        options: [
          { id: "A", title: "a" },
          { id: "B", title: "b" },
        ],
      }),
      { confirmationGate: gate },
    );
    expect(out).toBe("user picked: A");
  });

  it("marks ask_choice with userIntervention: true and tracks pending in PauseGate", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    expect(reg.isUserIntervention("ask_choice")).toBe(true);

    const gate = new PauseGate();
    gate.on(() => {
      // listener registered so ask does not throw
    });
    expect(gate.hasPending()).toBe(false);
    const promise = gate.ask({
      kind: "choice",
      payload: {
        question: "Wait?",
        options: [{ id: "1", title: "one" }],
        allowCustom: true,
      },
    });
    expect(gate.hasPending()).toBe(true);
    gate.resolve(0, { type: "pick", optionId: "1" });
    const verdict = await promise;
    expect(verdict.type).toBe("pick");
    expect(gate.hasPending()).toBe(false);
  });
});
