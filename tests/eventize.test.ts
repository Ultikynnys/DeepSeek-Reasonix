import { describe, expect, it } from "vitest";
import { Eventizer } from "../src/core/eventize.js";
import type { LoopEvent } from "../src/loop.js";

const ctx = { model: "deepseek-v4-flash", prefixHash: "abc123", reasoningEffort: "max" } as const;

const lev = (partial: Partial<LoopEvent>): LoopEvent =>
  ({ turn: 1, role: "status", content: "", ...partial }) as LoopEvent;

describe("Eventizer.consume", () => {
  it("synthesizes model.turn.started on first event of a new turn", () => {
    const e = new Eventizer();
    const out = e.consume(lev({ turn: 1, role: "status", content: "thinking" }), ctx);
    expect(out[0]?.type).toBe("model.turn.started");
    expect(out[1]?.type).toBe("status");
  });

  it("does not re-emit turn.started for events within the same turn", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
    const out = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
    expect(out.find((ev) => ev.type === "model.turn.started")).toBeUndefined();
  });

  it("emits a fresh turn.started when the turn number advances", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(lev({ turn: 2, role: "status", content: "go" }), ctx);
    expect(out[0]?.type).toBe("model.turn.started");
  });

  it("splits assistant_delta into content + reasoning channels", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const out = e.consume(
      lev({
        turn: 1,
        role: "assistant_delta",
        content: "hello",
        reasoningDelta: "thinking…",
      }),
      ctx,
    );
    const channels = out
      .filter((ev) => ev.type === "model.delta")
      .map((ev) => (ev as { channel: string }).channel);
    expect(channels).toEqual(["content", "reasoning"]);
  });

  it("tool_start emits both tool.intent and tool.dispatched with matching callId", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: '{"cmd":"ls"}' }),
      ctx,
    );
    const intent = out.find((ev) => ev.type === "tool.intent") as
      | { callId: string; name: string; args: string }
      | undefined;
    const dispatched = out.find((ev) => ev.type === "tool.dispatched") as
      | { callId: string }
      | undefined;
    expect(intent?.name).toBe("shell");
    expect(intent?.args).toBe('{"cmd":"ls"}');
    expect(dispatched?.callId).toBe(intent?.callId);
  });

  it("tool result correlates back to the matching dispatched callId", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const startOut = e.consume(
      lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }),
      ctx,
    );
    const startedCallId = (startOut.find((ev) => ev.type === "tool.intent") as { callId: string })
      .callId;
    const resultOut = e.consume(
      lev({ turn: 1, role: "tool", content: "ok\n", toolName: "shell" }),
      ctx,
    );
    const result = resultOut.find((ev) => ev.type === "tool.result") as
      | { callId: string; ok: boolean; output: string }
      | undefined;
    expect(result?.callId).toBe(startedCallId);
    expect(result?.ok).toBe(true);
    expect(result?.output).toBe("ok\n");
  });

  it("classifies error-shaped tool results as ok=false", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    e.consume(lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "tool", content: "ERROR: bad command", toolName: "shell" }),
      ctx,
    );
    const result = out.find((ev) => ev.type === "tool.result") as { ok: boolean } | undefined;
    expect(result?.ok).toBe(false);
  });

  it("done and tool_call_delta produce no kernel events (control / progress markers)", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const doneOut = e.consume(lev({ turn: 1, role: "done", content: "" }), ctx);
    const tcdOut = e.consume(
      lev({ turn: 1, role: "tool_call_delta", content: "", toolName: "shell" }),
      ctx,
    );
    expect(doneOut).toEqual([]);
    expect(tcdOut).toEqual([]);
  });

  it("warning containing escalation language maps to policy.escalated", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "warning", content: "⇧ auto-escalating to deepseek-v4-pro" }),
      ctx,
    );
    expect(out[0]?.type).toBe("policy.escalated");
  });

  it("drops low-severity warnings (chatty self-correcting messages)", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({
        turn: 1,
        role: "warning",
        severity: "low",
        content: "Caught a repeated tool call",
      }),
      ctx,
    );
    expect(out).toEqual([]);
  });

  it("emits a typed warning event (not error) for high-severity loop warnings", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({
        turn: 1,
        role: "warning",
        severity: "high",
        content: "context 76,500/100,000 (76%) — folded 30 messages → 12",
      }),
      ctx,
    );
    const warn = out.find((ev) => ev.type === "warning") as
      | { text: string; severity: string }
      | undefined;
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("high");
    expect(warn?.text).toContain("folded 30 messages");
    expect(out.find((ev) => ev.type === "error")).toBeUndefined();
  });

  it("treats unmarked warnings as high-severity (safer default for new emit sites)", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "warning", content: "some new warning without severity" }),
      ctx,
    );
    const warn = out.find((ev) => ev.type === "warning") as { severity: string } | undefined;
    expect(warn?.severity).toBe("high");
  });

  it("event ids are monotonic across consume calls", () => {
    const e = new Eventizer();
    const a = e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
    const b = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
    const ids = [...a, ...b].map((ev) => ev.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it("emitUserMessage / emitSlashInvoked produce well-formed events with monotonic ids", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const u = e.emitUserMessage(2, "hi");
    const s = e.emitSlashInvoked(2, "context", "off");
    expect(u.type).toBe("user.message");
    expect(u.text).toBe("hi");
    expect(s.type).toBe("slash.invoked");
    expect(s.name).toBe("context");
    expect(s.args).toBe("off");
    expect(s.id).toBeGreaterThan(u.id);
  });

  it("maps compaction_start / compaction_end into card lifecycle events (user /compact)", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const start = e.consume(
      lev({
        turn: 1,
        role: "compaction_start",
        compactionId: "compaction-1",
        compactionReason: "user",
        compactionKind: "fold",
        aggressive: true,
      }),
      ctx,
    );
    expect(start.length).toBe(1);
    expect(start[0]).toMatchObject({
      type: "compaction.started",
      compactionId: "compaction-1",
      reason: "user",
      kind: "fold",
      aggressive: true,
    });

    const end = e.consume(
      lev({
        turn: 1,
        role: "compaction_end",
        compactionId: "compaction-1",
        compactionReason: "user",
        compactionKind: "fold",
        folded: true,
        beforeMessages: 243,
        afterMessages: 63,
        summaryChars: 2912,
        summary: "recap text",
        // Prune + triage payloads ride the same event — the UI card meta and
        // the "Files in context" panel depend on them arriving.
        prunedFiles: 7,
        prunedTokens: 4200,
        droppedFiles: ["src/dead.ts", "src/old.ts"],
        // The post-fold log snapshot — the fold replaced the live log.
        replacementMessages: [
          { role: "assistant", content: "[compaction summary] recap text" },
          { role: "user", content: "keep me" },
        ],
      }),
      ctx,
    );
    expect(end.length).toBe(2);
    expect(end[0]).toMatchObject({
      type: "compaction.finished",
      compactionId: "compaction-1",
      kind: "fold",
      folded: true,
      beforeMessages: 243,
      afterMessages: 63,
      summaryChars: 2912,
      summary: "recap text",
      prunedFiles: 7,
      prunedTokens: 4200,
      droppedFiles: ["src/dead.ts", "src/old.ts"],
    });
    // User-triggered /compact runs idle — a folded log REPLACES the
    // conversation view, so the kernel records it for replay.
    expect(end[1]).toMatchObject({
      type: "session.compacted",
      reason: "user",
      beforeMessages: 243,
      afterMessages: 63,
    });
    expect((end[1] as { replacementMessages: unknown[] }).replacementMessages).toHaveLength(2);
  });

  it("auto fold never emits session.compacted — a mid-turn swap would orphan the live turn", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const end = e.consume(
      lev({
        turn: 1,
        role: "compaction_end",
        compactionId: "compaction-auto",
        compactionReason: "auto-context-pressure",
        compactionKind: "fold",
        folded: true,
        beforeMessages: 243,
        afterMessages: 63,
        summaryChars: 2912,
        summary: "recap text",
        replacementMessages: [
          { role: "assistant", content: "[compaction summary] recap text" },
          { role: "user", content: "keep me" },
        ],
      }),
      ctx,
    );
    // Card lifecycle only — the replacement is applied on the next session
    // load, never while the loop is mid-turn.
    expect(end.length).toBe(1);
    expect(end[0]).toMatchObject({ type: "compaction.finished", folded: true });
    expect(end.find((x) => x.type === "session.compacted")).toBeUndefined();
  });

  it("auto fold opening a new turn still synthesizes model.turn.started", () => {
    const e = new Eventizer();
    // Turn-start fold of turn 2 (previous turn 1 was consumed) — the gate must
    // NOT suppress the turn-started card for auto folds on a fresh turn.
    e.consume(lev({ turn: 1, role: "assistant_final", content: "done" }), ctx);
    const out = e.consume(
      lev({
        turn: 2,
        role: "compaction_start",
        compactionId: "compaction-2",
        compactionReason: "auto-context-pressure",
      }),
      ctx,
    );
    expect(out.map((k) => k.type)).toEqual(["model.turn.started", "compaction.started"]);
  });

  it("user-triggered /compact never synthesizes model.turn.started (fresh load shape)", () => {
    // Fresh eventizer = "session just loaded, user hits /compact": lastTurn is
    // -1 and the compaction's turn is the resumed conversation's — a phantom
    // model.turn.started would leave a pending assistant card that never settles.
    const e = new Eventizer();
    const start = e.consume(
      lev({
        turn: 5,
        role: "compaction_start",
        compactionId: "compaction-u1",
        compactionReason: "user",
        compactionKind: "fold",
      }),
      ctx,
    );
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({
      type: "compaction.started",
      compactionId: "compaction-u1",
      reason: "user",
      kind: "fold",
    });
    const end = e.consume(
      lev({
        turn: 5,
        role: "compaction_end",
        compactionId: "compaction-u1",
        compactionKind: "fold",
        folded: false,
        beforeMessages: 12,
        afterMessages: 12,
        summaryChars: 0,
      }),
      ctx,
    );
    expect(end.length).toBe(1);
    expect(end[0]).toMatchObject({
      type: "compaction.finished",
      compactionId: "compaction-u1",
      folded: false,
      beforeMessages: 12,
      afterMessages: 12,
    });
  });

  it("force-summary compaction_end maps kind and never emits session.compacted", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const out = e.consume(
      lev({
        turn: 1,
        role: "compaction_end",
        compactionId: "compaction-f1",
        compactionKind: "force-summary",
        folded: false,
        beforeMessages: 14,
        afterMessages: 14,
        summaryChars: 1200,
      }),
      ctx,
    );
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      type: "compaction.finished",
      compactionId: "compaction-f1",
      kind: "force-summary",
      folded: false,
      summaryChars: 1200,
    });
  });

  it("emitAbortedFinal settles a pending assistant card with zero usage", () => {
    // Desktop runTurn closes the turn generator mid-await on abort (the
    // fold is non-interruptible), so the loop's own assistant_final never
    // arrives — this synthetic final is what flips the card to settled.
    const e = new Eventizer();
    const ev = e.emitAbortedFinal(3);
    expect(ev).toMatchObject({
      type: "model.final",
      turn: 3,
      content: "[aborted by user — no response produced.]",
      toolCalls: [],
      usage: {},
      costUsd: 0,
    });
    expect(ev.id).toBeGreaterThan(0);
    expect(ev.ts).toBeTruthy();
  });

  it("maps session_retracted into a kernel session.retracted with the truncated log", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const out = e.consume(
      lev({
        turn: 1,
        role: "session_retracted",
        sessionRetractedKind: "abort-discard",
        beforeMessages: 9,
        afterMessages: 2,
        replacementMessages: [
          { role: "user", content: "kept" },
          { role: "assistant", content: "kept too" },
        ],
      }),
      ctx,
    );
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      type: "session.retracted",
      kind: "abort-discard",
      beforeMessages: 9,
      afterMessages: 2,
    });
    expect((out[0] as { replacementMessages: unknown[] }).replacementMessages).toHaveLength(2);
    // Same turn — no phantom turn.started for the mid-turn truncation.
    expect(out.find((x) => x.type === "model.turn.started")).toBeUndefined();
  });

  it("emitSessionRetracted records retry/rewind truncations outside the turn stream", () => {
    const e = new Eventizer();
    const ev = e.emitSessionRetracted(4, "retry", 7, 2, [{ role: "user", content: "kept" }]);
    expect(ev).toMatchObject({
      type: "session.retracted",
      turn: 4,
      kind: "retry",
      beforeMessages: 7,
      afterMessages: 2,
    });
    expect(ev.id).toBeGreaterThan(0);
    expect(ev.ts).toBeTruthy();
  });
});
