import { describe, expect, it, vi } from "vitest";
import { PauseGate } from "../src/core/pause-gate.js";
import { YOLO_PLAN_COUNTDOWN_MS, autoResolveVerdict } from "../src/core/pause-policy.js";

// Mirrors the yolo listener body in src/cli/commands/desktop.ts (the desktop
// backend's pause-gate bridge — the TUI/ACP variants were removed with them).
function makeListener(opts: { yolo?: boolean }, configEditMode: "review" | "auto" | "yolo") {
  return (gate: PauseGate, onBridge: (reqId: number) => void) => {
    gate.on((req) => {
      const editMode = opts.yolo ? "yolo" : configEditMode;
      const auto = autoResolveVerdict(req, editMode);
      if (auto?.kind === "instant") {
        gate.resolve(req.id, auto.verdict as never);
        return;
      }
      if (auto?.kind === "countdown") {
        setTimeout(() => gate.resolve(req.id, auto.verdict as never), auto.ms);
      }
      onBridge(req.id);
    });
  };
}

describe("autoResolveVerdict (yolo mode)", () => {
  it("auto-continues plan_checkpoint when opts.yolo is true even if config says review", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "review")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "plan_checkpoint",
      payload: { stepId: "s1", result: "done" },
    });

    await expect(promise).resolves.toEqual({ type: "continue" });
    expect(bridged).toBe(false);
  });

  it("bridges plan_checkpoint to the client when opts.yolo is false and config is review", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "review")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "continue" } as never);
    });

    await gate.ask({ kind: "plan_checkpoint", payload: { stepId: "s1", result: "done" } });
    expect(bridgedReqId).not.toBeNull();
  });

  it("falls back to config editMode when opts.yolo is undefined", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({}, "auto")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "plan_checkpoint",
      payload: { stepId: "s1", result: "done" },
    });
    await expect(promise).resolves.toEqual({ type: "continue" });
    expect(bridged).toBe(false);
  });

  it("auto-resolves run_command (run_once) with --yolo — shell.ts's allowAll closure can't see --yolo when config still says review (#1448)", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "review")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({ kind: "run_command", payload: { command: "rm -rf /" } });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("auto-resolves run_background (run_once) with --yolo for the same reason", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "review")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "run_background",
      payload: { command: "npm dev", cwd: "/work" },
    });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("bridges run_command to the client in auto mode (only yolo bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "auto")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "deny" } as never);
    });

    await gate.ask({ kind: "run_command", payload: { command: "ls" } });
    expect(bridgedReqId).not.toBeNull();
  });

  it("auto-allows path_access (run_once) when yolo — mirrors shell.ts allowAll bypass", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "review")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "path_access",
      payload: {
        path: "/tmp/foo",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/work",
        allowPrefix: "/tmp",
      },
    });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("bridges path_access to the client in auto mode (only yolo bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "auto")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "deny" } as never);
    });

    await gate.ask({
      kind: "path_access",
      payload: {
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/work",
        allowPrefix: "/etc",
      },
    });
    expect(bridgedReqId).not.toBeNull();
  });

  it("counts down before auto-approving plan_proposed with --yolo — the host gets a 10s window to override", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "review")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "plan_proposed",
        payload: { plan: "Step 1\nStep 2", steps: [{ id: "s1" }, { id: "s2" }], summary: "do it" },
      });

      // Not resolved instantly — the picker gets its full countdown window.
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(YOLO_PLAN_COUNTDOWN_MS - 1);
      expect(settled).toBe(false);
      expect(bridged).toBe(true);

      // First option (approve) is auto-selected when the window elapses.
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toEqual({ type: "approve" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridges plan_proposed to the client in auto mode (only yolo bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "auto")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "approve" } as never);
    });

    await gate.ask({
      kind: "plan_proposed",
      payload: { plan: "Step 1" },
    });
    expect(bridgedReqId).not.toBeNull();
  });

  it("auto-accepts plan_revision (REWRITE) after the countdown with --yolo — previously stalled forever", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "review")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "plan_revision",
        payload: { reason: "scope changed", remainingSteps: [{ id: "s2" }], summary: "rev" },
      });

      // The rewrite picker used to hang indefinitely in yolo; now the first
      // option (accept rewrite) is auto-selected once the window elapses.
      await vi.advanceTimersByTimeAsync(YOLO_PLAN_COUNTDOWN_MS);
      await expect(promise).resolves.toEqual({ type: "accepted" });
      expect(bridged).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still bridges plan_revision in review mode — the countdown is yolo-only", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "review")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "rejected" } as never);
    });

    const promise = gate.ask({
      kind: "plan_revision",
      payload: { reason: "scope changed", remainingSteps: [{ id: "s2" }] },
    });
    await expect(promise).resolves.toEqual({ type: "rejected" });
    expect(bridgedReqId).not.toBeNull();
  });

  it("waits 10 seconds before auto-picking the first ask_choice option with --yolo", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "review")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Which approach?",
          options: [
            { id: "option-1", title: "First" },
            { id: "option-2", title: "Second" },
          ],
          allowCustom: true,
        },
      });

      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(YOLO_PLAN_COUNTDOWN_MS - 1);
      expect(settled).toBe(false);
      expect(bridged).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a manual choice made during the countdown instead of overwriting it at expiry", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridgedReqId: number | null = null;
      makeListener({ yolo: true }, "review")(gate, (id) => {
        bridgedReqId = id;
      });

      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Which approach?",
          options: [
            { id: "option-1", title: "First" },
            { id: "option-2", title: "Second" },
          ],
          allowCustom: true,
        },
      });

      await vi.advanceTimersByTimeAsync(YOLO_PLAN_COUNTDOWN_MS - 1_000);
      expect(bridgedReqId).not.toBeNull();
      gate.resolve(bridgedReqId!, { type: "pick", optionId: "option-2" });
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-2" });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-2" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a malformed choice (no well-formed options) rather than hanging", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "review")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "choice",
      payload: { question: "Which approach?", options: [], allowCustom: true },
    });
    await expect(promise).resolves.toEqual({ type: "cancel" });
    expect(bridged).toBe(false);
  });

  it("bridges ask_choice to the client in auto mode (only yolo bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "auto")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "pick", optionId: "option-1" } as never);
    });

    await gate.ask({
      kind: "choice",
      payload: {
        question: "Which approach?",
        options: [{ id: "option-1", title: "First" }],
        allowCustom: true,
      },
    });
    expect(bridgedReqId).not.toBeNull();
  });
});
