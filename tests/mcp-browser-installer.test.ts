import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supervisePlaywrightInstaller } from "../src/mcp/browser-installer.js";

class FakeChild extends EventEmitter {
  pid = 12345;
  kill = vi.fn(() => true);
}

function childProcess(fake: FakeChild): ChildProcess {
  return fake as unknown as ChildProcess;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("supervisePlaywrightInstaller", () => {
  it("returns the child exit code when installation completes", async () => {
    const child = new FakeChild();
    const supervisor = supervisePlaywrightInstaller(childProcess(child));
    child.emit("close", 0);
    await expect(supervisor.result).resolves.toEqual({ code: 0 });
  });

  it("settles and terminates a source attempt at its hard deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = supervisePlaywrightInstaller(childProcess(child), {
      attemptTimeoutMs: 100,
      terminateChild: () => child.kill("SIGKILL"),
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(supervisor.result).resolves.toMatchObject({
      code: null,
      error: expect.stringContaining("source deadline"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("settles a child that hangs after reporting 100 percent", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = supervisePlaywrightInstaller(childProcess(child), {
      attemptTimeoutMs: 1_000,
      finalizeTimeoutMs: 100,
      terminateChild: () => child.kill("SIGKILL"),
    });
    supervisor.markDownloadComplete();
    await vi.advanceTimersByTimeAsync(100);
    await expect(supervisor.result).resolves.toMatchObject({
      code: null,
      error: expect.stringContaining("after download reached 100%"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("cancels immediately without waiting for the close event", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const supervisor = supervisePlaywrightInstaller(childProcess(child), {
      signal: controller.signal,
      terminateChild: () => child.kill("SIGKILL"),
    });
    controller.abort();
    await expect(supervisor.result).resolves.toEqual({
      code: null,
      error: "installation cancelled",
      cancelled: true,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
