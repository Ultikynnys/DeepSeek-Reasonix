import { describe, expect, it, vi } from "vitest";
import { StartupTimingTracker } from "../desktop/src/startup-timing";

describe("StartupTimingTracker", () => {
  it("tracks step deltas and cumulative time", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tracker = new StartupTimingTracker(100);

    const step1 = tracker.mark("step_1", { details: { key: "val" } });
    expect(step1.step).toBe("step_1");
    expect(step1.deltaMs).toBeGreaterThanOrEqual(0);
    expect(step1.cumulativeMs).toBeGreaterThanOrEqual(0);

    tracker.finish("all_workspaces_ready");
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("handles loading failure logging", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new StartupTimingTracker(100);

    tracker.fail("rpc_exit", { code: 1 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
